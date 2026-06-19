import { formatBytes } from "./api.js";

const slug = location.pathname.split("/file/")[1]?.replace(/\/$/, "");

const loadingEl  = document.getElementById("loading");
const errorEl    = document.getElementById("error-state");
const fileEl     = document.getElementById("file-state");
const filenameEl = document.getElementById("dl-filename");
const typeIconEl = document.getElementById("dl-type-icon");
const sizeEl     = document.getElementById("dl-size");
const typeEl     = document.getElementById("dl-type");
const usesEl     = document.getElementById("dl-uses");
const dlBtn      = document.getElementById("dl-button");
const rawUrlEl   = document.getElementById("raw-url");
const shareUrlEl = document.getElementById("share-url");
const curlEl     = document.getElementById("curl-cmd");
const previewSec = document.getElementById("preview-section");

function getFragmentKey() {
  const hash = window.location.hash;
  const match = hash.match(/[#&]ek=([^&]*)/);
  return match ? match[1] : null;
}

async function clientDecryptAndDownload(slug, fragmentKey, filename) {
  const statusEl = document.getElementById('dl-button');
  const origText = statusEl.textContent;
  statusEl.textContent = '⟳ Decrypting…';
  statusEl.style.pointerEvents = 'none';

  try {
    const resp = await fetch(`/file/${slug}/raw`);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const ciphertext = await resp.arrayBuffer();

    const pad = 4 - (fragmentKey.length % 4);
    const b64 = (fragmentKey + '===='.slice(0, pad % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const keyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const plaintext = await new Promise((resolve, reject) => {
      const worker = new Worker('/static/js/aead-worker.js');
      worker.postMessage({ type: 'decrypt', ciphertext, key: keyBytes }, [ciphertext]);
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.type === 'decrypted') resolve(e.data.plaintext);
        else reject(new Error(e.data.message));
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    });

    const blob = new Blob([plaintext]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert('Decryption failed: ' + err.message);
  } finally {
    statusEl.textContent = origText;
    statusEl.style.pointerEvents = '';
  }
}

function fileTypeIcon(ct) {
  if (!ct) return "📄";
  if (ct.startsWith("image/")) return "🖼️";
  if (ct.startsWith("video/")) return "🎬";
  if (ct.startsWith("audio/")) return "🎵";
  if (ct === "application/pdf") return "📕";
  if (ct.startsWith("text/")) return "📝";
  if (/zip|tar|gzip|7z|rar/.test(ct)) return "🗜️";
  return "📄";
}

async function load() {
  if (!slug) { showError(); return; }
  try {
    const resp = await fetch(`/file/${slug}/info`);
    if (!resp.ok) { showError(); return; }
    showFile(await resp.json());
  } catch {
    showError();
  }
}

function showError() {
  loadingEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
}

function showFile(data) {
  loadingEl.classList.add("hidden");
  fileEl.classList.remove("hidden");

  const ct = (data.content_type || "").toLowerCase();
  document.title = `${data.filename} — fileupload`;
  filenameEl.textContent  = data.filename;
  typeIconEl.textContent  = fileTypeIcon(ct);
  sizeEl.textContent      = formatBytes(data.size_bytes);
  typeEl.textContent      = ct || "unknown type";

  const rawUrl   = `${location.origin}/file/${slug}/raw`;
  const shareUrl = `${location.origin}/file/${slug}`;

  const encMode = data.encryption_mode || 'none';
  const fragmentKey = getFragmentKey();
  const urlEk = new URLSearchParams(window.location.search).get('ek');

  function wireDownloadButton() {
    if (encMode === 'client') {
      if (fragmentKey) {
        dlBtn.removeAttribute('href');
        dlBtn.addEventListener('click', (e) => {
          e.preventDefault();
          clientDecryptAndDownload(slug, fragmentKey, data.filename);
        });
      } else {
        dlBtn.removeAttribute('href');
        dlBtn.textContent = '🔑 Enter key to decrypt';
        dlBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const k = prompt('Paste the #ek= key from the share URL:');
          if (k) clientDecryptAndDownload(slug, k.trim(), data.filename);
        });
      }
    } else if (encMode === 'server') {
      dlBtn.href = rawUrl + (urlEk ? `?ek=${urlEk}` : '');
    } else {
      dlBtn.href = rawUrl;
    }
  }

  let limitedUse = false;
  if (data.max_uses != null) {
    limitedUse = true;
    const remaining = data.max_uses - data.use_count;
    usesEl.textContent = `${remaining} download${remaining !== 1 ? "s" : ""} remaining`;
    usesEl.classList.remove("hidden");
    if (remaining <= 0) {
      dlBtn.textContent = "Link exhausted";
      dlBtn.classList.replace("btn-primary", "btn-ghost");
      dlBtn.style.pointerEvents = "none";
      // Do NOT set href — link is dead
    } else {
      wireDownloadButton();
    }
  } else {
    wireDownloadButton();
  }

  rawUrlEl.textContent   = rawUrl;
  shareUrlEl.textContent = shareUrl;
  curlEl.textContent     = `curl -L -O "${rawUrl}"`;

  function wireCopy(btnId, text) {
    document.getElementById(btnId).addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(btnId);
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = orig), 1500);
      });
    });
  }
  wireCopy("copy-raw",   rawUrl);
  wireCopy("copy-share", shareUrl);

  // Skip preview for limited-use links — fetching /raw would consume a use
  if (!limitedUse) {
    const preview = buildPreview(ct, slug, data.filename);
    if (preview) previewSec.appendChild(preview);
  } else if (data.max_uses != null && (data.max_uses - data.use_count) > 0) {
    // Has uses left but still limited — skip preview, show note
    const note = document.createElement("div");
    note.className = "alert alert-info";
    note.style.marginBottom = "24px";
    note.textContent = "Preview unavailable for limited-use links — download to view.";
    previewSec.appendChild(note);
  }
}

function buildPreview(ct, slug, filename) {
  // Never render HTML or SVG inline — XSS risk
  if (ct.includes("text/html") || ct.includes("svg")) return null;

  let body = null;

  if (ct.startsWith("image/")) {
    const img = document.createElement("img");
    img.alt  = filename;
    img.src  = `/file/${slug}/raw`;
    img.style.cssText = "display:block;max-width:100%;max-height:480px;object-fit:contain;margin:0 auto;";
    let errored = false;
    img.onerror = () => { errored = true; };
    body = document.createElement("div");
    body.className = "preview-body";
    body.appendChild(img);
    // Remove whole wrap if image fails
    setTimeout(() => { if (errored && body.parentElement) body.parentElement.remove(); }, 3000);

  } else if (ct.startsWith("video/")) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload  = "metadata";
    video.style.cssText = "width:100%;max-height:480px;display:block;background:#000";
    const src = document.createElement("source");
    src.src  = `/file/${slug}/raw`;
    src.type = ct;
    video.appendChild(src);
    body = document.createElement("div");
    body.className = "preview-body";
    body.appendChild(video);

  } else if (ct.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload  = "metadata";
    audio.style.cssText = "width:100%;display:block;padding:16px";
    const src = document.createElement("source");
    src.src  = `/file/${slug}/raw`;
    src.type = ct;
    audio.appendChild(src);
    body = document.createElement("div");
    body.className = "preview-body";
    body.style.background = "var(--surface-2)";
    body.appendChild(audio);

  } else if (ct.startsWith("text/") && !ct.includes("html")) {
    const pre = document.createElement("pre");
    pre.textContent = "Loading preview…";
    body = document.createElement("div");
    body.className = "preview-body";
    body.appendChild(pre);
    fetch(`/file/${slug}/raw`)
      .then(r => { if (!r.ok) throw new Error(); return r.text(); })
      .then(text => {
        pre.textContent = text.length > 65536
          ? text.slice(0, 65536) + "\n\n[… truncated at 64 KB]"
          : text;
      })
      .catch(() => { if (body.parentElement) body.parentElement.remove(); });

  } else if (ct === "application/pdf") {
    const iframe = document.createElement("iframe");
    iframe.src     = `/file/${slug}/raw`;
    iframe.sandbox = "allow-same-origin";
    iframe.title   = filename;
    iframe.style.cssText = "width:100%;height:600px;border:none;display:block;";
    body = document.createElement("div");
    body.className = "preview-body";
    body.appendChild(iframe);

  } else {
    return null;
  }

  const wrap = document.createElement("div");
  wrap.className = "preview-wrap";

  const header = document.createElement("div");
  header.className = "preview-header";
  const lbl = document.createElement("span");
  lbl.className   = "preview-label";
  lbl.textContent = "Preview";
  const ctLbl = document.createElement("span");
  ctLbl.style.cssText = "font-size:11px;color:var(--text-muted);font-family:var(--font-mono)";
  ctLbl.textContent = ct;
  header.append(lbl, ctLbl);

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

load();
