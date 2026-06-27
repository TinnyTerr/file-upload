import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

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

export default function DropboxPage() {
  const { token } = useParams();

  const [view, setView] = useState("loading"); // loading | error | upload | success
  const [errorMsg, setErrorMsg] = useState("This dropbox link has expired or already been used.");
  const [expiresAt, setExpiresAt] = useState(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => { init(); }, []);

  async function init() {
    if (!token) { setView("error"); return; }
    const resp = await fetch(`/dropbox/${encodeURIComponent(token)}/info`).catch(() => null);
    if (!resp || !resp.ok) {
      if (resp) {
        const d = await resp.json().catch(() => ({}));
        setErrorMsg(d.detail || "This dropbox link has expired or already been used.");
      }
      setView("error");
      return;
    }
    const info = await resp.json();
    if (info.expires_at) setExpiresAt(new Date(info.expires_at));
    setView("upload");
  }

  function selectFile(file) {
    setSelectedFile(file);
    setUploadError("");
  }

  async function doUpload() {
    if (!selectedFile) return;
    setUploading(true);
    setProgress(0);
    setUploadError("");

    const fd = new FormData();
    fd.append("file", selectedFile, selectedFile.name);
    fd.append("original_filename", selectedFile.name);

    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/dropbox/${encodeURIComponent(token)}/upload`);
      xhr.upload.addEventListener("progress", e => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setView("success");
        } else {
          let msg = "Upload failed.";
          try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
          setUploadError(msg);
        }
        setUploading(false);
        resolve();
      });
      xhr.addEventListener("error", () => {
        setUploadError("Network error — please try again.");
        setUploading(false);
        resolve();
      });
      xhr.send(fd);
    });
  }

  if (view === "loading") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "520px", marginTop: "80px", textAlign: "center" }}>
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>⟳</div>
          <div className="text-sm text-muted">Loading…</div>
        </div>
      </div>
    );
  }

  if (view === "error") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "520px", marginTop: "80px" }}>
          <div className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>⛔</div>
            <h2 style={{ margin: "0 0 8px" }}>Link unavailable</h2>
            <p id="error-msg" className="text-sm text-muted">{errorMsg}</p>
          </div>
        </div>
      </div>
    );
  }

  if (view === "success") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "520px", marginTop: "80px" }}>
          <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>✅</div>
            <h2 style={{ margin: "0 0 8px" }}>File sent!</h2>
            <p className="text-sm text-muted">Your file has been uploaded successfully. You may close this page.</p>
          </div>
        </div>
      </div>
    );
  }

  // upload state
  return (
    <div className="page-wrap">
      <div className="container" style={{ maxWidth: "560px", marginTop: "60px" }}>
        <div className="auth-logo" style={{ textAlign: "center", marginBottom: "4px" }}>Oxymoron</div>
        <h1 className="page-title" style={{ textAlign: "center" }}>Send a file</h1>
        {expiresAt && (
          <p id="expires-meta" className="text-sm text-muted" style={{ textAlign: "center", marginBottom: "24px" }}>
            Expires {expiresAt.toLocaleString()}
          </p>
        )}

        <div
          id="drop-zone"
          className={`drop-zone${dragOver ? " drag-over" : ""}`}
          style={{ cursor: "pointer" }}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length) selectFile(files[0]);
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="drop-icon">↑</div>
          <div className="drop-label">Drop a file here or click to browse</div>
          <div className="drop-sub">One file only</div>
        </div>

        <input
          ref={fileInputRef}
          id="file-input"
          type="file"
          style={{ display: "none" }}
          onChange={() => {
            const file = fileInputRef.current?.files?.[0];
            if (file) {
              selectFile(file);
              fileInputRef.current.value = "";
            }
          }}
        />

        {selectedFile && (
          <div id="selected-file" className="card" style={{ marginTop: "16px", padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span id="file-icon" style={{ fontSize: "24px" }}>{fileIcon(selectedFile.type)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div id="file-name" style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedFile.name}
                </div>
                <div id="file-size" className="text-xs text-muted">{formatBytes(selectedFile.size)}</div>
              </div>
              <button
                id="clear-file"
                className="btn btn-ghost btn-sm"
                onClick={() => { setSelectedFile(null); setUploadError(""); }}
              >✕</button>
            </div>
          </div>
        )}

        {(uploading || uploadError) && (
          <div id="upload-progress-wrap" style={{ marginTop: "16px" }}>
            <div className="quota-bar" style={{ marginBottom: "6px" }}>
              <div
                id="upload-progress-bar"
                className="quota-bar-fill"
                style={{
                  width: progress + "%",
                  background: uploadError ? "var(--danger)" : undefined,
                }}
              />
            </div>
            <div id="upload-progress-label" className="text-sm text-muted">
              {uploadError ? "Error: " + uploadError : `Uploading… ${progress}%`}
            </div>
          </div>
        )}

        <div style={{ marginTop: "16px" }}>
          <button
            id="send-btn"
            className="btn btn-primary btn-block"
            disabled={!selectedFile || uploading}
            onClick={doUpload}
          >
            {uploading ? `Uploading… ${progress}%` : "Send file"}
          </button>
        </div>
      </div>
    </div>
  );
}
