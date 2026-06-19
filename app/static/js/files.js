import { apiFetch, csrf, user, requireAuth, setupNav, formatBytes, formatDate, parseDuration, showToast } from "./api.js";

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
    dropSub.textContent = "Select an entire folder — all files inside will be queued";
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
    links.appendChild(makeCopyRow(item.result.url, "Share"));
    links.appendChild(makeCopyRow(item.result.raw_url, "Direct"));
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

  uploadBtn.disabled = true;
  clearAllBtn.style.display = "none";
  progressWrap.style.display = "";
  progressBar.style.width = "0%";
  progressLbl.textContent = `Uploading 0 / ${pending.length}…`;

  let completed = 0;
  for (const item of pending) {
    await doUpload(item, { maxUsesRaw, expiresInSec, randomize, encMode, compress, tempDays, archDays, delDays });
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

async function encryptFileClientSide(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/static/js/aead-worker.js");
    const reader = new FileReader();
    reader.onload = (e) => {
      worker.postMessage({ type: "encrypt", plaintext: e.target.result, key: null }, [e.target.result]);
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

function showSuccessModal(data, encMode, clientKeyBytes) {
  const body = document.getElementById("success-body");
  body.textContent = "";

  let shareUrl = data.url || data.share_url || "";
  if (encMode === "client" && clientKeyBytes) {
    shareUrl = shareUrl + "#ek=" + b64urlEncode(clientKeyBytes);
  }

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
    hint.textContent = "⚠ The key is in the URL fragment — save it. It cannot be recovered from the server.";
    body.appendChild(hint);
  } else if (encMode === "server") {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.style.marginTop = "8px";
    hint.textContent = "The ?ek= key is embedded in the URL above.";
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

async function doUpload(item, { maxUsesRaw, expiresInSec, randomize, encMode = "none", compress = false, tempDays = "", archDays = "", delDays = "" }) {
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
      const { ciphertext, keyBytes } = await encryptFileClientSide(item.file);
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
  fd.append("randomize_filename", randomize ? "true" : "false");
  fd.append("encryption_mode", encMode);
  fd.append("compress", compress ? "true" : "false");
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
    if (item.result) showSuccessModal(item.result, encMode, clientKeyBytes);
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
    const resp = await apiFetch("/files/");
    if (!resp.ok) { filesListEl.textContent = "Failed to load files."; return; }
    renderFiles((await resp.json()).files);
  } catch {
    filesListEl.textContent = "Network error.";
  }
}

function renderFiles(files) {
  filesListEl.textContent = "";
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const ico = document.createElement("div");
    ico.className = "empty-icon";
    ico.textContent = "📂";
    empty.appendChild(ico);
    empty.appendChild(document.createTextNode("No files yet. Upload one above."));
    filesListEl.appendChild(empty);
    return;
  }
  const u = user.get();
  const isMaster = u?.role === "master";
  if (isMaster) document.getElementById("files-heading").textContent = "All files";
  for (const f of files) filesListEl.appendChild(renderFileCard(f, isMaster));
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
    for (const lk of f.links) body.appendChild(renderLinkRow(lk));
    card.appendChild(body);
  }

  return card;
}

function renderLinkRow(lk) {
  const now     = Date.now();
  const expired = lk.expires_at && new Date(lk.expires_at).getTime() < now;
  const usedUp  = lk.max_uses != null && lk.use_count >= lk.max_uses;
  const inactive = !lk.active || expired || usedUp;

  const row = document.createElement("div");
  row.className = "link-row" + (inactive ? " link-inactive" : "");

  const dot = document.createElement("span");
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${inactive ? "var(--text-muted)" : "var(--success)"};flex-shrink:0;margin-top:2px`;
  row.appendChild(dot);

  const url = `${location.origin}/file/${lk.slug}`;
  const urlSpan = document.createElement("span");
  urlSpan.className = "link-url";
  urlSpan.textContent = url;
  row.appendChild(urlSpan);

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
  if (!confirm(`Delete "${name}"?\n\nThis cannot be undone.`)) return;
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
  showToast("New link created!");
  navigator.clipboard.writeText(data.url).catch(() => {});
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
    }
  } catch {}
}

checkPermissions();
loadUsage();
loadFiles();
