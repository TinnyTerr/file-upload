import { apiFetch, csrf, user, requireAuth, setupNav, formatBytes, formatDate, parseDuration, showToast, showConfirm, showPrompt, observeReveals, showCopyModal } from "./api.js";

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
let uploadMode = "files";

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
const dropZone     = document.getElementById("drop-zone");
const dropSub      = document.getElementById("drop-sub");

document.querySelectorAll(".mode-btn[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

function setMode(mode) {
  uploadMode = mode;
  document.querySelectorAll(".mode-btn[data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));

  const isLocal = mode === "files" || mode === "folder";
  document.getElementById("local-upload-panel").classList.toggle("hidden", !isLocal);
  document.getElementById("remote-upload-panel").classList.toggle("hidden", mode !== "remote");
  document.getElementById("receive-upload-panel").classList.toggle("hidden", mode !== "receive");

  if (isLocal) {
    fileQueue = fileQueue.filter(i => i.status === "uploading");
    renderQueue();
    fileInput.removeAttribute("multiple");
    fileInput.removeAttribute("webkitdirectory");
    if (mode === "files") {
      fileInput.setAttribute("multiple", "");
      dropSub.textContent = "Select one or many files · encrypt and set limits below";
    } else {
      fileInput.setAttribute("webkitdirectory", "");
      fileInput.setAttribute("multiple", "");
      dropSub.textContent = "Select a folder — it becomes one shared page with a download-all link";
    }
  }
  if (mode === "receive") loadActiveDropbox();
}

// ── File selection ────────────────────────────────────────────────────────
fileInput.addEventListener("change", () => {
  if (!fileInput.files.length) return;
  addToQueue(Array.from(fileInput.files));
  fileInput.value = "";
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
  // A dismissed/removed item may still have in-flight chunk requests that call
  // back here. Don't resurrect it by appending a fresh element if it's no longer
  // in the queue.
  if (!fileQueue.some(i => i.id === item.id)) return;
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
    const rm = document.createElement("button");
    rm.className = "fq-rm";
    rm.textContent = "✕";
    rm.title = "Dismiss";
    rm.addEventListener("click", () => {
      fileQueue = fileQueue.filter(i => i.id !== item.id);
      renderQueue();
    });
    row.appendChild(rm);
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

document.getElementById("remote-upload-btn")?.addEventListener("click", async () => {
  const urlEl = document.getElementById("remote-url");
  const nameEl = document.getElementById("remote-name");
  const status = document.getElementById("remote-status");
  const btn = document.getElementById("remote-upload-btn");
  const url = urlEl.value.trim();
  if (!url) {
    showToast("Paste a remote URL first.", "error");
    return;
  }
  btn.disabled = true;
  status.className = "text-sm remote-status-running";
  status.textContent = "Fetching…";
  const body = { url };
  if (nameEl.value.trim()) body.original_filename = nameEl.value.trim();
  const resp = await apiFetch("/files/remote-upload", { method: "POST", json: body });
  btn.disabled = false;
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    status.className = "text-sm remote-status-error";
    status.textContent = d.detail || "Remote upload failed.";
    return;
  }
  const result = await resp.json();
  status.className = "text-sm remote-status-done";
  status.textContent = "Stored ✓";
  setTimeout(() => { status.textContent = ""; status.className = "text-sm text-muted"; }, 3000);
  showSuccessModal(result, "none", null);
  urlEl.value = "";
  nameEl.value = "";
  loadFiles();
  loadUsage();
});

document.getElementById("receive-create-btn")?.addEventListener("click", async () => {
  const expiresRaw = document.getElementById("receive-expires").value.trim() || "1h";
  const expires = parseDuration(expiresRaw);
  if (expires === null) {
    showToast('Invalid duration — use "1h", "7d", "30m"', "error");
    return;
  }
  const btn = document.getElementById("receive-create-btn");
  btn.disabled = true;
  const resp = await apiFetch("/dropbox-links", {
    method: "POST",
    json: { expires_in_seconds: expires },
  });
  btn.disabled = false;
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || "Failed to create upload link.", "error");
    return;
  }
  loadActiveDropbox();
});

async function loadActiveDropbox() {
  const resultEl = document.getElementById("receive-result");
  const createForm = document.getElementById("receive-create-form");
  createForm.style.display = "none";
  resultEl.textContent = "";

  const loadingNote = document.createElement("div");
  loadingNote.className = "text-sm text-muted";
  loadingNote.style.marginTop = "12px";
  loadingNote.textContent = "Checking for active link…";
  resultEl.appendChild(loadingNote);

  let resp;
  try { resp = await apiFetch("/dropbox-links/active"); } catch { resp = null; }
  resultEl.textContent = "";

  if (resp && resp.ok) {
    const link = await resp.json();
    const box = document.createElement("div");
    box.className = "receive-result-box";

    const title = document.createElement("div");
    title.className = "receive-result-title";
    title.textContent = "Active dropbox link";

    const hint = document.createElement("div");
    hint.className = "receive-hint";
    const exp = link.expires_at ? `expires ${new Date(link.expires_at).toLocaleString()}` : "no expiry";
    hint.textContent = `One-use only — ${exp}.`;

    const copyRow = makeCopyRow(link.url, "Upload link");
    copyRow.style.marginTop = "10px";

    const revokeBtn = document.createElement("button");
    revokeBtn.className = "btn btn-ghost btn-sm";
    revokeBtn.style.cssText = "color:var(--danger);margin-top:10px";
    revokeBtn.textContent = "Revoke link";
    revokeBtn.addEventListener("click", async () => {
      const ok = await showConfirm({
        title: "Revoke dropbox link?",
        message: "The link will stop working immediately.",
        confirmText: "Revoke",
        danger: true,
      });
      if (!ok) return;
      const r = await apiFetch(`/dropbox-links/${link.id}`, { method: "DELETE" });
      if (r.ok || r.status === 204) {
        showToast("Link revoked.");
        loadActiveDropbox();
      } else {
        showToast("Failed to revoke.", "error");
      }
    });

    box.append(title, hint, copyRow, revokeBtn);
    resultEl.appendChild(box);
  } else {
    createForm.style.display = "";
  }
}

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
  // If the user cancels the picker the 'change' event never fires, so the hidden
  // input would linger in the DOM. Clean it up on the next window focus (which
  // fires when the file dialog closes) if 'change' didn't already remove it.
  window.addEventListener("focus", () => {
    if (input.isConnected) input.remove();
  }, { once: true });
}

function directoryShareUrl(dir, encMode, sharedKeyBytes) {
  let url = dir.url;
  if (encMode === "client" && sharedKeyBytes) url += "#ek=" + b64urlEncode(sharedKeyBytes);
  else if (encMode === "server" && dir.access_key) url += "?ek=" + encodeURIComponent(dir.access_key);
  return url;
}

function showDirectorySuccess(dir, encMode, sharedKeyBytes) {
  document.querySelector("#success-modal .modal-title").textContent = "Folder shared";
  const body = document.getElementById("success-body");
  body.textContent = "";

  const qrWrap = document.getElementById("qr-wrap");
  qrWrap.textContent = "";

  const shareUrl = directoryShareUrl(dir, encMode, sharedKeyBytes);
  const filename = dir.title || "folder";

  const qrContainer = document.createElement("div");
  qrContainer.style.cssText = "text-align:center;margin-bottom:16px";
  if (typeof QRCode !== "undefined") {
    new QRCode(qrContainer, { text: shareUrl, width: 160, height: 160, colorDark: "#e7efe9", colorLight: "#0a1416" });
  }
  body.appendChild(qrContainer);

  const nameEl = document.createElement("div");
  nameEl.style.cssText = "text-align:center;font-size:13px;font-weight:500;margin-bottom:4px;word-break:break-all";
  nameEl.textContent = filename;
  body.appendChild(nameEl);

  const lead = document.createElement("div");
  lead.style.cssText = "text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:12px";
  lead.textContent = "Anyone with this link can browse and download all files.";
  body.appendChild(lead);

  const mk = (label, text) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost btn-sm";
    b.textContent = label;
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(text).catch(() => {});
      b.textContent = "Copied!";
      b.classList.add("copied");
      setTimeout(() => { b.textContent = label; b.classList.remove("copied"); }, 1500);
    });
    return b;
  };

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:8px";
  const openBtn = document.createElement("button");
  openBtn.className = "btn btn-ghost btn-sm";
  openBtn.textContent = "Open ↗";
  openBtn.addEventListener("click", () => window.open(shareUrl, "_blank", "noopener"));
  btnRow.append(
    mk("Copy link", shareUrl),
    mk("Markdown", `[${filename}](${shareUrl})`),
    mk("HTML", `<a href="${shareUrl}">${filename}</a>`),
    openBtn,
  );
  body.appendChild(btnRow);

  if (encMode === "client" && sharedKeyBytes) {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--warning);margin-top:10px";
    hint.textContent = "⚠ End-to-end encrypted — the key (#ek=) is in this URL only. Save it; it cannot be recovered from the server.";
    body.appendChild(hint);
  } else if (encMode === "server") {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--warning);margin-top:10px";
    hint.textContent = "🔐 Server-encrypted — the access key (?ek=) in this URL is required. Share the full URL.";
    body.appendChild(hint);
  }

  const modal = document.getElementById("success-modal");
  modal.classList.remove("hidden");
  document.getElementById("success-close").onclick = () => modal.classList.add("hidden");
}

async function encryptFileClientSide(file, key = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/static/js/aead-worker.js");
    // Without this, a worker that fails to load/run (CSP, network, syntax error)
    // would leave the promise pending forever and hang the upload.
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "encryption worker error"));
    };
    const reader = new FileReader();
    reader.onerror = () => {
      worker.terminate();
      reject(new Error("could not read file for encryption"));
    };
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

function copyValue(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = orig), 1400);
  }).catch(() => {});
}

function addActionRow(parent, label, text, { filename = "file", open = false } = {}) {
  const row = document.createElement("div");
  row.className = "copy-row";
  const span = document.createElement("span");
  span.className = "copy-row-text";
  span.style.cssText = "font-size:12px;word-break:break-all";
  span.textContent = text;

  const copy = document.createElement("button");
  copy.className = "btn btn-ghost btn-sm";
  copy.textContent = label;
  copy.title = `Copy ${label.toLowerCase()}`;
  copy.addEventListener("click", () => copyValue(text, copy));
  row.append(span, copy);

  const md = document.createElement("button");
  md.className = "btn btn-ghost btn-sm";
  md.textContent = "MD";
  md.title = "Copy as Markdown link";
  md.addEventListener("click", () => copyValue(`[${filename}](${text})`, md));
  row.appendChild(md);

  const htmlBtn = document.createElement("button");
  htmlBtn.className = "btn btn-ghost btn-sm";
  htmlBtn.textContent = "HTML";
  htmlBtn.title = "Copy as HTML anchor";
  htmlBtn.addEventListener("click", () => copyValue(`<a href="${text}">${filename}</a>`, htmlBtn));
  row.appendChild(htmlBtn);

  if (open) {
    const openBtn = document.createElement("button");
    openBtn.className = "btn btn-ghost btn-sm";
    openBtn.textContent = "Open";
    openBtn.title = "Open in a new tab";
    openBtn.addEventListener("click", () => window.open(text, "_blank", "noopener"));
    row.appendChild(openBtn);
  }
  parent.appendChild(row);
}

function showGeneratedLinkModal(title, url, { subtitle = "", filename = "link" } = {}) {
  const body = document.getElementById("success-body");
  body.textContent = "";
  document.querySelector("#success-modal .modal-title").textContent = title;
  if (subtitle) {
    const lead = document.createElement("div");
    lead.className = "dialog-msg";
    lead.style.marginBottom = "12px";
    lead.textContent = subtitle;
    body.appendChild(lead);
  }
  addActionRow(body, "Copy", url, { filename, open: true });
  const qrWrap = document.getElementById("qr-wrap");
  qrWrap.textContent = "";
  if (typeof QRCode !== "undefined") {
    new QRCode(qrWrap, { text: url, width: 120, height: 120, colorDark: "#e2e8f0", colorLight: "#1a1f2e" });
  }
  document.getElementById("success-modal").classList.remove("hidden");
  document.getElementById("success-close").onclick = () => {
    document.getElementById("success-modal").classList.add("hidden");
  };
}

function showSuccessModal(data, encMode, clientKeyBytes) {
  document.querySelector("#success-modal .modal-title").textContent = "Upload complete";
  const body = document.getElementById("success-body");
  body.textContent = "";

  const qrWrap = document.getElementById("qr-wrap");
  qrWrap.textContent = "";

  const shareUrl = fullShareUrl(data, encMode, clientKeyBytes);
  const filename = data.original_filename || "file";
  const keyOnly = encMode === "client" && clientKeyBytes
    ? b64urlEncode(clientKeyBytes)
    : encMode === "server" && data.access_key ? data.access_key : "";

  // QR centered
  const qrContainer = document.createElement("div");
  qrContainer.style.cssText = "text-align:center;margin-bottom:16px";
  if (typeof QRCode !== "undefined") {
    new QRCode(qrContainer, { text: shareUrl, width: 160, height: 160, colorDark: "#e2e8f0", colorLight: "#1a1f2e" });
  }
  body.appendChild(qrContainer);

  const nameEl = document.createElement("div");
  nameEl.style.cssText = "text-align:center;font-size:13px;font-weight:500;margin-bottom:12px;word-break:break-all";
  nameEl.textContent = filename;
  body.appendChild(nameEl);

  const mk = (label, text) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost btn-sm";
    b.textContent = label;
    b.addEventListener("click", () => copyValue(text, b));
    return b;
  };

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-bottom:8px";
  const openBtn = document.createElement("button");
  openBtn.className = "btn btn-ghost btn-sm";
  openBtn.textContent = "Open ↗";
  openBtn.addEventListener("click", () => window.open(shareUrl, "_blank", "noopener"));
  btnRow.append(
    mk("Copy link", shareUrl),
    mk("Markdown", `[${filename}](${shareUrl})`),
    mk("HTML", `<a href="${shareUrl}">${filename}</a>`),
    openBtn,
  );
  body.appendChild(btnRow);

  if (keyOnly) {
    const sep = document.createElement("div");
    sep.style.cssText = "border-top:1px solid var(--border);margin:14px 0 12px";
    body.appendChild(sep);

    const kLabel = document.createElement("div");
    kLabel.className = "text-xs text-muted";
    kLabel.style.marginBottom = "4px";
    kLabel.textContent = encMode === "server" ? "Access key (?ek=)" : "Decryption key (#ek=)";
    body.appendChild(kLabel);

    const keyBox = document.createElement("div");
    keyBox.style.cssText = "background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;font-size:12px;word-break:break-all;font-family:var(--font-mono);color:var(--text-muted);margin-bottom:8px";
    keyBox.textContent = keyOnly;
    body.appendChild(keyBox);

    body.appendChild(mk("Copy key", keyOnly));
  }

  if (encMode === "client" && clientKeyBytes) {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--warning);margin-top:10px";
    hint.textContent = "⚠ End-to-end encrypted — the key above is in this URL only. Save it; it cannot be recovered from the server.";
    body.appendChild(hint);
  } else if (encMode === "server") {
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px;color:var(--warning);margin-top:10px";
    hint.textContent = "🔐 Server-encrypted — the access key above is required to download. Share the full URL or key separately.";
    body.appendChild(hint);
  }

  document.getElementById("success-modal").classList.remove("hidden");
  document.getElementById("success-close").onclick = () => {
    document.getElementById("success-modal").classList.add("hidden");
  };
}

// Files at/above this size are uploaded in pieces. Cloudflare rejects a single
// request body over ~100 MB with a 413 before it ever reaches the origin, so we
// slice large files into sub-cap chunks and reassemble them server-side.
const CHUNK_THRESHOLD = 80 * 1024 * 1024;   // 80 MiB
const CHUNK_CONCURRENCY = 2;                // chunks in flight at once — 4 caused stalls on high-latency paths (EU→US via CF)
const CHUNK_RETRIES = 4;                    // per-chunk attempts before giving up
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;    // 5 min per attempt — fetch() has no built-in timeout
const CHUNK_RESUME_KEY = "fu.chunked.v1";   // localStorage map of resumable sessions

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

  // One field set shared by the single-shot and chunked paths.
  const fields = {
    original_filename: filename,
    randomize_filename: directoryId == null && randomize,
    encryption_mode: encMode,
    compress: !!compress,
    is_permanent: tempDays ? false : true,
  };
  if (directoryId != null) fields.directory_id = Number(directoryId);
  if (maxUsesRaw)   fields.max_uses = Number(maxUsesRaw);
  if (expiresInSec) fields.expires_in_seconds = Number(expiresInSec);
  if (tempDays)     fields.temp_days = Number(tempDays);
  if (archDays)     fields.archive_after_idle_days = Number(archDays);
  if (delDays)      fields.delete_if_idle_days = Number(delDays);

  let result = null;
  try {
    result = uploadFile.size > CHUNK_THRESHOLD
      ? await chunkedUpload(uploadFile, fields, item)
      : await singleUpload(uploadFile, fields, item);
  } catch (err) {
    item.status = "error";
    item.error = (err && err.message) ? err.message : "Upload failed.";
    refreshQueueItem(item);
    return;
  }

  item.status = "done";
  item.result = result;
  if (result) {
    // Persist the key-bearing share URL so the queue row copies the right link
    // even after the success modal is dismissed (client keys live only here).
    result._share_full = fullShareUrl(result, encMode, clientKeyBytes);
    // Directory members are presented together via the folder modal, not one
    // success popup each.
    if (directoryId == null) showSuccessModal(result, encMode, clientKeyBytes);
  }
  refreshQueueItem(item);
}

// Whole-file upload in a single multipart POST (small files).
function singleUpload(uploadFile, fields, item) {
  const fd = new FormData();
  fd.append("file", uploadFile, fields.original_filename);
  fd.append("original_filename", fields.original_filename);
  fd.append("randomize_filename", fields.randomize_filename ? "true" : "false");
  fd.append("encryption_mode", fields.encryption_mode);
  fd.append("compress", fields.compress ? "true" : "false");
  fd.append("is_permanent", fields.is_permanent ? "true" : "false");
  if (fields.directory_id != null)         fd.append("directory_id", String(fields.directory_id));
  if (fields.max_uses)                     fd.append("max_uses", String(fields.max_uses));
  if (fields.expires_in_seconds)           fd.append("expires_in_seconds", String(fields.expires_in_seconds));
  if (fields.temp_days)                    fd.append("temp_days", String(fields.temp_days));
  if (fields.archive_after_idle_days)      fd.append("archive_after_idle_days", String(fields.archive_after_idle_days));
  if (fields.delete_if_idle_days)          fd.append("delete_if_idle_days", String(fields.delete_if_idle_days));

  const token = csrf.get();
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/files/upload");
    if (token) x.setRequestHeader("X-CSRF-Token", token);
    x.upload.addEventListener("progress", e => {
      if (e.lengthComputable) {
        item.progress = Math.round((e.loaded / e.total) * 100);
        refreshQueueItem(item);
      }
    });
    x.addEventListener("load", () => {
      if (x.status >= 400) {
        let detail = "Upload failed.";
        try { detail = JSON.parse(x.responseText).detail || detail; } catch {}
        return reject(new Error(detail));
      }
      try { resolve(JSON.parse(x.responseText)); } catch { resolve(null); }
    });
    x.addEventListener("error", () => reject(new Error("Network error.")));
    x.send(fd);
  });
}

async function _uploadErr(res) {
  try { const j = await res.json(); return new Error(j.detail || ("Upload failed (" + res.status + ")")); }
  catch { return new Error("Upload failed (" + res.status + ")"); }
}

// ── Resumable session bookkeeping (localStorage) ────────────────────────────
// A file is keyed by name+size+lastModified so re-selecting the *same* file after
// a drop or page reload resumes its server-side session instead of restarting.
// NOTE: only safe for non-client-encrypted uploads — client mode mints a fresh
// random key per attempt, so its ciphertext (and thus chunk bytes) differ each run.
function _resumeKey(item, fields) {
  const f = item.file || {};
  return [fields.original_filename, f.size || 0, f.lastModified || 0, fields.encryption_mode, fields.directory_id ?? ""].join("|");
}
function _resumeStore() {
  try { return JSON.parse(localStorage.getItem(CHUNK_RESUME_KEY)) || {}; } catch { return {}; }
}
function _resumeSave(key, session) {
  try { const m = _resumeStore(); m[key] = session; localStorage.setItem(CHUNK_RESUME_KEY, JSON.stringify(m)); } catch {}
}
function _resumeDrop(key) {
  try { const m = _resumeStore(); delete m[key]; localStorage.setItem(CHUNK_RESUME_KEY, JSON.stringify(m)); } catch {}
}

const _csrfHeader = () => { const t = csrf.get(); return t ? { "X-CSRF-Token": t } : {}; };

// Run `worker(item)` over `items` with bounded concurrency; rejects on first failure.
async function _runPool(items, concurrency, worker) {
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      const it = items[cursor++];
      await worker(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

// Chunked upload: init (or resume) → upload missing slices in parallel → finalize.
async function chunkedUpload(blob, fields, item) {
  const jsonHeaders = { "Content-Type": "application/json", ..._csrfHeader() };
  const canResume = fields.encryption_mode !== "client";
  const resumeKey = _resumeKey(item, fields);

  let upload_id = null, chunk_size = 0, num_chunks = 0;
  let received = new Set();

  // Try to resume an existing session for this exact file.
  const saved = canResume ? _resumeStore()[resumeKey] : null;
  if (saved && saved.upload_id && saved.total === blob.size) {
    try {
      const st = await fetch("/files/upload/status?upload_id=" + encodeURIComponent(saved.upload_id), { headers: _csrfHeader() });
      if (st.ok) {
        const s = await st.json();
        upload_id = saved.upload_id;
        chunk_size = s.chunk_size;
        num_chunks = s.num_chunks;
        received = new Set(s.received);
      }
    } catch {}
    if (!upload_id) _resumeDrop(resumeKey);  // expired/gone server-side
  }

  // No resumable session → start fresh.
  if (!upload_id) {
    const initRes = await fetch("/files/upload/init", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ ...fields, total_size: blob.size, content_type: blob.type || "application/octet-stream" }),
    });
    if (!initRes.ok) throw await _uploadErr(initRes);
    const info = await initRes.json();
    upload_id = info.upload_id;
    chunk_size = info.chunk_size;
    num_chunks = info.num_chunks;
    received = new Set(info.received || []);
    if (canResume) _resumeSave(resumeKey, { upload_id, total: blob.size, chunk_size });
  }

  // Progress is the sum of completed-chunk bytes (chunks finish out of order).
  const chunkLen = (i) => Math.min(chunk_size, blob.size - i * chunk_size);
  let doneBytes = 0;
  received.forEach(i => { doneBytes += chunkLen(i); });
  const bumpProgress = () => { item.progress = Math.min(100, Math.round((doneBytes / blob.size) * 100)); refreshQueueItem(item); };
  bumpProgress();

  const pending = [];
  for (let i = 0; i < num_chunks; i++) if (!received.has(i)) pending.push(i);

  // Upload each missing chunk, retrying transient failures with backoff. A 4xx
  // other than 429 is treated as fatal (no point retrying a rejected chunk).
  const sendChunk = async (i) => {
    const slice = blob.slice(i * chunk_size, i * chunk_size + chunkLen(i));
    let lastErr = null;
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      try {
        const res = await fetch(
          "/files/upload/chunk?upload_id=" + encodeURIComponent(upload_id) + "&index=" + i,
          { method: "POST", headers: { "Content-Type": "application/octet-stream", ..._csrfHeader() }, body: slice, signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS) },
        );
        if (res.ok) { doneBytes += chunkLen(i); bumpProgress(); return; }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw await _uploadErr(res);
        lastErr = await _uploadErr(res);
      } catch (e) {
        lastErr = e;  // network error → retry
      }
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastErr || new Error("Chunk " + i + " failed.");
  };

  // On failure we deliberately keep the server session + localStorage entry so the
  // user can resume later; only a successful finalize (or explicit abort) clears it.
  await _runPool(pending, CHUNK_CONCURRENCY, sendChunk);

  const finRes = await fetch("/files/upload/finalize", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ upload_id }),
  });
  if (!finRes.ok) throw await _uploadErr(finRes);
  if (canResume) _resumeDrop(resumeKey);
  return await finRes.json();
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
  btn.addEventListener("click", () => copyValue(text, btn));
  const openBtn = document.createElement("button");
  openBtn.className = "btn btn-ghost btn-sm";
  openBtn.textContent = "Open";
  openBtn.title = "Open in a new tab";
  openBtn.addEventListener("click", () => window.open(text, "_blank", "noopener"));
  wrap.append(span, btn, openBtn);
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
  const isMaster = false;
  document.getElementById("files-heading").textContent = "Your files & folders";

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
    navigator.clipboard.writeText(shareUrl).catch(() => {});
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); }, 1500);
  });

  if (_canCreateDirectories) {
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-ghost btn-sm";
    addBtn.textContent = "Add files";
    addBtn.addEventListener("click", e => { e.stopPropagation(); addFilesToDirectory(d); });
    acts.appendChild(addBtn);
  }

  acts.append(openBtn, copyBtn);

  if (_canDeleteFiles) {
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.textContent = "Delete all";
    delBtn.addEventListener("click", e => { e.stopPropagation(); deleteDirectory(d.id, d.title, d.file_count); });
    acts.appendChild(delBtn);
  }
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

    row.append(name, size);
    if (_canDeleteFiles) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-danger btn-sm";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => deleteDirectoryMember(d.id, f.id, f.filename));
      row.appendChild(removeBtn);
    }
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

  if (_canRegenerateLinks) {
    const mintBtn = document.createElement("button");
    mintBtn.className = "btn btn-ghost btn-sm";
    mintBtn.textContent = "+ Link";
    mintBtn.title = "Create a new share link for this file";
    mintBtn.addEventListener("click", e => { e.stopPropagation(); openMintModal(f.id); });
    acts.appendChild(mintBtn);
  }

  if (_canDeleteFiles) {
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", e => { e.stopPropagation(); deleteFile(f.id, f.original_filename); });
    acts.appendChild(delBtn);
  }

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
    const key = f && f.encryption_mode === "server" && f.access_key ? f.access_key : "";
    showCopyModal(url, f?.original_filename || "file", {
      key,
      keyLabel: f?.encryption_mode === "server" ? "Access key (?ek=)" : "",
      keyHint: key ? "🔐 Server-encrypted — this key is required to download." : "",
      hint: f?.encryption_mode === "client"
        ? "🔒 End-to-end encrypted — key not stored server-side. Append your #ek= to this URL before sharing."
        : "",
    });
  });
  row.appendChild(copyBtn);

  const openBtn = document.createElement("button");
  openBtn.className = "btn btn-ghost btn-sm";
  openBtn.textContent = "Open";
  openBtn.title = "Open this link in a new tab";
  openBtn.addEventListener("click", () => window.open(url, "_blank", "noopener"));
  row.appendChild(openBtn);

  if (!inactive) {
    if (_canRegenerateLinks) {
      const deactBtn = document.createElement("button");
      deactBtn.className = "btn btn-ghost btn-sm";
      deactBtn.textContent = "Deactivate";
      deactBtn.addEventListener("click", async () => {
        const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: false } });
        if (resp.ok) { showToast("Link deactivated."); loadFiles(); }
        else showToast("Failed to deactivate.", "error");
      });
      row.appendChild(deactBtn);
    }
  } else {
    const badge = document.createElement("span");
    badge.className = "badge badge-gray";
    badge.textContent = !lk.active ? "inactive" : expired ? "expired" : "used up";
    row.appendChild(badge);

    if (!lk.active && !expired && !usedUp && _canRegenerateLinks) {
      const reactBtn = document.createElement("button");
      reactBtn.className = "btn btn-ghost btn-sm";
      reactBtn.textContent = "Reactivate";
      reactBtn.addEventListener("click", async () => {
        const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: true } });
        if (resp.ok) { showToast("Link reactivated."); loadFiles(); }
        else showToast("Failed to reactivate.", "error");
      });
      row.appendChild(reactBtn);
    }

  }

  if (_canDeleteLinks) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-ghost btn-sm";
    deleteBtn.style.color = "var(--danger)";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      const ok = await showConfirm({
        title: "Delete link?",
        message: "This permanently removes this share link. The file remains stored.",
        confirmText: "Delete link",
        danger: true,
      });
      if (!ok) return;
      const resp = await apiFetch(`/links/${lk.id}`, { method: "DELETE" });
      if (resp.ok) { showToast("Link deleted."); loadFiles(); }
      else showToast("Failed to delete link.", "error");
    });
    row.appendChild(deleteBtn);
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

let _canRegenerateLinks = false;
let _canUseApiKeys = false;
let _canDeleteFiles = false;
let _canDeleteLinks = false;
let _canCreateDirectories = false;

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
    _canRegenerateLinks = !!me.can_regenerate_links;
    _canUseApiKeys = !!me.can_use_api_keys;
    _canDeleteFiles = !!me.can_delete;
    _canDeleteLinks = !!me.can_delete_links;
    _canCreateDirectories = !!me.can_create_directories;
    const dirBtn = document.getElementById("create-dir-btn");
    if (dirBtn) dirBtn.style.display = _canCreateDirectories ? "" : "none";
    if (_canUseApiKeys) {
      document.getElementById("keys-section").style.display = "";
      loadUserKeys();
    }
  } catch {}
}

// ── API Keys (shown only for users with can_use_api_keys) ────────────────
async function loadUserKeys() {
  const resp = await apiFetch('/keys/');
  if (!resp.ok) { showToast('Failed to load API keys.', 'error'); return; }
  const data = await resp.json();
  const list = document.getElementById('user-keys-list');
  list.textContent = '';

  const activeKeys = data.keys.filter(k => k.active);
  if (!activeKeys.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const ico = document.createElement('div');
    ico.className = 'empty-icon';
    ico.textContent = '🔑';
    empty.append(ico, 'No API keys yet.');
    list.appendChild(empty);
    return;
  }

  for (const k of activeKeys) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'margin-bottom:8px;padding:0;overflow:hidden';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)';

    const idSpan = document.createElement('span');
    idSpan.style.cssText = 'font-family:var(--font-mono);font-weight:500';
    idSpan.textContent = `Key #${k.user_key_number ?? k.id}`;

    const ipSpan = document.createElement('span');
    ipSpan.className = 'text-xs text-muted';
    ipSpan.textContent = k.bound_ip ? `📍 ${k.bound_ip}` : 'unbound';

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-ghost btn-sm';
    resetBtn.textContent = 'Reset IP';
    resetBtn.addEventListener('click', () => userResetKeyIP(k.id));

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn btn-ghost btn-sm';
    revokeBtn.style.color = 'var(--danger)';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', () => userDeactivateKey(k.id));

    header.append(idSpan, ipSpan, spacer, resetBtn, revokeBtn);

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:8px 14px;font-size:12px;color:var(--text-muted)';
    let footerText = `Created: ${new Date(k.created_at).toLocaleString()}`;
    if (k.last_used_at) footerText += ` · Last used: ${new Date(k.last_used_at).toLocaleString()}`;
    footer.textContent = footerText;

    card.append(header, footer);
    list.appendChild(card);
  }
}

async function userCreateKey() {
  const resp = await apiFetch('/keys/', { method: 'POST', json: {} });
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}));
    showToast(d.detail || 'Failed to create key.', 'error');
    return;
  }
  const data = await resp.json();
  const modal = document.getElementById('user-new-key-modal');
  const rawKey = data.key;
  const body = document.getElementById('user-new-key-body');
  body.textContent = '';

  const warning = document.createElement('div');
  warning.className = 'text-sm mb-8';
  warning.style.color = 'var(--warning)';
  warning.textContent = '⚠ Copy this key now — it won\'t be shown again.';

  const display = document.createElement('div');
  display.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;font-family:var(--font-mono);font-size:13px;word-break:break-all;margin-bottom:8px';
  display.textContent = rawKey;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-ghost btn-sm';
  copyBtn.textContent = 'Copy key';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(rawKey).then(() => showToast('Copied!')).catch(() => {});
  });

  body.append(warning, display, copyBtn);
  modal.classList.remove('hidden');
  document.getElementById('user-new-key-close').onclick = () => {
    modal.classList.add('hidden');
    loadUserKeys();
  };
}

async function userDeactivateKey(id) {
  const ok = await showConfirm({
    title: "Revoke API key?",
    message: "Any integration using this key will immediately stop working. This cannot be undone.",
    confirmText: "Revoke key",
    danger: true,
  });
  if (!ok) return;
  const resp = await apiFetch(`/keys/${id}`, { method: 'DELETE' });
  if (resp.ok) { showToast('Key revoked.'); loadUserKeys(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || 'Failed to revoke key.', 'error'); }
}

let _userResetKeyId = null;
function userResetKeyIP(id) {
  _userResetKeyId = id;
  document.getElementById('user-reset-ip-pw').value = '';
  document.getElementById('user-reset-ip-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('user-reset-ip-pw').focus(), 50);
}

document.getElementById('user-reset-ip-cancel').addEventListener('click', () => {
  document.getElementById('user-reset-ip-modal').classList.add('hidden');
});
document.getElementById('user-reset-ip-confirm').addEventListener('click', async () => {
  const pw = document.getElementById('user-reset-ip-pw').value;
  if (!pw) return;
  const resp = await apiFetch(`/keys/${_userResetKeyId}/reset-ip`, { method: 'POST', json: { password: pw } });
  document.getElementById('user-reset-ip-modal').classList.add('hidden');
  if (resp.ok) { showToast('IP binding cleared.'); loadUserKeys(); }
  else { const d = await resp.json().catch(() => ({})); showToast(d.detail || 'Failed to reset IP.', 'error'); }
});

document.getElementById('user-create-key-btn').addEventListener('click', userCreateKey);

async function initFilesPage() {
  await checkPermissions();
  await loadUsage();
  await loadFiles();
}

initFilesPage();
