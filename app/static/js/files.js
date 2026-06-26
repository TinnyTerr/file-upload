import { apiFetch, csrf, user, requireAuth, setupNav, formatBytes, formatDate, parseDuration, showToast, showConfirm, showPrompt, observeReveals } from "./api.js";

if (!requireAuth()) throw new Error("not authenticated");
setupNav("files");

// ── Quota bar ─────────────────────────────────────────────────────────────
async function loadUsage() {
  let resp;
  try { resp = await apiFetch("/files/usage"); } catch { return; }
  if (!resp.ok) return;
  const { used_bytes, quota_bytes } = await resp.json();
  const section = document.getElementById("quota-section");
  const fill    = document.getElementById("quota-fill");
  const label   = document.getElementById("quota-label");
  const pct = quota_bytes > 0 ? Math.min(100, (used_bytes / quota_bytes) * 100) : 0;
  label.textContent = `${formatBytes(used_bytes)} used of ${formatBytes(quota_bytes)}`;
  fill.style.width = pct.toFixed(1) + "%";
  fill.className = "quota-bar-fill" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
  section.classList.remove("hidden");
}

// ── File queue state ──────────────────────────────────────────────────────
let fileQueue  = [];
let uploadMode = "single";

function qId() { return Math.random().toString(36).slice(2, 10); }

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

// ── Mode selector ─────────────────────────────────────────────────────────
const fileInput    = document.getElementById("file-input");
const addMoreInput = document.getElementById("add-more-input");
const addMoreWrap  = document.getElementById("add-more-wrap");
const dropZone     = document.getElementById("drop-zone");
const dropSub      = document.getElementById("drop-sub");

document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

function setMode(mode) {
  uploadMode = mode;
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  fileQueue = fileQueue.filter(i => i.status === "uploading");
  renderQueue();
  fileInput.removeAttribute("multiple");
  fileInput.removeAttribute("webkitdirectory");
  addMoreInput.removeAttribute("multiple");
  addMoreInput.removeAttribute("webkitdirectory");

  if (mode === "multi") {
    fileInput.setAttribute("multiple", "");
    addMoreInput.setAttribute("multiple", "");
    dropSub.textContent = "Hold Ctrl/Cmd to select multiple · or drag & drop a batch";
    addMoreWrap.style.display = "";
  } else if (mode === "folder") {
    fileInput.setAttribute("webkitdirectory", "");
    fileInput.setAttribute("multiple", "");
    addMoreInput.setAttribute("webkitdirectory", "");
    addMoreInput.setAttribute("multiple", "");
    dropSub.textContent = "Select a folder — it becomes one shared page with a download-all link";
    addMoreWrap.style.display = "";
  } else {
    dropSub.textContent = "Any file type · any size";
    addMoreWrap.style.display = "none";
  }
}

// ── File selection ────────────────────────────────────────────────────────
fileInput.addEventListener("change", () => {
  if (!fileInput.files.length) return;
  addToQueue(Array.from(fileInput.files));
  fileInput.value = "";
});
document.getElementById("add-more-btn").addEventListener("click", () => addMoreInput.click());
addMoreInput.addEventListener("change", () => {
  if (!addMoreInput.files.length) return;
  addToQueue(Array.from(addMoreInput.files));
  addMoreInput.value = "";
});

dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer.files);
  if (files.length) addToQueue(files);
});

function addToQueue(files) {
  if (uploadMode === "single") fileQueue = fileQueue.filter(i => i.status === "uploading");
  for (const f of files) {
    fileQueue.push({ id: qId(), file: f, status: "queued", progress: 0, result: null, error: null });
  }
  renderQueue();
}

// ── Queue rendering ───────────────────────────────────────────────────────
const queueEl      = document.getElementById("file-queue");
const uploadBtn    = document.getElementById("upload-btn");
const clearAllBtn  = document.getElementById("clear-all-btn");
const countLabel   = document.getElementById("upload-count-label");
const progressWrap = document.getElementById("progress-wrap");
const progressBar  = document.getElementById("progress-bar");
const progressLbl  = document.getElementById("progress-label");

document.getElementById("clear-all-btn").addEventListener("click", () => {
  fileQueue = fileQueue.filter(i => i.status === "uploading");
  renderQueue();
});

function renderQueue() {
  const hasFiles = fileQueue.length > 0;
  queueEl.style.display = hasFiles ? "" : "none";
  clearAllBtn.style.display = hasFiles ? "" : "none";

  const queued = fileQueue.filter(i => i.status === "queued");
  uploadBtn.disabled = queued.length === 0;

  if (!hasFiles) {
    countLabel.textContent = "";
    queueEl.textContent = "";
    return;
  }

  const done  = fileQueue.filter(i => i.status === "done").length;
  const errs  = fileQueue.filter(i => i.status === "error").length;
  if (queued.length)      countLabel.textContent = `${queued.length} file${queued.length !== 1 ? "s" : ""} queued`;
  else if (done || errs)  countLabel.textContent = `${done} uploaded${errs ? `, ${errs} failed` : ""}`;
  else                    countLabel.textContent = "";

  queueEl.textContent = "";
  for (const item of fileQueue) queueEl.appendChild(buildQueueItem(item));
}

function refreshQueueItem(item) {
  const el = document.getElementById(`fq-${item.id}`);
  const newEl = buildQueueItem(item);
  if (el) el.replaceWith(newEl);
  else queueEl.appendChild(newEl);
}

function buildQueueItem(item) {
  const el = document.createElement("div");
  el.className = `file-queue-item ${item.status}`;
  el.id = `fq-${item.id}`;

  const row = document.createElement("div");
  row.className = "fq-row";

  const icon = document.createElement("span");
  icon.className = "fq-icon";
  icon.textContent = fileIcon(item.file.type);

  const name = document.createElement("span");
  name.className = "fq-name";
  const displayName = (uploadMode === "folder" && item.file.webkitRelativePath)
    ? item.file.webkitRelativePath
    : item.file.name;
  name.textContent = displayName;
  name.title = displayName;

  const size = document.createElement("span");
  size.className = "fq-size";
  size.textContent = formatBytes(item.file.size);

  row.append(icon, name, size);

  if (item.status === "uploading") {
    const pct = document.createElement("span");
    pct.className = "fq-pct";
    pct.textContent = item.progress + "%";
    row.appendChild(pct);
  } else if (item.status === "done") {
    const ok = document.createElement("span");
    ok.className = "fq-ok";
    ok.textContent = "✓ done";
    row.appendChild(ok);
  } else if (item.status === "error") {
    const err = document.createElement("span");
    err.className = "fq-err";
    err.textContent = "✕ failed";
    row.appendChild(err);
  } else {
    const rm = document.createElement("button");
    rm.className = "fq-rm";
    rm.textContent = "✕";
    rm.title = "Remove from queue";
    rm.addEventListener("click", () => {
      fileQueue = fileQueue.filter(i => i.id !== item.id);
      renderQueue();
    });
    row.appendChild(rm);
  }

  el.appendChild(row);

  if (item.status === "uploading") {
    const prog = document.createElement("div");
    prog.className = "fq-prog";
    const bar = document.createElement("div");
    bar.className = "fq-prog-bar";
    bar.style.width = item.progress + "%";
    prog.appendChild(bar);
    el.appendChild(prog);
  }

  if (item.status === "done" && item.result) {
    const links = document.createElement("div");
    links.className = "fq-links";
    links.appendChild(makeCopyRow(item.result._share_full || item.result.url, "Share"));
    el.appendChild(links);
  }

  if (item.status === "error" && item.error) {
    const msg = document.createElement("div");
    msg.className = "fq-err-msg";
    msg.textContent = item.error;
    el.appendChild(msg);
  }

  return el;
}

// ── Advanced options toggle ───────────────────────────────────────────────
const advToggle = document.getElementById("adv-toggle");
const advBody   = document.getElementById("adv-body");
advToggle.addEventListener("click", () => {
  const open = advToggle.getAttribute("aria-expanded") === "true";
  advToggle.setAttribute("aria-expanded", String(!open));
  advBody.classList.toggle("open", !open);
});

// ── Explicit folder creation ──────────────────────────────────────────────
const dirModal = document.getElementById("dir-modal");
const dirTitle = document.getElementById("dir-title");
const dirEncrypt = document.getElementById("dir-encrypt");
const dirExpires = document.getElementById("dir-expires");
const dirConfirm = document.getElementById("dir-confirm");

document.getElementById("create-dir-btn").addEventListener("click", () => {
  dirTitle.value = "";
  dirEncrypt.value = "none";
  dirExpires.value = "";
  dirModal.classList.remove("hidden");
  setTimeout(() => dirTitle.focus(), 50);
});
document.getElementById("dir-cancel").addEventListener("click", () => dirModal.classList.add("hidden"));
dirModal.addEventListener("click", e => { if (e.target === dirModal) dirModal.classList.add("hidden"); });

dirConfirm.addEventListener("click", async () => {
  const title = dirTitle.value.trim() || "Shared folder";
  const encMode = dirEncrypt.value;
  const expiresRaw = dirExpires.value.trim();
  const expiresInSec = expiresRaw ? parseDuration(expiresRaw) : null;
  if (expiresRaw && expiresInSec === null) {
    showToast('Invalid duration — use "7d", "24h", "30m"', "error");
    return;
  }

  const body = { title, encryption_mode: encMode };
  if (expiresInSec) body.expires_in_seconds = expiresInSec;
  const clientKey = encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;

  dirConfirm.disabled = true;
  const resp = await apiFetch("/directories", { method: "POST", json: body });
  dirConfirm.disabled = false;
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Folder creation failed.", "error");
    return;
  }

  const dir = await resp.json();
  dirModal.classList.add("hidden");
  showDirectorySuccess(dir, encMode, clientKey);
  loadFiles();
});

// ── Upload ────────────────────────────────────────────────────────────────
uploadBtn.addEventListener("click", startUpload);

async function startUpload() {
  const maxUsesRaw   = document.getElementById("max-uses").value.trim();
  const expiresRaw   = document.getElementById("expires-in").value.trim();
  const randomize    = document.getElementById("opt-randomize").checked;
  const expiresInSec = expiresRaw ? parseDuration(expiresRaw) : null;
  const encMode      = document.getElementById("opt-encrypt").value;
  const compress     = document.getElementById("opt-compress").checked;
  const tempDays     = document.getElementById("opt-temp-days").value.trim();
  const archDays     = document.getElementById("opt-archive-days").value.trim();
  const delDays      = document.getElementById("opt-delete-days").value.trim();

  if (expiresRaw && expiresInSec === null) {
    showToast('Invalid duration — use "7d", "24h", "30m"', "error");
    return;
  }

  const pending = fileQueue.filter(i => i.status === "queued");
  if (!pending.length) return;

  const opts = { maxUsesRaw, expiresInSec, randomize, encMode, compress, tempDays, archDays, delDays };

  // Folder mode → bundle everything into one shareable directory.
  if (uploadMode === "folder") {
    await uploadAsDirectory(pending, opts);
    return;
  }

  uploadBtn.disabled = true;
  clearAllBtn.style.display = "none";
  progressWrap.style.display = "";
  progressBar.style.width = "0%";
  progressLbl.textContent = `Uploading 0 / ${pending.length}…`;

  let completed = 0;
  for (const item of pending) {
    await doUpload(item, opts);
    completed++;
    progressBar.style.width = Math.round((completed / pending.length) * 100) + "%";
    progressLbl.textContent = `${completed} / ${pending.length} uploaded`;
  }

  progressWrap.style.display = "none";
  clearAllBtn.style.display = fileQueue.length ? "" : "none";
  uploadBtn.disabled = fileQueue.filter(i => i.status === "queued").length === 0;

  const doneCount = fileQueue.filter(i => i.status === "done").length;
  const errCount  = fileQueue.filter(i => i.status === "error").length;

  if (doneCount) { showToast(`${doneCount} file${doneCount !== 1 ? "s" : ""} uploaded!`); loadFiles(); loadUsage(); }
  if (errCount)  showToast(`${errCount} upload${errCount !== 1 ? "s" : ""} failed.`, "error");

  countLabel.textContent = doneCount
    ? `${doneCount} uploaded${errCount ? `, ${errCount} failed` : ""}`
    : errCount ? `${errCount} failed` : "";
}

// Folder mode: create one directory, then upload every queued file into it with
// the directory's single shared key. One link to share the whole bundle.
async function uploadAsDirectory(pending, opts) {
  let title = "Shared folder";
  const rel = pending[0]?.file.webkitRelativePath;
  if (rel && rel.includes("/")) title = rel.split("/")[0];

  uploadBtn.disabled = true;
  clearAllBtn.style.display = "none";
  progressWrap.style.display = "";
  progressBar.style.width = "0%";
  progressLbl.textContent = "Creating folder…";

  const body = { title, encryption_mode: opts.encMode };
  if (opts.expiresInSec) body.expires_in_seconds = opts.expiresInSec;

  let dir;
  try {
    const resp = await apiFetch("/directories", { method: "POST", json: body });
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.detail || "could not create folder"); }
    dir = await resp.json();
  } catch (err) {
    progressWrap.style.display = "none";
    uploadBtn.disabled = false;
    clearAllBtn.style.display = fileQueue.length ? "" : "none";
    showToast("Folder creation failed: " + err.message, "error");
    return;
  }

  // One shared key encrypts every member end-to-end (client mode only).
  const sharedKey = opts.encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;

  let completed = 0;
  for (const item of pending) {
    await doUpload(item, { ...opts, directoryId: dir.id, sharedClientKey: sharedKey });
    completed++;
    progressBar.style.width = Math.round((completed / pending.length) * 100) + "%";
    progressLbl.textContent = `${completed} / ${pending.length} uploaded`;
  }

  progressWrap.style.display = "none";
  clearAllBtn.style.display = fileQueue.length ? "" : "none";
  uploadBtn.disabled = fileQueue.filter(i => i.status === "queued").length === 0;

  const doneCount = pending.filter(i => i.status === "done").length;
  const errCount  = pending.filter(i => i.status === "error").length;
  if (doneCount) showToast(`Folder shared — ${doneCount} file${doneCount !== 1 ? "s" : ""}.`);
  if (errCount)  showToast(`${errCount} file${errCount !== 1 ? "s" : ""} failed.`, "error");

  countLabel.textContent = doneCount ? `Folder of ${doneCount} shared${errCount ? `, ${errCount} failed` : ""}` : "";
  if (doneCount) showDirectorySuccess(dir, opts.encMode, sharedKey);
  loadFiles();
  loadUsage();
}

async function addFilesToDirectory(d) {
  const sharedClientKey = await clientDirectoryKey(d);
  if (sharedClientKey === undefined) return;

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (!files.length) return;

    const items = files.map(file => ({
      id: qId(), file, status: "queued", progress: 0, result: null, error: null,
    }));
    fileQueue.push(...items);
    renderQueue();

    uploadBtn.disabled = true;
    clearAllBtn.style.display = "none";
    progressWrap.style.display = "";
    progressBar.style.width = "0%";
    progressLbl.textContent = `Adding 0 / ${items.length}…`;

    let completed = 0;
    for (const item of items) {
      await doUpload(item, {
        maxUsesRaw: "",
        expiresInSec: null,
        randomize: false,
        encMode: d.encryption_mode,
        compress: false,
        tempDays: "",
        archDays: "",
        delDays: "",
        directoryId: d.id,
        sharedClientKey,
      });
      completed++;
      progressBar.style.width = Math.round((completed / items.length) * 100) + "%";
      progressLbl.textContent = `${completed} / ${items.length} added`;
    }

    progressWrap.style.display = "none";
    clearAllBtn.style.display = fileQueue.length ? "" : "none";
    uploadBtn.disabled = fileQueue.filter(i => i.status === "queued").length === 0;

    const doneCount = items.filter(i => i.status === "done").length;
    const errCount = items.filter(i => i.status === "error").length;
    if (doneCount) showToast(`${doneCount} file${doneCount !== 1 ? "s" : ""} added.`);
    if (errCount) showToast(`${errCount} file${errCount !== 1 ? "s" : ""} failed.`, "error");
    loadFiles();
    loadUsage();
  }, { once: true });
  document.body.appendChild(input);
  input.click();
}

function directoryShareUrl(dir, encMode, sharedKeyBytes) {
  let url = dir.url;
  if (encMode === "client" && sharedKeyBytes) url += "#ek=" + b64urlEncode(sharedKeyBytes);
  else if (encMode === "server" && dir.access_key) url += "?ek=" + encodeURIComponent(dir.access_key);
  return url;
}

function showDirectorySuccess(dir, encMode, sharedKeyBytes) {
  const body = document.getElementById("success-body");
  body.textContent = "";
  document.querySelector("#success-modal .modal-title").textContent = "Folder shared";

  const shareUrl = directoryShareUrl(dir, encMode, sharedKeyBytes);

  const lead = document.createElement("div");
  lead.className = "dialog-msg";
  lead.style.marginBottom = "12px";
  lead.textContent = "Anyone with this link can browse the folder and download everything as a zip.";
  body.appendChild(lead);

  const row = document.createElement("div");
  row.className = "copy-row";
  const urlSpan = document.createElement("span");
  urlSpan.className = "copy-row-text";
  urlSpan.style.cssText = "font-size:12px;word-break:break-all";
  urlSpan.textContent = shareUrl;
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-ghost btn-sm";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl);
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); }, 1500);
  });
  row.append(urlSpan, copyBtn);
  body.appendChild(row);

  if (encMode === "client" && sharedKeyBytes) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.cssText = "color:var(--warning);margin-top:8px";
    hint.textContent = "⚠ End-to-end encrypted. The key (#ek=) is in this URL only — save it. It cannot be recovered from the server.";
    body.appendChild(hint);
  } else if (encMode === "server") {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.cssText = "color:var(--warning);margin-top:8px";
    hint.textContent = "🔐 Server-encrypted. The access key (?ek=) is required — share the full URL. You can also recover it later from your folder list.";
    body.appendChild(hint);
  }

  const qrWrap = document.getElementById("qr-wrap");
  qrWrap.textContent = "";
  if (typeof QRCode !== "undefined") {
    new QRCode(qrWrap, { text: shareUrl, width: 120, height: 120, colorDark: "#e7efe9", colorLight: "#0a1416" });
  }

  const modal = document.getElementById("success-modal");
  modal.classList.remove("hidden");
  document.getElementById("success-close").onclick = () => modal.classList.add("hidden");
}

async function encryptFileClientSide(file, key = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/static/js/aead-worker.js");
    const reader = new FileReader();
    reader.onload = (e) => {
      // A provided key (folder bundles) encrypts every member with one key; null
      // makes the worker mint a fresh per-file key.
      worker.postMessage({ type: "encrypt", plaintext: e.target.result, key }, [e.target.result]);
    };
    worker.onmessage = (e) => {
      if (e.data.type === "encrypted") {
        resolve({ ciphertext: e.data.ciphertext, keyBytes: e.data.keyBytes });
        worker.terminate();
      } else if (e.data.type === "error") {
        reject(new Error(e.data.message));
        worker.terminate();
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function b64urlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecodeBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function extractEk(value) {
  const text = (value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.hash.startsWith("#ek=")) return decodeURIComponent(url.hash.slice(4));
  } catch {}
  const match = text.match(/(?:^|[#?&])ek=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : text.replace(/^#?ek=/, "");
}

async function clientDirectoryKey(d) {
  if (d.encryption_mode !== "client") return null;
  const answer = await showPrompt({
    title: "Folder key",
    message: "Paste the original folder link or #ek value.",
    placeholder: "#ek=...",
    confirmText: "Use key",
  });
  if (answer === null) return undefined;
  try {
    const key = b64urlDecodeBytes(extractEk(answer));
    if (key.length !== 32) throw new Error("bad key length");
    return key;
  } catch {
    showToast("Invalid folder key.", "error");
    return undefined;
  }
}

// Build the complete shareable URL including the decryption/access key:
//  · client mode → #ek= fragment (never reaches the server)
//  · server mode → ?ek= query credential (the server's access gate)
function fullShareUrl(result, encMode, clientKeyBytes) {
  let url = result.url || result.share_url || "";
  if (encMode === "client" && clientKeyBytes) {
    url += "#ek=" + b64urlEncode(clientKeyBytes);
  } else if (encMode === "server" && result.access_key) {
    url += "?ek=" + encodeURIComponent(result.access_key);
  }
  return url;
}

function showSuccessModal(data, encMode, clientKeyBytes) {
  const body = document.getElementById("success-body");
  body.textContent = "";

  const shareUrl = fullShareUrl(data, encMode, clientKeyBytes);

  const row = document.createElement("div");
  row.className = "copy-row";
  const urlSpan = document.createElement("span");
  urlSpan.className = "copy-row-text";
  urlSpan.style.cssText = "font-size:12px;word-break:break-all";
  urlSpan.textContent = shareUrl;
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-ghost btn-sm";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => navigator.clipboard.writeText(shareUrl));
  row.append(urlSpan, copyBtn);
  body.appendChild(row);

  if (encMode === "client" && clientKeyBytes) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.cssText = "color:var(--warning);margin-top:8px";
    hint.textContent = "⚠ End-to-end encrypted. The key (#ek=) is in this URL only — save it. It cannot be recovered from the server.";
    body.appendChild(hint);
  } else if (encMode === "server") {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.cssText = "color:var(--warning);margin-top:8px";
    hint.textContent = "🔐 Server-side encrypted. The access key (?ek=) is required to download — share the full URL. (You can also recover it later from your Files list.)";
    body.appendChild(hint);
  }

  const qrWrap = document.getElementById("qr-wrap");
  qrWrap.textContent = "";
  if (typeof QRCode !== "undefined") {
    new QRCode(qrWrap, { text: shareUrl, width: 120, height: 120, colorDark: "#e2e8f0", colorLight: "#1a1f2e" });
  }

  document.getElementById("success-modal").classList.remove("hidden");
  document.getElementById("success-close").onclick = () => {
    document.getElementById("success-modal").classList.add("hidden");
  };
}

async function doUpload(item, { maxUsesRaw, expiresInSec, randomize, encMode = "none", compress = false, tempDays = "", archDays = "", delDays = "", directoryId = null, sharedClientKey = null }) {
  item.status = "uploading";
  item.progress = 0;
  refreshQueueItem(item);

  let filename = item.file.name;
  if (uploadMode === "folder" && item.file.webkitRelativePath) {
    filename = item.file.webkitRelativePath;
  }

  let uploadFile = item.file;
  let clientKeyBytes = null;

  if (encMode === "client") {
    try {
      const { ciphertext, keyBytes } = await encryptFileClientSide(item.file, sharedClientKey);
      uploadFile = new Blob([ciphertext], { type: "application/octet-stream" });
      clientKeyBytes = keyBytes;
    } catch (err) {
      item.status = "error";
      item.error = "Encryption failed: " + err.message;
      refreshQueueItem(item);
      return;
    }
  }

  const fd = new FormData();
  fd.append("file", uploadFile, filename);
  fd.append("original_filename", filename);
  fd.append("randomize_filename", directoryId == null && randomize ? "true" : "false");
  fd.append("encryption_mode", encMode);
  fd.append("compress", compress ? "true" : "false");
  if (directoryId != null) fd.append("directory_id", String(directoryId));
  if (maxUsesRaw)   fd.append("max_uses", maxUsesRaw);
  if (expiresInSec) fd.append("expires_in_seconds", String(expiresInSec));
  if (tempDays) {
    fd.append("is_permanent", "false");
    fd.append("temp_days", tempDays);
  } else {
    fd.append("is_permanent", "true");
  }
  if (archDays) fd.append("archive_after_idle_days", archDays);
  if (delDays)  fd.append("delete_if_idle_days", delDays);

  const token = csrf.get();
  const xhr   = await new Promise(resolve => {
    const x = new XMLHttpRequest();
    x.open("POST", "/files/upload");
    if (token) x.setRequestHeader("X-CSRF-Token", token);
    x.upload.addEventListener("progress", e => {
      if (e.lengthComputable) {
        item.progress = Math.round((e.loaded / e.total) * 100);
        refreshQueueItem(item);
      }
    });
    x.addEventListener("load",  () => resolve(x));
    x.addEventListener("error", () => resolve(x));
    x.send(fd);
  });

  if (xhr.status === 0) {
    item.status = "error"; item.error = "Network error.";
  } else if (xhr.status >= 400) {
    item.status = "error";
    try { item.error = JSON.parse(xhr.responseText).detail || "Upload failed."; } catch { item.error = "Upload failed."; }
  } else {
    item.status = "done";
    try { item.result = JSON.parse(xhr.responseText); } catch {}
    if (item.result) {
      // Persist the key-bearing share URL so the queue row copies the right link
      // even after the success modal is dismissed (client keys live only here).
      item.result._share_full = fullShareUrl(item.result, encMode, clientKeyBytes);
      // Directory members are presented together via the folder modal, not one
      // success popup each.
      if (directoryId == null) showSuccessModal(item.result, encMode, clientKeyBytes);
    }
  }
  refreshQueueItem(item);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function makeCopyRow(text, label) {
  const wrap = document.createElement("div");
  wrap.className = "copy-row";
  if (label) {
    const lbl = document.createElement("span");
    lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);min-width:48px;flex-shrink:0";
    lbl.textContent = label;
    wrap.appendChild(lbl);
  }
  const span = document.createElement("span");
  span.className = "copy-row-text";
  span.textContent = text;
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost btn-sm";
  btn.textContent = "Copy";
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = orig), 1500);
    });
  });
  wrap.append(span, btn);
  return wrap;
}

// ── Files list ────────────────────────────────────────────────────────────
const filesListEl = document.getElementById("files-list");
document.getElementById("refresh-btn").addEventListener("click", loadFiles);

async function loadFiles() {
  filesListEl.textContent = "";
  const loader = document.createElement("div");
  loader.className = "empty";
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  icon.textContent = "⟳";
  loader.append(icon, "Loading…");
  filesListEl.appendChild(loader);

  try {
    const [fResp, dResp] = await Promise.all([apiFetch("/files/"), apiFetch("/directories/")]);
    const files = fResp.ok ? (await fResp.json()).files : [];
    const dirs  = dResp.ok ? (await dResp.json()).directories : [];
    renderListing(dirs, files);
  } catch {
    filesListEl.textContent = "Network error.";
  }
}

function staggerIn(card, i) {
  card.classList.add("card-enter");
  card.style.animationDelay = Math.min(i, 10) * 45 + "ms";
}

function renderListing(dirs, files) {
  filesListEl.textContent = "";
  const u = user.get();
  const isMaster = u?.role === "master";
  if (isMaster) document.getElementById("files-heading").textContent = "All files & folders";

  if (!dirs.length && !files.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const ico = document.createElement("div");
    ico.className = "empty-icon";
    ico.textContent = "📂";
    empty.appendChild(ico);
    empty.appendChild(document.createTextNode("Nothing here yet. Upload a file or share a folder above."));
    filesListEl.appendChild(empty);
    return;
  }

  let i = 0;
  for (const d of dirs)  { const c = renderDirectoryCard(d, isMaster); staggerIn(c, i++); filesListEl.appendChild(c); }
  for (const f of files) { const c = renderFileCard(f, isMaster);      staggerIn(c, i++); filesListEl.appendChild(c); }
}

function renderDirectoryCard(d, isMaster) {
  const card = document.createElement("div");
  card.className = "file-card";

  const header = document.createElement("div");
  header.className = "file-card-header";
  header.style.cursor = "default";

  const ico = document.createElement("span");
  ico.style.cssText = "font-size:18px;flex-shrink:0;opacity:0.7;";
  ico.textContent = "📁";

  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = d.title;
  name.title = d.title;

  const meta = document.createElement("div");
  meta.style.cssText = "display:flex;gap:10px;align-items:center;flex-shrink:0";

  if (isMaster) {
    const ob = document.createElement("span");
    ob.className = "badge badge-gray";
    ob.textContent = `uid:${d.owner_id}`;
    meta.appendChild(ob);
  }

  const fc = document.createElement("span");
  fc.className = "file-meta";
  fc.textContent = `${d.file_count} file${d.file_count !== 1 ? "s" : ""}`;
  meta.appendChild(fc);

  const sz = document.createElement("span");
  sz.className = "file-meta";
  sz.textContent = formatBytes(d.total_bytes);
  meta.appendChild(sz);

  if (d.encryption_mode === "client") {
    const b = document.createElement("span");
    b.className = "badge badge-orange";
    b.setAttribute("data-tooltip", "End-to-end encrypted — key lives only in the share link (#ek=)");
    b.textContent = "🔒 e2e";
    meta.appendChild(b);
  } else if (d.encryption_mode === "server") {
    const b = document.createElement("span");
    b.className = "badge badge-orange";
    b.setAttribute("data-tooltip", "Server-encrypted — one ?ek= access key unlocks the whole folder");
    b.textContent = "🔐 server";
    meta.appendChild(b);
  }

  const fb = document.createElement("span");
  fb.className = "badge badge-green";
  fb.textContent = "folder";
  meta.appendChild(fb);

  const acts = document.createElement("div");
  acts.style.cssText = "display:flex;gap:5px;flex-shrink:0";

  const shareUrl = directoryShareUrl(d, d.encryption_mode, null);

  const openBtn = document.createElement("a");
  openBtn.className = "btn btn-ghost btn-sm";
  openBtn.textContent = "Open";
  openBtn.href = shareUrl;
  openBtn.target = "_blank";
  openBtn.rel = "noopener";
  openBtn.setAttribute("data-tooltip", "Open the shared folder page");

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-ghost btn-sm";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", e => {
    e.stopPropagation();
    navigator.clipboard.writeText(shareUrl);
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); }, 1500);
  });

  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-ghost btn-sm";
  addBtn.textContent = "Add files";
  addBtn.addEventListener("click", e => { e.stopPropagation(); addFilesToDirectory(d); });

  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-danger btn-sm";
  delBtn.textContent = "Delete all";
  delBtn.addEventListener("click", e => { e.stopPropagation(); deleteDirectory(d.id, d.title, d.file_count); });

  acts.append(addBtn, openBtn, copyBtn, delBtn);
  header.append(ico, name, meta, acts);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "file-body";
  if (d.encryption_mode === "client") {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:8px";
    hint.textContent = "End-to-end encrypted. Keep the #ek= key from the share link; adding files later needs it.";
    body.appendChild(hint);
  }
  loadDirectoryMembers(d, body);
  card.appendChild(body);

  return card;
}

async function loadDirectoryMembers(d, body) {
  const holder = document.createElement("div");
  holder.style.cssText = "display:flex;flex-direction:column;gap:6px";
  holder.textContent = "Loading files…";
  body.appendChild(holder);

  const resp = await apiFetch(`/directories/${d.id}/files`);
  if (!resp.ok) {
    holder.textContent = "Could not load folder files.";
    return;
  }
  const { files } = await resp.json();
  holder.textContent = "";
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "text-xs text-muted";
    empty.textContent = "Empty folder.";
    holder.appendChild(empty);
    return;
  }

  for (const f of files) {
    const row = document.createElement("div");
    row.className = "link-row";

    const name = document.createElement("span");
    name.className = "link-url";
    name.textContent = f.filename;
    name.title = f.filename;

    const size = document.createElement("span");
    size.className = "file-meta";
    size.textContent = formatBytes(f.size_bytes);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-danger btn-sm";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => deleteDirectoryMember(d.id, f.id, f.filename));

    row.append(name, size, removeBtn);
    holder.appendChild(row);
  }
}

async function deleteDirectory(id, title, count) {
  const ok = await showConfirm({
    title: "Delete folder?",
    message: `"${title}" and all ${count} file${count !== 1 ? "s" : ""} inside will be permanently removed. This cannot be undone.`,
    confirmText: "Delete folder",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/directories/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("Folder deleted."); loadFiles(); loadUsage(); }
  else {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Delete failed.", "error");
  }
}

async function deleteDirectoryMember(dirId, fileId, name) {
  const ok = await showConfirm({
    title: "Remove file?",
    message: `"${name}" will be removed from this folder and its links will be deleted.`,
    confirmText: "Remove file",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/directories/${dirId}/files/${fileId}`, { method: "DELETE" });
  if (resp.ok) {
    showToast("File removed.");
    loadFiles();
    loadUsage();
  } else {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Remove failed.", "error");
  }
}

function renderFileCard(f, isMaster) {
  const card = document.createElement("div");
  card.className = "file-card";

  const header = document.createElement("div");
  header.className = "file-card-header";

  const ico = document.createElement("span");
  ico.style.cssText = "font-size:18px;flex-shrink:0;opacity:0.55;";
  ico.textContent = fileIcon(f.content_type);

  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = f.original_filename;
  name.title = f.original_filename;

  const meta = document.createElement("div");
  meta.style.cssText = "display:flex;gap:10px;align-items:center;flex-shrink:0";

  if (isMaster) {
    const ob = document.createElement("span");
    ob.className = "badge badge-gray";
    ob.textContent = `uid:${f.owner_id}`;
    meta.appendChild(ob);
  }

  const sz = document.createElement("span");
  sz.className = "file-meta";
  sz.textContent = formatBytes(f.size_bytes);
  meta.appendChild(sz);

  const dt = document.createElement("span");
  dt.className = "file-meta";
  dt.textContent = formatDate(f.created_at);
  meta.appendChild(dt);

  const encB = encBadge(f);
  if (encB) meta.appendChild(encB);

  if (f.compressed) {
    const cb = document.createElement("span");
    cb.className = "badge badge-gray";
    cb.title = "Stored compressed (zstd)";
    cb.textContent = "zst";
    meta.appendChild(cb);
  }

  const activeLinks = f.links.filter(l => l.active).length;
  const lb = document.createElement("span");
  lb.className = activeLinks > 0 ? "badge badge-green" : "badge badge-gray";
  lb.textContent = `${f.links.length} link${f.links.length !== 1 ? "s" : ""}`;
  meta.appendChild(lb);

  const acts = document.createElement("div");
  acts.style.cssText = "display:flex;gap:5px;flex-shrink:0";

  const mintBtn = document.createElement("button");
  mintBtn.className = "btn btn-ghost btn-sm";
  mintBtn.textContent = "+ Link";
  mintBtn.title = "Create a new share link for this file";
  mintBtn.addEventListener("click", e => { e.stopPropagation(); openMintModal(f.id); });

  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-danger btn-sm";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", e => { e.stopPropagation(); deleteFile(f.id, f.original_filename); });

  acts.append(mintBtn, delBtn);
  header.append(ico, name, meta, acts);
  card.appendChild(header);

  if (f.links.length) {
    const body = document.createElement("div");
    body.className = "file-body";
    for (const lk of f.links) body.appendChild(renderLinkRow(lk, f));
    card.appendChild(body);
  }

  return card;
}

// Encryption badge for a file row, or null for unencrypted files.
function encBadge(f) {
  if (f.encryption_mode === "client") {
    const b = document.createElement("span");
    b.className = "badge badge-orange";
    b.title = "End-to-end encrypted — key lives only in the share link (#ek=)";
    b.textContent = "🔒 e2e";
    return b;
  }
  if (f.encryption_mode === "server") {
    const b = document.createElement("span");
    b.className = "badge badge-orange";
    b.title = "Server-side encrypted — needs the ?ek= access key to download";
    b.textContent = "🔐 server";
    return b;
  }
  return null;
}

// Full share URL for a link row. Server-mode keys are recoverable and appended
// as ?ek=; client-mode keys are not recoverable from the server, so the base URL
// is returned (the uploader must use the link captured at upload time).
function linkUrlWithKey(slug, f) {
  const base = `${location.origin}/file/${slug}`;
  if (f && f.encryption_mode === "server" && f.access_key) {
    return base + "?ek=" + encodeURIComponent(f.access_key);
  }
  return base;
}

function renderLinkRow(lk, f) {
  const now     = Date.now();
  const expired = lk.expires_at && new Date(lk.expires_at).getTime() < now;
  const usedUp  = lk.max_uses != null && lk.use_count >= lk.max_uses;
  const inactive = !lk.active || expired || usedUp;

  const row = document.createElement("div");
  row.className = "link-row" + (inactive ? " link-inactive" : "");

  const dot = document.createElement("span");
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${inactive ? "var(--text-muted)" : "var(--success)"};flex-shrink:0;margin-top:2px`;
  row.appendChild(dot);

  const url = linkUrlWithKey(lk.slug, f);
  const urlSpan = document.createElement("span");
  urlSpan.className = "link-url";
  urlSpan.textContent = url;
  urlSpan.title = url;
  row.appendChild(urlSpan);

  if (f && f.encryption_mode === "client") {
    const warn = document.createElement("span");
    warn.className = "badge badge-orange";
    warn.title = "The #ek= key is not stored server-side — append the key you saved at upload";
    warn.textContent = "needs #ek=";
    row.appendChild(warn);
  }

  if (lk.max_uses != null) {
    const uses = document.createElement("span");
    uses.className = "link-uses";
    uses.textContent = `${lk.use_count}/${lk.max_uses} dl`;
    row.appendChild(uses);
  }

  if (lk.expires_at) {
    const exp = document.createElement("span");
    exp.className = "file-meta";
    exp.textContent = `exp ${new Date(lk.expires_at).toLocaleDateString()}`;
    row.appendChild(exp);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-ghost btn-sm";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });
  });
  row.appendChild(copyBtn);

  if (!inactive) {
    const deactBtn = document.createElement("button");
    deactBtn.className = "btn btn-ghost btn-sm";
    deactBtn.textContent = "Deactivate";
    deactBtn.addEventListener("click", async () => {
      const resp = await apiFetch(`/links/${lk.id}`, { method: "DELETE" });
      if (resp.ok) { showToast("Link deactivated."); loadFiles(); }
      else showToast("Failed to deactivate.", "error");
    });
    row.appendChild(deactBtn);
  } else {
    const badge = document.createElement("span");
    badge.className = "badge badge-gray";
    badge.textContent = !lk.active ? "inactive" : expired ? "expired" : "used up";
    row.appendChild(badge);
  }

  return row;
}

async function deleteFile(id, name) {
  const ok = await showConfirm({
    title: "Delete file?",
    message: `"${name}" and all its links will be permanently removed. This cannot be undone.`,
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/files/${id}`, { method: "DELETE" });
  if (resp.ok) { showToast("File deleted."); loadFiles(); loadUsage(); }
  else {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Delete failed.", "error");
  }
}

// ── Mint link modal ───────────────────────────────────────────────────────
const mintModal   = document.getElementById("mint-modal");
const mintCancel  = document.getElementById("mint-cancel");
const mintConfirm = document.getElementById("mint-confirm");
let mintFileId    = null;

function openMintModal(fileId) {
  mintFileId = fileId;
  document.getElementById("mint-max-uses").value = "";
  document.getElementById("mint-expires").value  = "";
  mintModal.classList.remove("hidden");
  setTimeout(() => document.getElementById("mint-max-uses").focus(), 50);
}
mintCancel.addEventListener("click", () => mintModal.classList.add("hidden"));
mintModal.addEventListener("click", e => { if (e.target === mintModal) mintModal.classList.add("hidden"); });

mintConfirm.addEventListener("click", async () => {
  const maxUsesRaw   = document.getElementById("mint-max-uses").value.trim();
  const expiresRaw   = document.getElementById("mint-expires").value.trim();
  const expiresInSec = expiresRaw ? parseDuration(expiresRaw) : null;

  if (expiresRaw && expiresInSec === null) {
    showToast('Invalid duration — use "7d", "24h"', "error");
    return;
  }

  const body = {};
  if (maxUsesRaw)   body.max_uses           = parseInt(maxUsesRaw, 10);
  if (expiresInSec) body.expires_in_seconds = expiresInSec;

  mintConfirm.disabled = true;
  const resp = await apiFetch(`/files/${mintFileId}/links`, { method: "POST", json: body });
  mintConfirm.disabled = false;
  mintModal.classList.add("hidden");
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Failed to create link.", "error");
    return;
  }
  const data = await resp.json();
  let shareUrl = data.url;
  if (data.encryption_mode === "server" && data.access_key) {
    shareUrl += "?ek=" + encodeURIComponent(data.access_key);
    showToast("New link created & copied (key included).");
  } else if (data.encryption_mode === "client") {
    showToast("New link created — append your #ek= key before sharing.");
  } else {
    showToast("New link created & copied.");
  }
  navigator.clipboard.writeText(shareUrl).catch(() => {});
  loadFiles();
});

async function checkPermissions() {
  try {
    const resp = await apiFetch("/account/me");
    if (!resp.ok) return;
    const me = await resp.json();
    if (!me.can_upload_client_encrypted) {
      const opt = document.querySelector("#opt-encrypt option[value='client']");
      if (opt) opt.remove();
      const dirOpt = document.getElementById("dir-encrypt-client");
      if (dirOpt) dirOpt.remove();
    }
  } catch {}
}

checkPermissions();
loadUsage();
loadFiles();
