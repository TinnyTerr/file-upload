import { formatBytes, showAlert, showPrompt, showToast, observeReveals } from "./api.js";
import { buildZip } from "./zip.js";

const slug = location.pathname.split("/d/")[1]?.replace(/\/$/, "");

const loadingEl  = document.getElementById("loading");
const errorEl    = document.getElementById("error-state");
const dirEl      = document.getElementById("dir-state");
const titleEl    = document.getElementById("dir-title");
const countEl    = document.getElementById("dir-count");
const sizeEl     = document.getElementById("dir-size");
const encEl      = document.getElementById("dir-enc");
const manifestEl = document.getElementById("dir-manifest");
const bannerEl   = document.getElementById("enc-banner");
const dlAllBtn   = document.getElementById("dl-all");
const dlNote     = document.getElementById("dl-note");

// Client key lives in the fragment (#ek=), never sent to the server.
function getFragmentKey() {
  const m = window.location.hash.match(/[#&]ek=([^&]*)/);
  return m ? m[1] : null;
}
// Server access credential lives in the query string (?ek=).
function getQueryKey() {
  return new URLSearchParams(window.location.search).get("ek");
}

function decodeKeyBytes(fragmentKey) {
  const pad = 4 - (fragmentKey.length % 4);
  const b64 = (fragmentKey + "====".slice(0, pad % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function fileIcon(ct) {
  if (!ct) return "📄";
  if (ct.startsWith("image/")) return "🖼️";
  if (ct.startsWith("video/")) return "🎬";
  if (ct.startsWith("audio/")) return "🎵";
  if (ct === "application/pdf") return "📕";
  if (ct.startsWith("text/")) return "📝";
  if (/zip|tar|gzip|7z|rar/.test(ct)) return "🗜️";
  return "📄";
}

let DATA = null;
let ENC = "none";
let fragKey = null;
let queryKey = null;

async function load() {
  if (!slug) return showError();
  try {
    const resp = await fetch(`/d/${slug}/info`);
    if (!resp.ok) return showError();
    DATA = await resp.json();
    render();
  } catch {
    showError();
  }
}

function showError() {
  loadingEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
}

function render() {
  loadingEl.classList.add("hidden");
  dirEl.classList.remove("hidden");

  ENC = DATA.encryption_mode || "none";
  fragKey = getFragmentKey();
  queryKey = getQueryKey();

  document.title = `${DATA.title} — Oxymoron`;
  titleEl.textContent = DATA.title;
  countEl.textContent = `${DATA.file_count} file${DATA.file_count !== 1 ? "s" : ""}`;
  sizeEl.textContent = formatBytes(DATA.total_bytes);
  encEl.textContent = ENC === "client" ? "end-to-end encrypted"
    : ENC === "server" ? "server-encrypted" : "unencrypted";

  showBanner();
  renderManifest();
  wireDownloadAll();
  // #dir-state was display:none at load — re-observe so its reveals animate in.
  observeReveals();
}

function showBanner() {
  if (ENC === "none") return;
  const haveKey = ENC === "client" ? !!fragKey : !!queryKey;
  const banner = document.createElement("div");
  banner.className = "alert " + (haveKey ? "alert-info" : "alert-error");
  banner.style.marginBottom = "22px";
  if (ENC === "client") {
    banner.textContent = haveKey
      ? "🔒 End-to-end encrypted. The key is in this link (#ek=) — every file is decrypted in your browser; the server never sees it."
      : "🔒 End-to-end encrypted, but this link is missing its key (#ek=). You need the full link to open these files.";
  } else {
    banner.textContent = haveKey
      ? "🔐 Server-encrypted. The access key (?ek=) in this link unlocks the whole folder."
      : "🔐 Server-encrypted. This link is missing its access key (?ek=) — without it downloads are blocked.";
  }
  bannerEl.appendChild(banner);
}

function renderManifest() {
  manifestEl.textContent = "";
  if (!DATA.files.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "This folder is empty.";
    manifestEl.appendChild(e);
    return;
  }
  DATA.files.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "dir-row";

    const idx = document.createElement("span");
    idx.className = "dir-row-idx";
    idx.textContent = String(i + 1).padStart(2, "0");

    const icon = document.createElement("span");
    icon.className = "dir-row-icon";
    icon.textContent = fileIcon(f.content_type);

    const name = document.createElement("span");
    name.className = "dir-row-name";
    name.textContent = f.filename;
    name.title = f.filename;

    const size = document.createElement("span");
    size.className = "dir-row-size";
    size.textContent = formatBytes(f.size_bytes);

    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.textContent = "↓";
    btn.setAttribute("data-tooltip", "Download this file");
    btn.addEventListener("click", () => downloadOne(f, btn));

    row.append(idx, icon, name, size, btn);
    manifestEl.appendChild(row);
  });
}

// ── Decrypt a single client-encrypted file in a Web Worker ──────────────────
function clientDecrypt(ciphertext, keyBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/static/js/aead-worker.js");
    worker.onmessage = (e) => {
      if (e.data.type === "progress") { onProgress?.(e.data.percent); return; }
      worker.terminate();
      if (e.data.type === "decrypted") resolve(e.data.plaintext);
      else reject(new Error(e.data.message || "decryption failed — wrong key?"));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "worker error")); };
    worker.postMessage({ type: "decrypt", ciphertext, key: keyBytes }, [ciphertext]);
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function ensureKey() {
  if (ENC === "client" && !fragKey) {
    const k = await showPrompt({
      title: "End-to-end encrypted",
      message: "Paste the folder key — the part after #ek= in the share link.",
      placeholder: "decryption key", glyph: "🔒", confirmText: "Unlock",
    });
    if (k && k.trim()) fragKey = k.trim();
  } else if (ENC === "server" && !queryKey) {
    const k = await showPrompt({
      title: "Encrypted folder",
      message: "Paste the access key — the part after ?ek= in the share link.",
      placeholder: "access key", glyph: "🔐", confirmText: "Unlock",
    });
    if (k && k.trim()) queryKey = k.trim();
  }
  return ENC === "client" ? !!fragKey : ENC === "server" ? !!queryKey : true;
}

async function downloadOne(f, btn) {
  if (!(await ensureKey())) return;
  const orig = btn.textContent;
  if (ENC === "client") {
    btn.textContent = "…"; btn.disabled = true;
    try {
      const resp = await fetch(`/file/${f.slug}/raw`);
      if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
      const ct = await resp.arrayBuffer();
      const keyBytes = decodeKeyBytes(fragKey);
      if (keyBytes.length !== 32) throw new Error("wrong key length — check the full #ek= value");
      const pt = await clientDecrypt(ct, keyBytes);
      saveBlob(new Blob([pt]), f.filename);
    } catch (err) {
      showAlert({ title: "Couldn't open file", message: err.message, glyph: "🔒", kind: "error" });
    } finally {
      btn.textContent = orig; btn.disabled = false;
    }
  } else if (ENC === "server") {
    window.location.href = `/file/${f.slug}/raw?ek=${encodeURIComponent(queryKey)}`;
  } else {
    window.location.href = `/file/${f.slug}/raw`;
  }
}

function wireDownloadAll() {
  if (!DATA.files.length) { dlAllBtn.disabled = true; return; }

  dlAllBtn.addEventListener("click", async () => {
    if (!(await ensureKey())) return;

    // none / server modes: let the server assemble the zip in one shot.
    if (ENC !== "client") {
      const ek = ENC === "server" ? `?ek=${encodeURIComponent(queryKey)}` : "";
      window.location.href = `/d/${slug}/zip${ek}`;
      return;
    }

    // client mode: fetch every ciphertext, decrypt in-browser, zip locally.
    dlAllBtn.disabled = true;
    dlNote.classList.remove("hidden");
    let keyBytes;
    try {
      keyBytes = decodeKeyBytes(fragKey);
      if (keyBytes.length !== 32) throw new Error("wrong key length");
    } catch (err) {
      dlNote.classList.add("hidden");
      dlAllBtn.disabled = false;
      return showAlert({ title: "Bad key", message: err.message, glyph: "🔒", kind: "error" });
    }

    const entries = [];
    try {
      for (let i = 0; i < DATA.files.length; i++) {
        const f = DATA.files[i];
        dlNote.textContent = `Decrypting ${i + 1} / ${DATA.files.length} — ${f.filename}`;
        const resp = await fetch(`/file/${f.slug}/raw`);
        if (!resp.ok) throw new Error(`${f.filename}: HTTP ${resp.status}`);
        const ct = await resp.arrayBuffer();
        const pt = await clientDecrypt(ct, keyBytes);
        entries.push({ name: f.filename, data: new Uint8Array(pt) });
      }
      dlNote.textContent = "Packaging .zip…";
      const zip = buildZip(entries);
      saveBlob(zip, `${DATA.title || "bundle"}.zip`);
      dlNote.textContent = `✓ Downloaded ${entries.length} files.`;
      showToast("Bundle ready.");
    } catch (err) {
      dlNote.classList.add("hidden");
      showAlert({ title: "Bundle failed", message: err.message, glyph: "🔒", kind: "error" });
    } finally {
      dlAllBtn.disabled = false;
    }
  });
}

load();
