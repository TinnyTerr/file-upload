import { apiFetch, formatBytes, isLoggedIn, showAlert, showPrompt, showToast } from "./api.js";

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
const saveWrap   = document.getElementById("save-wrap");
const saveBtn    = document.getElementById("save-file");
const openBtn    = document.getElementById("open-link");
const hashWrap   = document.getElementById("hash-wrap");
const hashSelect = document.getElementById("hash-select");
const hashValue  = document.getElementById("hash-value");

// Client-side key lives in the URL fragment (#ek=) — never sent to the server.
function getFragmentKey() {
  const hash = window.location.hash;
  const match = hash.match(/[#&]ek=([^&]*)/);
  return match ? match[1] : null;
}

// Server-side access credential lives in the query string (?ek=) — IS sent to
// the server, which gates the download and decrypts with its own stored key.
function getQueryKey() {
  return new URLSearchParams(window.location.search).get('ek');
}

function decodeKeyBytes(fragmentKey) {
  const pad = 4 - (fragmentKey.length % 4);
  const b64 = (fragmentKey + '===='.slice(0, pad % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function clientDecryptAndDownload(slug, fragmentKey, filename) {
  const statusEl = document.getElementById('dl-button');
  const origText = statusEl.textContent;
  statusEl.textContent = '⟳ Decrypting…';
  statusEl.style.pointerEvents = 'none';

  try {
    let keyBytes;
    try {
      keyBytes = decodeKeyBytes(fragmentKey);
    } catch {
      throw new Error('the key in the URL is malformed');
    }
    if (keyBytes.length !== 32) throw new Error('wrong key length — check the full #ek= value was copied');

    const resp = await fetch(`/file/${slug}/raw`);
    if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
    const ciphertext = await resp.arrayBuffer();

    const plaintext = await new Promise((resolve, reject) => {
      const worker = new Worker('/static/js/aead-worker.js');
      worker.onmessage = (e) => {
        // The worker streams 'progress' messages before the terminal result —
        // surface them, but only settle the promise on 'decrypted' / 'error'.
        if (e.data.type === 'progress') {
          statusEl.textContent = `⟳ Decrypting… ${e.data.percent}%`;
          return;
        }
        worker.terminate();
        if (e.data.type === 'decrypted') resolve(e.data.plaintext);
        else reject(new Error(e.data.message || 'decryption failed — wrong key?'));
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'worker error')); };
      worker.postMessage({ type: 'decrypt', ciphertext, key: keyBytes }, [ciphertext]);
    });

    const blob = new Blob([plaintext]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Firefox only honors a click on an anchor that's actually in the document.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    showAlert({ title: 'Decryption failed', message: err.message, glyph: '🔒', kind: 'error' });
  } finally {
    statusEl.textContent = origText;
    statusEl.style.pointerEvents = '';
  }
}

// Tells the visitor what kind of encryption protects this file and whether the
// key needed to open it is present in the URL they followed.
function showEncryptionBanner(encMode, fragmentKey, queryKey) {
  if (encMode !== 'client' && encMode !== 'server') return;
  const banner = document.createElement('div');
  const haveKey = encMode === 'client' ? !!fragmentKey : !!queryKey;
  banner.className = 'alert ' + (haveKey ? 'alert-info' : 'alert-error');
  banner.style.marginBottom = '20px';
  if (encMode === 'client') {
    banner.textContent = haveKey
      ? '🔒 End-to-end encrypted. The key is in this link (#ek=) — your browser decrypts locally; the server never sees it.'
      : '🔒 End-to-end encrypted, but this link has no key (#ek=). You need the full link to decrypt.';
  } else {
    banner.textContent = haveKey
      ? '🔐 Server-side encrypted. The access key (?ek=) in this link unlocks the download.'
      : '🔐 Server-side encrypted. This link is missing its access key (?ek=) — without it the download is blocked.';
  }
  previewSec.before(banner);
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
  document.title = `${data.filename} — Oxymoron`;
  filenameEl.textContent  = data.filename;
  typeIconEl.textContent  = fileTypeIcon(ct);
  sizeEl.textContent      = formatBytes(data.size_bytes);
  typeEl.textContent      = ct || "unknown type";

  const rawUrl = `${location.origin}/file/${slug}/raw`;
  const baseShareUrl = `${location.origin}/file/${slug}`;

  const encMode = data.encryption_mode || 'none';
  const fragmentKey = getFragmentKey();
  const queryKey = getQueryKey();
  let shareUrl = baseShareUrl;
  if (encMode === 'server' && queryKey) shareUrl += `?ek=${encodeURIComponent(queryKey)}`;
  if (encMode === 'client' && fragmentKey) shareUrl += `#ek=${encodeURIComponent(fragmentKey)}`;
  let displayRawUrl = rawUrl;
  if (encMode === 'server' && queryKey) displayRawUrl += `?ek=${encodeURIComponent(queryKey)}`;
  // Raw bytes URL used for previews/streaming. Server-encrypted files need the
  // ?ek= credential appended; plain/none files are fetched directly.
  let rawSrc = `${location.origin}/file/${slug}/preview`;
  if (encMode === 'server' && queryKey) rawSrc = `${rawUrl}?ek=${encodeURIComponent(queryKey)}`;

  // Encrypted file whose key is NOT in the URL → we have to ask for it.
  const needsKey = (encMode === 'client' && !fragmentKey) || (encMode === 'server' && !queryKey);

  showEncryptionBanner(encMode, fragmentKey, queryKey);

  // Ask the visitor for the missing key, then proceed straight to the download.
  //  · client → decrypt locally in the browser
  //  · server → hit /raw with the ?ek= credential
  async function requestKeyAndDownload() {
    if (encMode === 'client') {
      const k = await showPrompt({
        title: 'End-to-end encrypted',
        message: 'This file is encrypted in your browser. Paste the decryption key — the part after #ek= in the share link.',
        placeholder: 'decryption key',
        glyph: '🔒',
        confirmText: 'Decrypt & download',
      });
      if (k && k.trim()) clientDecryptAndDownload(slug, k.trim(), data.filename);
    } else if (encMode === 'server') {
      const k = await showPrompt({
        title: 'Encrypted file',
        message: 'This file needs an access key to download. Paste the part after ?ek= in the share link.',
        placeholder: 'access key',
        glyph: '🔐',
        confirmText: 'Unlock & download',
      });
      if (k && k.trim()) window.location.href = `${rawUrl}?ek=${encodeURIComponent(k.trim())}`;
    }
  }

  function wireDownloadButton() {
    if (encMode === 'client' && fragmentKey) {
      // Browser decrypts; server never sees the key.
      dlBtn.removeAttribute('href');
      dlBtn.addEventListener('click', (e) => {
        e.preventDefault();
        clientDecryptAndDownload(slug, fragmentKey, data.filename);
      });
    } else if (encMode === 'server' && queryKey) {
      // Server decrypts once the ?ek= access credential is supplied.
      dlBtn.href = `${rawUrl}?ek=${encodeURIComponent(queryKey)}`;
    } else if (encMode === 'client' || encMode === 'server') {
      // Encrypted, but no key in the URL — the button asks for one.
      dlBtn.removeAttribute('href');
      dlBtn.textContent = '🔑 Enter key to download';
      dlBtn.addEventListener('click', (e) => { e.preventDefault(); requestKeyAndDownload(); });
    } else {
      // No encryption — direct link.
      dlBtn.href = rawUrl;
    }
  }

  let limitedUse = false;
  let linkDead = false;
  if (data.max_uses != null) {
    limitedUse = true;
    const remaining = data.max_uses - data.use_count;
    usesEl.textContent = `${remaining} download${remaining !== 1 ? "s" : ""} remaining`;
    usesEl.classList.remove("hidden");
    if (remaining <= 0) {
      linkDead = true;
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

  // Encrypted file with no key in the URL → ask for it immediately (once the
  // page has painted), so visitors aren't left guessing what to do.
  if (needsKey && !linkDead) {
    setTimeout(requestKeyAndDownload, 250);
  }

  rawUrlEl.textContent   = displayRawUrl;
  shareUrlEl.textContent = shareUrl;
  curlEl.textContent     = `curl -L -O "${displayRawUrl}"`;

  function wireCopy(btnId, text) {
    document.getElementById(btnId).addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(btnId);
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = orig), 1500);
      }).catch(() => {});
    });
  }
  wireCopy("copy-raw",   displayRawUrl);
  wireCopy("copy-share", shareUrl);
  wireCopy("copy-share-md", `[${data.filename}](${shareUrl})`);
  wireCopy("copy-share-html", `<a href="${shareUrl}">${data.filename}</a>`);

  saveWrap.classList.remove("hidden");
  openBtn.addEventListener("click", () => window.open(shareUrl, "_blank", "noopener"));
  if (isLoggedIn()) {
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const resp = await apiFetch(`/files/${slug}/save`, { method: "POST" });
      saveBtn.disabled = false;
      if (resp.ok) {
        showToast("Saved to your files.");
      } else {
        const d = await resp.json().catch(() => ({}));
        showToast(d.detail || "Save failed.", "error");
      }
    });
  } else {
    saveBtn.style.display = "none";
  }

  renderHashes(data.hashes || {});

  // Previews fetch /raw directly, so they only work on un-encrypted bytes the
  // browser can render. Client-encrypted files would render ciphertext; server-
  // encrypted files need the ?ek= credential. Skip preview when we can't render.
  const previewable = encMode === 'none';

  // Skip preview for limited-use links — fetching /raw would consume a use
  if (!limitedUse && previewable) {
    const preview = buildPreview(ct, rawSrc, data.filename);
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

function renderHashes(hashes) {
  const entries = Object.entries(hashes).filter(([, value]) => value);
  if (!entries.length) return;
  hashWrap.style.display = "";
  hashSelect.textContent = "";
  for (const [name, value] of entries) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name.toUpperCase();
    opt.dataset.value = value;
    hashSelect.appendChild(opt);
  }
  function update() {
    hashValue.textContent = hashes[hashSelect.value] || "";
  }
  hashSelect.addEventListener("change", update);
  update();
}

function buildPreview(ct, rawSrc, filename) {
  // Never render HTML or SVG inline — XSS risk
  if (ct.includes("text/html") || ct.includes("svg")) return null;

  let body = null;

  if (ct.startsWith("image/")) {
    const img = document.createElement("img");
    img.alt  = filename;
    img.src  = rawSrc;
    img.style.cssText = "display:block;max-width:100%;max-height:480px;object-fit:contain;margin:0 auto;";
    body = document.createElement("div");
    body.className = "preview-body";
    body.appendChild(img);
    // Remove the whole preview wrap whenever the image fails — handled directly in
    // onerror (no fixed timeout, which missed failures on slow connections).
    img.onerror = () => { if (body.parentElement) body.parentElement.remove(); };

  } else if (ct.startsWith("video/")) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload  = "metadata";
    video.style.cssText = "width:100%;max-height:480px;display:block;background:#000";
    const src = document.createElement("source");
    src.src  = rawSrc;
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
    src.src  = rawSrc;
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
    fetch(rawSrc)
      .then(r => { if (!r.ok) throw new Error(); return r.text(); })
      .then(text => {
        pre.textContent = text.length > 65536
          ? text.slice(0, 65536) + "\n\n[… truncated at 64 KB]"
          : text;
      })
      .catch(() => { if (body.parentElement) body.parentElement.remove(); });

  } else if (ct === "application/pdf") {
    const iframe = document.createElement("iframe");
    iframe.src     = rawSrc;
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
