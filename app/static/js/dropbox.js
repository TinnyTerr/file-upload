const token = location.pathname.replace(/^\/dropbox\//, "").replace(/\/$/, "");

const $ = id => document.getElementById(id);

const STATES = ["loading-state", "error-state", "upload-state", "success-state"];
function show(id) {
  STATES.forEach(s => $(s).classList.toggle("hidden", s !== id));
}

function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
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

let selectedFile = null;

async function init() {
  if (!token) { show("error-state"); return; }

  const resp = await fetch(`/dropbox/${encodeURIComponent(token)}/info`).catch(() => null);
  if (!resp || !resp.ok) {
    if (resp) {
      const d = await resp.json().catch(() => ({}));
      $("error-msg").textContent = d.detail || "This dropbox link has expired or already been used.";
    }
    show("error-state");
    return;
  }

  const info = await resp.json();
  if (info.expires_at) {
    const exp = new Date(info.expires_at);
    $("expires-meta").textContent = `Expires ${exp.toLocaleString()}`;
  }

  show("upload-state");

  const dropZone = $("drop-zone");
  const fileInput = $("file-input");

  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer.files);
    if (files.length) selectFile(files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) selectFile(fileInput.files[0]);
    fileInput.value = "";
  });
  $("clear-file").addEventListener("click", () => {
    selectedFile = null;
    $("selected-file").classList.add("hidden");
    $("send-btn").disabled = true;
  });
  $("send-btn").addEventListener("click", doUpload);
}

function selectFile(file) {
  selectedFile = file;
  $("file-icon").textContent = fileIcon(file.type);
  $("file-name").textContent = file.name;
  $("file-size").textContent = formatBytes(file.size);
  $("selected-file").classList.remove("hidden");
  $("send-btn").disabled = false;
}

async function doUpload() {
  if (!selectedFile) return;
  $("send-btn").disabled = true;
  $("upload-progress-wrap").classList.remove("hidden");
  $("upload-progress-bar").style.width = "0%";
  $("upload-progress-bar").style.background = "";
  $("upload-progress-label").textContent = "Uploading…";

  const fd = new FormData();
  fd.append("file", selectedFile, selectedFile.name);
  fd.append("original_filename", selectedFile.name);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/dropbox/${encodeURIComponent(token)}/upload`);
  xhr.upload.addEventListener("progress", e => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      $("upload-progress-bar").style.width = pct + "%";
      $("upload-progress-label").textContent = `Uploading… ${pct}%`;
    }
  });
  xhr.addEventListener("load", () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      show("success-state");
    } else {
      let msg = "Upload failed.";
      try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
      $("upload-progress-label").textContent = "Error: " + msg;
      $("upload-progress-bar").style.background = "var(--danger)";
      $("send-btn").disabled = false;
    }
  });
  xhr.addEventListener("error", () => {
    $("upload-progress-label").textContent = "Network error — please try again.";
    $("send-btn").disabled = false;
  });
  xhr.send(fd);
}

init();
