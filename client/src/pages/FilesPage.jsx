import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, csrf, user, isLoggedIn, formatBytes, formatDate, parseDuration, logout } from '../lib/api.js';
import { showToast } from '../lib/toast.js';
import { showConfirm, showPrompt, showCopyModal } from '../lib/dialog.js';
import {
  encryptFileClientSide, b64urlEncode, b64urlDecodeBytes, extractEk,
  fullShareUrl, directoryShareUrl, clientDirectoryKey
} from '../lib/crypto.js';

const CHUNK_THRESHOLD = 80 * 1024 * 1024;
const CHUNK_CONCURRENCY = 2;
const CHUNK_RETRIES = 4;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const CHUNK_RESUME_KEY = "fu.chunked.v1";

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

async function _uploadErr(res) {
  try { const j = await res.json(); return new Error(j.detail || ("Upload failed (" + res.status + ")")); }
  catch { return new Error("Upload failed (" + res.status + ")"); }
}

function singleUpload(uploadFile, fields, onProgress) {
  const fd = new FormData();
  fd.append("file", uploadFile, fields.original_filename);
  fd.append("original_filename", fields.original_filename);
  fd.append("randomize_filename", fields.randomize_filename ? "true" : "false");
  fd.append("encryption_mode", fields.encryption_mode);
  fd.append("compress", fields.compress ? "true" : "false");
  fd.append("is_permanent", fields.is_permanent ? "true" : "false");
  if (fields.directory_id != null) fd.append("directory_id", String(fields.directory_id));
  if (fields.max_uses) fd.append("max_uses", String(fields.max_uses));
  if (fields.expires_in_seconds) fd.append("expires_in_seconds", String(fields.expires_in_seconds));
  if (fields.temp_days) fd.append("temp_days", String(fields.temp_days));
  if (fields.archive_after_idle_days) fd.append("archive_after_idle_days", String(fields.archive_after_idle_days));
  if (fields.delete_if_idle_days) fd.append("delete_if_idle_days", String(fields.delete_if_idle_days));

  const token = csrf.get();
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/files/upload");
    if (token) x.setRequestHeader("X-CSRF-Token", token);
    x.upload.addEventListener("progress", e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
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

async function chunkedUpload(blob, fields, item, onProgress) {
  const jsonHeaders = { "Content-Type": "application/json", ..._csrfHeader() };
  const canResume = fields.encryption_mode !== "client";
  const resumeKey = _resumeKey(item, fields);

  let upload_id = null, chunk_size = 0, num_chunks = 0;
  let received = new Set();

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
    if (!upload_id) _resumeDrop(resumeKey);
  }

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

  const chunkLen = (i) => Math.min(chunk_size, blob.size - i * chunk_size);
  let doneBytes = 0;
  received.forEach(i => { doneBytes += chunkLen(i); });
  const bumpProgress = () => onProgress(Math.min(100, Math.round((doneBytes / blob.size) * 100)));
  bumpProgress();

  const pending = [];
  for (let i = 0; i < num_chunks; i++) if (!received.has(i)) pending.push(i);

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
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastErr || new Error("Chunk " + i + " failed.");
  };

  await _runPool(pending, CHUNK_CONCURRENCY, sendChunk);

  const finRes = await fetch("/files/upload/finalize", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ upload_id }),
  });
  if (!finRes.ok) throw await _uploadErr(finRes);
  if (canResume) _resumeDrop(resumeKey);
  return await finRes.json();
}

// ── Success modal ─────────────────────────────────────────────────────────
function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  }
  return <button className="btn btn-ghost btn-sm" onClick={copy}>{copied ? "Copied!" : label}</button>;
}

function SuccessModal({ data, onClose }) {
  if (!data) return null;
  const { shareUrl, filename, keyOnly, encMode, isDir, title } = data;
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: "520px" }}>
        <div className="modal-title">{isDir ? "Folder shared" : "Upload complete"}</div>
        <div>
          <div style={{ textAlign: "center", fontSize: "13px", fontWeight: 500, marginBottom: "4px", wordBreak: "break-all" }}>
            {filename || title}
          </div>
          {isDir && (
            <div style={{ textAlign: "center", fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px" }}>
              Anyone with this link can browse and download all files.
            </div>
          )}
          <div style={{ display: "flex", gap: "6px", justifyContent: "center", flexWrap: "wrap", marginBottom: "8px" }}>
            <CopyBtn text={shareUrl} label="Copy link" />
            <CopyBtn text={`[${filename || title}](${shareUrl})`} label="Markdown" />
            <CopyBtn text={`<a href="${shareUrl}">${filename || title}</a>`} label="HTML" />
            <button className="btn btn-ghost btn-sm" onClick={() => window.open(shareUrl, "_blank", "noopener")}>Open ↗</button>
          </div>
          {keyOnly && (
            <>
              <div style={{ borderTop: "1px solid var(--border)", margin: "14px 0 12px" }} />
              <div className="text-xs text-muted" style={{ marginBottom: "4px" }}>
                {encMode === "server" ? "Access key (?ek=)" : "Decryption key (#ek=)"}
              </div>
              <div style={{
                background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
                padding: "8px 12px", fontSize: "12px", wordBreak: "break-all",
                fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: "8px"
              }}>{keyOnly}</div>
              <CopyBtn text={keyOnly} label="Copy key" />
            </>
          )}
          {encMode === "client" && (
            <div style={{ fontSize: "12px", color: "var(--warning)", marginTop: "10px" }}>
              ⚠ End-to-end encrypted — the key above is in this URL only. Save it; it cannot be recovered from the server.
            </div>
          )}
          {encMode === "server" && (
            <div style={{ fontSize: "12px", color: "var(--warning)", marginTop: "10px" }}>
              🔐 Server-encrypted — the access key above is required to download. Share the full URL or key separately.
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Dir modal ────────────────────────────────────────────────────────────
function CreateDirModal({ show, onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [encMode, setEncMode] = useState("none");
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    const expiresInSec = expires.trim() ? parseDuration(expires.trim()) : null;
    if (expires.trim() && expiresInSec === null) {
      showToast('Invalid duration — use "7d", "24h", "30m"', "error");
      return;
    }
    const body = { title: title.trim() || "Shared folder", encryption_mode: encMode };
    if (expiresInSec) body.expires_in_seconds = expiresInSec;
    const clientKey = encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;
    setSaving(true);
    const resp = await apiFetch("/directories", { method: "POST", json: body });
    setSaving(false);
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Folder creation failed.", "error");
      return;
    }
    const dir = await resp.json();
    onCreated(dir, encMode, clientKey);
    onClose();
  }

  if (!show) return null;
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Create shared folder</div>
        <div className="form-group">
          <label>Folder title</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Shared folder" autoFocus />
        </div>
        <div className="form-group">
          <label>Encryption</label>
          <select value={encMode} onChange={e => setEncMode(e.target.value)}>
            <option value="none">None</option>
            <option value="server">Server-side</option>
            <option id="dir-encrypt-client" value="client">End-to-end (client)</option>
          </select>
        </div>
        <div className="form-group">
          <label>Expires in</label>
          <input type="text" value={expires} onChange={e => setExpires(e.target.value)} placeholder='e.g. "7d", "24h"' />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleCreate}>
            {saving ? "Creating…" : "Create folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Mint link modal ───────────────────────────────────────────────────────
function MintModal({ show, onClose, onMinted }) {
  const [maxUses, setMaxUses] = useState("");
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleMint() {
    const expiresInSec = expires.trim() ? parseDuration(expires.trim()) : null;
    if (expires.trim() && expiresInSec === null) {
      showToast('Invalid duration — use "7d", "24h"', "error");
      return;
    }
    const body = {};
    if (maxUses.trim()) body.max_uses = parseInt(maxUses, 10);
    if (expiresInSec) body.expires_in_seconds = expiresInSec;
    setSaving(true);
    const result = await onMinted(body);
    setSaving(false);
    if (result !== false) onClose();
  }

  if (!show) return null;
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">New share link</div>
        <div className="form-group">
          <label>Max downloads (optional)</label>
          <input type="number" min="1" value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="Unlimited" autoFocus />
        </div>
        <div className="form-group">
          <label>Expires in (optional)</label>
          <input type="text" value={expires} onChange={e => setExpires(e.target.value)} placeholder='e.g. "7d", "24h"' />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleMint}>
            {saving ? "Creating…" : "Create link"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── New key modal ─────────────────────────────────────────────────────────
function NewKeyModal({ show, rawKey, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!show) return null;
  function copy() {
    navigator.clipboard.writeText(rawKey).then(() => {
      setCopied(true);
      showToast("Copied!");
    }).catch(() => {});
  }
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">New API key</div>
        <div className="text-sm mb-8" style={{ color: "var(--warning)" }}>
          ⚠ Copy this key now — it won't be shown again.
        </div>
        <div style={{
          background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
          padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: "13px",
          wordBreak: "break-all", marginBottom: "8px"
        }}>{rawKey}</div>
        <button className="btn btn-ghost btn-sm" onClick={copy}>{copied ? "Copied!" : "Copy key"}</button>
        <div className="modal-footer">
          <button className="btn btn-primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Reset IP modal ────────────────────────────────────────────────────────
function ResetIpModal({ show, keyId, onClose }) {
  const [pw, setPw] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleReset() {
    if (!pw) return;
    setSaving(true);
    const resp = await apiFetch(`/keys/${keyId}/reset-ip`, { method: "POST", json: { password: pw } });
    setSaving(false);
    onClose();
    if (resp.ok) showToast("IP binding cleared.");
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed to reset IP.", "error"); }
  }

  if (!show) return null;
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Reset IP binding</div>
        <div className="form-group">
          <label>Current password</label>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !pw} onClick={handleReset}>
            {saving ? "Resetting…" : "Reset IP"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Link row ──────────────────────────────────────────────────────────────
function LinkRow({ lk, file, canRegenerateLinks, canDeleteLinks, onRefresh }) {
  const now = Date.now();
  const expired = lk.expires_at && new Date(lk.expires_at).getTime() < now;
  const usedUp = lk.max_uses != null && lk.use_count >= lk.max_uses;
  const inactive = !lk.active || expired || usedUp;

  const base = `${location.origin}/file/${lk.slug}`;
  const url = file?.encryption_mode === "server" && file?.access_key
    ? base + "?ek=" + encodeURIComponent(file.access_key)
    : base;

  function openCopy() {
    const key = file?.encryption_mode === "server" && file?.access_key ? file.access_key : "";
    showCopyModal(url, file?.original_filename || "file", {
      key,
      keyLabel: file?.encryption_mode === "server" ? "Access key (?ek=)" : "",
      keyHint: key ? "🔐 Server-encrypted — this key is required to download." : "",
      hint: file?.encryption_mode === "client"
        ? "🔒 End-to-end encrypted — key not stored server-side. Append your #ek= to this URL before sharing."
        : "",
    });
  }

  async function deactivate() {
    const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: false } });
    if (resp.ok) { showToast("Link deactivated."); onRefresh(); }
    else showToast("Failed to deactivate.", "error");
  }

  async function reactivate() {
    const resp = await apiFetch(`/links/${lk.id}`, { method: "PATCH", json: { active: true } });
    if (resp.ok) { showToast("Link reactivated."); onRefresh(); }
    else showToast("Failed to reactivate.", "error");
  }

  async function deleteLink() {
    const ok = await showConfirm({
      title: "Delete link?",
      message: "This permanently removes this share link. The file remains stored.",
      confirmText: "Delete link",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/links/${lk.id}`, { method: "DELETE" });
    if (resp.ok) { showToast("Link deleted."); onRefresh(); }
    else showToast("Failed to delete link.", "error");
  }

  return (
    <div className={`link-row${inactive ? " link-inactive" : ""}`}>
      <span style={{
        width: "6px", height: "6px", borderRadius: "50%",
        background: inactive ? "var(--text-muted)" : "var(--success)",
        flexShrink: 0, marginTop: "2px"
      }} />
      <span className="link-url" title={url}>{url}</span>
      {file?.encryption_mode === "client" && (
        <span className="badge badge-orange" title="The #ek= key is not stored server-side">needs #ek=</span>
      )}
      {lk.max_uses != null && (
        <span className="link-uses">{lk.use_count}/{lk.max_uses} dl</span>
      )}
      {lk.expires_at && (
        <span className="file-meta">exp {new Date(lk.expires_at).toLocaleDateString()}</span>
      )}
      <button className="btn btn-ghost btn-sm" onClick={openCopy}>Copy</button>
      <button className="btn btn-ghost btn-sm" onClick={() => window.open(url, "_blank", "noopener")}>Open</button>
      {!inactive && canRegenerateLinks && (
        <button className="btn btn-ghost btn-sm" onClick={deactivate}>Deactivate</button>
      )}
      {inactive && (
        <span className="badge badge-gray">
          {!lk.active ? "inactive" : expired ? "expired" : "used up"}
        </span>
      )}
      {inactive && !lk.active && !expired && !usedUp && canRegenerateLinks && (
        <button className="btn btn-ghost btn-sm" onClick={reactivate}>Reactivate</button>
      )}
      {canDeleteLinks && (
        <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={deleteLink}>Delete</button>
      )}
    </div>
  );
}

// ── Directory members ─────────────────────────────────────────────────────
function DirectoryMembers({ dirId, canDeleteFiles, onRefresh }) {
  const [files, setFiles] = useState(null);

  useEffect(() => {
    apiFetch(`/directories/${dirId}/files`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setFiles(d.files))
      .catch(() => setFiles([]));
  }, [dirId]);

  if (files === null) return <div className="text-xs text-muted">Loading files…</div>;
  if (!files.length) return <div className="text-xs text-muted">Empty folder.</div>;

  return (
    <>
      {files.map(f => (
        <div key={f.id} className="link-row">
          <span className="link-url" title={f.filename}>{f.filename}</span>
          <span className="file-meta">{formatBytes(f.size_bytes)}</span>
          {canDeleteFiles && (
            <button className="btn btn-danger btn-sm" onClick={async () => {
              const ok = await showConfirm({
                title: "Remove file?",
                message: `"${f.filename}" will be removed from this folder and its links will be deleted.`,
                confirmText: "Remove file",
                danger: true,
              });
              if (!ok) return;
              const resp = await apiFetch(`/directories/${dirId}/files/${f.id}`, { method: "DELETE" });
              if (resp.ok) { showToast("File removed."); onRefresh(); }
              else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Remove failed.", "error"); }
            }}>Remove</button>
          )}
        </div>
      ))}
    </>
  );
}

// ── Directory card ────────────────────────────────────────────────────────
function DirectoryCard({ d, canDeleteFiles, canCreateDirectories, onRefresh, onAddFiles }) {
  const shareUrl = d.url ? directoryShareUrl(d, d.encryption_mode, null) : "";

  async function deleteDir() {
    const ok = await showConfirm({
      title: "Delete folder?",
      message: `"${d.title}" and all ${d.file_count} file${d.file_count !== 1 ? "s" : ""} inside will be permanently removed. This cannot be undone.`,
      confirmText: "Delete folder",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/directories/${d.id}`, { method: "DELETE" });
    if (resp.ok) { showToast("Folder deleted."); onRefresh(); }
    else { const dd = await resp.json().catch(() => ({})); showToast(dd.detail || "Delete failed.", "error"); }
  }

  return (
    <div className="file-card">
      <div className="file-card-header" style={{ cursor: "default" }}>
        <span style={{ fontSize: "18px", flexShrink: 0, opacity: 0.7 }}>📁</span>
        <div className="file-name" title={d.title}>{d.title}</div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexShrink: 0 }}>
          <span className="file-meta">{d.file_count} file{d.file_count !== 1 ? "s" : ""}</span>
          <span className="file-meta">{formatBytes(d.total_bytes)}</span>
          {d.encryption_mode === "client" && (
            <span className="badge badge-orange" title="End-to-end encrypted — key lives only in the share link (#ek=)">🔒 e2e</span>
          )}
          {d.encryption_mode === "server" && (
            <span className="badge badge-orange" title="Server-encrypted — one ?ek= access key unlocks the whole folder">🔐 server</span>
          )}
          <span className="badge badge-green">folder</span>
        </div>
        <div style={{ display: "flex", gap: "5px", flexShrink: 0 }}>
          {canCreateDirectories && (
            <button className="btn btn-ghost btn-sm" onClick={() => onAddFiles(d)}>Add files</button>
          )}
          <a className="btn btn-ghost btn-sm" href={shareUrl} target="_blank" rel="noopener" title="Open the shared folder page">Open</a>
          <button className="btn btn-ghost btn-sm" onClick={() => {
            navigator.clipboard.writeText(shareUrl).catch(() => {});
            showToast("Link copied.");
          }}>Copy</button>
          {canDeleteFiles && (
            <button className="btn btn-danger btn-sm" onClick={deleteDir}>Delete all</button>
          )}
        </div>
      </div>
      <div className="file-body">
        {d.encryption_mode === "client" && (
          <div style={{ fontSize: "12px", color: "var(--text-muted)", lineHeight: 1.5, marginBottom: "8px" }}>
            End-to-end encrypted. Keep the #ek= key from the share link; adding files later needs it.
          </div>
        )}
        <DirectoryMembers dirId={d.id} canDeleteFiles={canDeleteFiles} onRefresh={onRefresh} />
      </div>
    </div>
  );
}

// ── Encryption badge ──────────────────────────────────────────────────────
function EncBadge({ f }) {
  if (f.encryption_mode === "client") {
    return <span className="badge badge-orange" title="End-to-end encrypted — key lives only in the share link (#ek=)">🔒 e2e</span>;
  }
  if (f.encryption_mode === "server") {
    return <span className="badge badge-orange" title="Server-side encrypted — needs the ?ek= access key to download">🔐 server</span>;
  }
  return null;
}

// ── File card ────────────────────────────────────────────────────────────
function FileCard({ f, canRegenerateLinks, canDeleteFiles, canDeleteLinks, onRefresh, onMint }) {
  const activeLinks = f.links.filter(l => l.active).length;

  async function deleteFile() {
    const ok = await showConfirm({
      title: "Delete file?",
      message: `"${f.original_filename}" and all its links will be permanently removed. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/files/${f.id}`, { method: "DELETE" });
    if (resp.ok) { showToast("File deleted."); onRefresh(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Delete failed.", "error"); }
  }

  return (
    <div className="file-card">
      <div className="file-card-header">
        <span style={{ fontSize: "18px", flexShrink: 0, opacity: 0.55 }}>{fileIcon(f.content_type)}</span>
        <div className="file-name" title={f.original_filename}>{f.original_filename}</div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexShrink: 0 }}>
          <span className="file-meta">{formatBytes(f.size_bytes)}</span>
          <span className="file-meta">{formatDate(f.created_at)}</span>
          <EncBadge f={f} />
          {f.compressed && <span className="badge badge-gray" title="Stored compressed (zstd)">zst</span>}
          <span className={activeLinks > 0 ? "badge badge-green" : "badge badge-gray"}>
            {f.links.length} link{f.links.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: "5px", flexShrink: 0 }}>
          {canRegenerateLinks && (
            <button className="btn btn-ghost btn-sm" title="Create a new share link" onClick={() => onMint(f.id)}>+ Link</button>
          )}
          {canDeleteFiles && (
            <button className="btn btn-danger btn-sm" onClick={deleteFile}>Delete</button>
          )}
        </div>
      </div>
      {f.links.length > 0 && (
        <div className="file-body">
          {f.links.map(lk => (
            <LinkRow
              key={lk.id}
              lk={lk}
              file={f}
              canRegenerateLinks={canRegenerateLinks}
              canDeleteLinks={canDeleteLinks}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Queue item ────────────────────────────────────────────────────────────
function QueueItem({ item, uploadMode, onRemove }) {
  const displayName = (uploadMode === "folder" && item.file.webkitRelativePath)
    ? item.file.webkitRelativePath
    : item.file.name;

  return (
    <div className={`file-queue-item ${item.status}`}>
      <div className="fq-row">
        <span className="fq-icon">{fileIcon(item.file.type)}</span>
        <span className="fq-name" title={displayName}>{displayName}</span>
        <span className="fq-size">{formatBytes(item.file.size)}</span>
        {item.status === "uploading" && <span className="fq-pct">{item.progress}%</span>}
        {item.status === "done" && <span className="fq-ok">✓ done</span>}
        {item.status === "error" && <span className="fq-err">✕ failed</span>}
        {(item.status === "error" || item.status === "queued") && (
          <button className="fq-rm" title={item.status === "error" ? "Dismiss" : "Remove from queue"} onClick={() => onRemove(item.id)}>✕</button>
        )}
      </div>
      {item.status === "uploading" && (
        <div className="fq-prog">
          <div className="fq-prog-bar" style={{ width: item.progress + "%" }} />
        </div>
      )}
      {item.status === "done" && item.result?._share_full && (
        <div className="fq-links">
          <div className="copy-row">
            <span className="copy-row-text">{item.result._share_full}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(item.result._share_full).catch(() => {})}>Copy</button>
            <button className="btn btn-ghost btn-sm" onClick={() => window.open(item.result._share_full, "_blank", "noopener")}>Open</button>
          </div>
        </div>
      )}
      {item.status === "error" && item.error && (
        <div className="fq-err-msg">{item.error}</div>
      )}
    </div>
  );
}

// ── Receive panel ─────────────────────────────────────────────────────────
function ReceivePanel() {
  const [link, setLink] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expires, setExpires] = useState("1h");
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadActive(); }, []);

  async function loadActive() {
    setLoading(true);
    try {
      const resp = await apiFetch("/dropbox-links/active");
      if (resp.ok) setLink(await resp.json());
      else setLink(null);
    } catch {
      setLink(null);
    }
    setLoading(false);
  }

  async function createLink() {
    const sec = parseDuration(expires.trim() || "1h");
    if (sec === null) { showToast('Invalid duration — use "1h", "7d", "30m"', "error"); return; }
    setCreating(true);
    const resp = await apiFetch("/dropbox-links", { method: "POST", json: { expires_in_seconds: sec } });
    setCreating(false);
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Failed to create upload link.", "error");
      return;
    }
    loadActive();
  }

  async function revokeLink() {
    if (!link) return;
    const ok = await showConfirm({
      title: "Revoke dropbox link?",
      message: "The link will stop working immediately.",
      confirmText: "Revoke",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/dropbox-links/${link.id}`, { method: "DELETE" });
    if (resp.ok || resp.status === 204) { showToast("Link revoked."); loadActive(); }
    else showToast("Failed to revoke.", "error");
  }

  if (loading) return <div className="text-sm text-muted" style={{ marginTop: "12px" }}>Checking for active link…</div>;

  if (link) {
    const exp = link.expires_at ? `expires ${new Date(link.expires_at).toLocaleString()}` : "no expiry";
    return (
      <div className="receive-result-box">
        <div className="receive-result-title">Active dropbox link</div>
        <div className="receive-hint">One-use only — {exp}.</div>
        <div className="copy-row" style={{ marginTop: "10px" }}>
          <span className="copy-row-text">{link.url}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(link.url).catch(() => {})}>Copy</button>
          <button className="btn btn-ghost btn-sm" onClick={() => window.open(link.url, "_blank", "noopener")}>Open</button>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: "var(--danger)", marginTop: "10px" }}
          onClick={revokeLink}
        >Revoke link</button>
      </div>
    );
  }

  return (
    <div id="receive-create-form">
      <div className="form-group">
        <label>Link expires in</label>
        <input type="text" value={expires} onChange={e => setExpires(e.target.value)} placeholder='e.g. "1h", "7d"' />
      </div>
      <button className="btn btn-primary" disabled={creating} onClick={createLink}>
        {creating ? "Creating…" : "Create upload link"}
      </button>
    </div>
  );
}

// ── Main FilesPage ─────────────────────────────────────────────────────────
export default function FilesPage() {
  const navigate = useNavigate();

  // Permissions
  const [perms, setPerms] = useState({
    canUpload: true,
    canClientEnc: true,
    canDelete: false,
    canRegenLinks: false,
    canDeleteLinks: false,
    canCreateDirs: false,
    canApiKeys: false,
  });

  // Quota
  const [quota, setQuota] = useState(null);

  // Upload mode
  const [uploadMode, setUploadMode] = useState("files");

  // File queue
  const [fileQueue, setFileQueue] = useState([]);
  const fileQueueRef = useRef([]);
  fileQueueRef.current = fileQueue;

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // {current, total, pct}

  // Advanced options
  const [advOpen, setAdvOpen] = useState(false);
  const [maxUses, setMaxUses] = useState("");
  const [expiresIn, setExpiresIn] = useState("");
  const [randomize, setRandomize] = useState(false);
  const [encMode, setEncMode] = useState("none");
  const [compress, setCompress] = useState(false);
  const [tempDays, setTempDays] = useState("");
  const [archDays, setArchDays] = useState("");
  const [delDays, setDelDays] = useState("");

  // Remote upload
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteStatus, setRemoteStatus] = useState({ text: "", cls: "text-sm text-muted" });
  const [remoteLoading, setRemoteLoading] = useState(false);

  // Files list
  const [filesList, setFilesList] = useState(null); // null=loading, {dirs, files}

  // Modals
  const [showCreateDir, setShowCreateDir] = useState(false);
  const [showMint, setShowMint] = useState(false);
  const [mintFileId, setMintFileId] = useState(null);
  const [successData, setSuccessData] = useState(null);
  const [newKeyModal, setNewKeyModal] = useState({ show: false, key: "" });
  const [resetIpModal, setResetIpModal] = useState({ show: false, keyId: null });

  // API keys
  const [apiKeys, setApiKeys] = useState([]);

  // Drag state
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!isLoggedIn()) { navigate("/login", { replace: true }); return; }
    // Set up nav user
    document.title = "Files — Oxymoron";
    checkPermissions();
    loadUsage();
    loadFiles();
  }, [navigate]);

  async function checkPermissions() {
    try {
      const resp = await apiFetch("/account/me");
      if (!resp.ok) return;
      const me = await resp.json();
      setPerms({
        canUpload: !!me.can_upload,
        canClientEnc: !!me.can_upload_client_encrypted,
        canDelete: !!me.can_delete,
        canRegenLinks: !!me.can_regenerate_links,
        canDeleteLinks: !!me.can_delete_links,
        canCreateDirs: !!me.can_create_directories,
        canApiKeys: !!me.can_use_api_keys,
      });
      if (me.can_use_api_keys) loadApiKeys();
    } catch {}
  }

  async function loadUsage() {
    try {
      const resp = await apiFetch("/files/usage");
      if (!resp.ok) return;
      const { used_bytes, quota_bytes } = await resp.json();
      setQuota({ used: used_bytes, total: quota_bytes });
    } catch {}
  }

  async function loadFiles() {
    setFilesList(null);
    try {
      const [fResp, dResp] = await Promise.all([apiFetch("/files/"), apiFetch("/directories/")]);
      const files = fResp.ok ? (await fResp.json()).files : [];
      const dirs = dResp.ok ? (await dResp.json()).directories : [];
      setFilesList({ dirs, files });
    } catch {
      setFilesList({ dirs: [], files: [], error: true });
    }
  }

  async function loadApiKeys() {
    const resp = await apiFetch("/keys/");
    if (!resp.ok) return;
    const data = await resp.json();
    setApiKeys((data.keys || []).filter(k => k.active));
  }

  function addToQueue(files) {
    const items = Array.from(files).map(f => ({
      id: qId(), file: f, status: "queued", progress: 0, result: null, error: null
    }));
    setFileQueue(q => [...q, ...items]);
  }

  function removeFromQueue(id) {
    setFileQueue(q => q.filter(i => i.status === "uploading" ? true : i.id !== id));
  }

  function clearQueue() {
    setFileQueue(q => q.filter(i => i.status === "uploading"));
  }

  function updateQueueItem(id, patch) {
    setFileQueue(q => q.map(i => i.id === id ? { ...i, ...patch } : i));
  }

  function changeMode(mode) {
    setUploadMode(mode);
    if (mode === "files" || mode === "folder") {
      setFileQueue(q => q.filter(i => i.status === "uploading"));
    }
  }

  async function startUpload() {
    const expiresInSec = expiresIn.trim() ? parseDuration(expiresIn.trim()) : null;
    if (expiresIn.trim() && expiresInSec === null) {
      showToast('Invalid duration — use "7d", "24h", "30m"', "error");
      return;
    }

    const pending = fileQueueRef.current.filter(i => i.status === "queued");
    if (!pending.length) return;

    const opts = {
      maxUsesRaw: maxUses,
      expiresInSec,
      randomize,
      encMode,
      compress,
      tempDays,
      archDays,
      delDays,
    };

    setUploading(true);

    if (uploadMode === "folder") {
      await uploadAsDirectory(pending, opts);
    } else {
      setUploadProgress({ current: 0, total: pending.length, pct: 0 });
      let completed = 0;
      for (const item of pending) {
        await doUpload(item, opts);
        completed++;
        setUploadProgress({ current: completed, total: pending.length, pct: Math.round((completed / pending.length) * 100) });
      }
      setUploadProgress(null);

      const done = fileQueueRef.current.filter(i => i.status === "done");
      const errs = fileQueueRef.current.filter(i => i.status === "error");
      if (done.length) { showToast(`${done.length} file${done.length !== 1 ? "s" : ""} uploaded!`); loadFiles(); loadUsage(); }
      if (errs.length) showToast(`${errs.length} upload${errs.length !== 1 ? "s" : ""} failed.`, "error");
    }

    setUploading(false);
  }

  async function uploadAsDirectory(pending, opts) {
    let title = "Shared folder";
    const rel = pending[0]?.file.webkitRelativePath;
    if (rel && rel.includes("/")) title = rel.split("/")[0];

    setUploadProgress({ current: 0, total: pending.length, pct: 0, label: "Creating folder…" });

    const body = { title, encryption_mode: opts.encMode };
    if (opts.expiresInSec) body.expires_in_seconds = opts.expiresInSec;

    let dir;
    try {
      const resp = await apiFetch("/directories", { method: "POST", json: body });
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.detail || "could not create folder"); }
      dir = await resp.json();
    } catch (err) {
      setUploadProgress(null);
      showToast("Folder creation failed: " + err.message, "error");
      return;
    }

    const sharedKey = opts.encMode === "client" ? crypto.getRandomValues(new Uint8Array(32)) : null;
    let completed = 0;
    for (const item of pending) {
      await doUpload(item, { ...opts, directoryId: dir.id, sharedClientKey: sharedKey });
      completed++;
      setUploadProgress({ current: completed, total: pending.length, pct: Math.round((completed / pending.length) * 100) });
    }
    setUploadProgress(null);

    const doneCount = pending.filter(i => i.status === "done").length;
    const errCount = pending.filter(i => i.status === "error").length;
    if (doneCount) showToast(`Folder shared — ${doneCount} file${doneCount !== 1 ? "s" : ""}.`);
    if (errCount) showToast(`${errCount} file${errCount !== 1 ? "s" : ""} failed.`, "error");
    if (doneCount) {
      const shareUrl = directoryShareUrl(dir, opts.encMode, sharedKey);
      const keyOnly = opts.encMode === "client" && sharedKey ? b64urlEncode(sharedKey)
        : opts.encMode === "server" && dir.access_key ? dir.access_key : "";
      setSuccessData({
        shareUrl,
        filename: dir.title || "folder",
        keyOnly,
        encMode: opts.encMode,
        isDir: true,
        title: dir.title || "Shared folder",
      });
    }
    loadFiles();
    loadUsage();
  }

  async function doUpload(item, { maxUsesRaw, expiresInSec, randomize, encMode = "none", compress = false, tempDays = "", archDays = "", delDays = "", directoryId = null, sharedClientKey = null }) {
    updateQueueItem(item.id, { status: "uploading", progress: 0 });

    let filename = item.file.name;
    if (uploadMode === "folder" && item.file.webkitRelativePath) filename = item.file.webkitRelativePath;

    let uploadFile = item.file;
    let clientKeyBytes = null;

    if (encMode === "client") {
      try {
        const { ciphertext, keyBytes } = await encryptFileClientSide(item.file, sharedClientKey);
        uploadFile = new Blob([ciphertext], { type: "application/octet-stream" });
        clientKeyBytes = keyBytes;
      } catch (err) {
        updateQueueItem(item.id, { status: "error", error: "Encryption failed: " + err.message });
        item.status = "error";
        return;
      }
    }

    const fields = {
      original_filename: filename,
      randomize_filename: directoryId == null && randomize,
      encryption_mode: encMode,
      compress: !!compress,
      is_permanent: tempDays ? false : true,
    };
    if (directoryId != null) fields.directory_id = Number(directoryId);
    if (maxUsesRaw) fields.max_uses = Number(maxUsesRaw);
    if (expiresInSec) fields.expires_in_seconds = Number(expiresInSec);
    if (tempDays) fields.temp_days = Number(tempDays);
    if (archDays) fields.archive_after_idle_days = Number(archDays);
    if (delDays) fields.delete_if_idle_days = Number(delDays);

    let result = null;
    try {
      if (uploadFile.size > CHUNK_THRESHOLD) {
        result = await chunkedUpload(uploadFile, fields, item, (pct) => {
          updateQueueItem(item.id, { progress: pct });
          item.progress = pct;
        });
      } else {
        result = await singleUpload(uploadFile, fields, (pct) => {
          updateQueueItem(item.id, { progress: pct });
          item.progress = pct;
        });
      }
    } catch (err) {
      updateQueueItem(item.id, { status: "error", error: (err && err.message) ? err.message : "Upload failed." });
      item.status = "error";
      return;
    }

    if (result) {
      result._share_full = fullShareUrl(result, encMode, clientKeyBytes);
      if (directoryId == null) {
        const keyOnly = encMode === "client" && clientKeyBytes ? b64urlEncode(clientKeyBytes)
          : encMode === "server" && result.access_key ? result.access_key : "";
        setSuccessData({
          shareUrl: result._share_full,
          filename: result.original_filename || "file",
          keyOnly,
          encMode,
          isDir: false,
        });
      }
    }
    updateQueueItem(item.id, { status: "done", result });
    item.status = "done";
  }

  async function handleRemoteUpload() {
    const url = remoteUrl.trim();
    if (!url) { showToast("Paste a remote URL first.", "error"); return; }
    setRemoteLoading(true);
    setRemoteStatus({ text: "Fetching…", cls: "text-sm remote-status-running" });
    const body = { url };
    if (remoteName.trim()) body.original_filename = remoteName.trim();
    const resp = await apiFetch("/files/remote-upload", { method: "POST", json: body });
    setRemoteLoading(false);
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      setRemoteStatus({ text: d.detail || "Remote upload failed.", cls: "text-sm remote-status-error" });
      return;
    }
    const result = await resp.json();
    setRemoteStatus({ text: "Stored ✓", cls: "text-sm remote-status-done" });
    setTimeout(() => setRemoteStatus({ text: "", cls: "text-sm text-muted" }), 3000);
    setSuccessData({ shareUrl: result.url, filename: result.original_filename || "file", keyOnly: "", encMode: "none", isDir: false });
    setRemoteUrl("");
    setRemoteName("");
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

      const items = files.map(file => ({ id: qId(), file, status: "queued", progress: 0, result: null, error: null }));
      setFileQueue(q => [...q, ...items]);

      setUploading(true);
      setUploadProgress({ current: 0, total: items.length, pct: 0 });
      let completed = 0;
      for (const item of items) {
        await doUpload(item, {
          maxUsesRaw: "", expiresInSec: null, randomize: false,
          encMode: d.encryption_mode, compress: false,
          tempDays: "", archDays: "", delDays: "",
          directoryId: d.id, sharedClientKey,
        });
        completed++;
        setUploadProgress({ current: completed, total: items.length, pct: Math.round((completed / items.length) * 100) });
      }
      setUploadProgress(null);
      setUploading(false);

      const doneCount = items.filter(i => i.status === "done").length;
      const errCount = items.filter(i => i.status === "error").length;
      if (doneCount) showToast(`${doneCount} file${doneCount !== 1 ? "s" : ""} added.`);
      if (errCount) showToast(`${errCount} file${errCount !== 1 ? "s" : ""} failed.`, "error");
      loadFiles();
      loadUsage();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
    window.addEventListener("focus", () => { if (input.isConnected) input.remove(); }, { once: true });
  }

  async function handleMintConfirm(body) {
    const resp = await apiFetch(`/files/${mintFileId}/links`, { method: "POST", json: body });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Failed to create link.", "error");
      return false;
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
  }

  async function createApiKey() {
    const resp = await apiFetch("/keys/", { method: "POST", json: {} });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Failed to create key.", "error");
      return;
    }
    const data = await resp.json();
    setNewKeyModal({ show: true, key: data.key });
  }

  async function revokeApiKey(id) {
    const ok = await showConfirm({
      title: "Revoke API key?",
      message: "Any integration using this key will immediately stop working. This cannot be undone.",
      confirmText: "Revoke key",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/keys/${id}`, { method: "DELETE" });
    if (resp.ok) { showToast("Key revoked."); loadApiKeys(); }
    else { const d = await resp.json().catch(() => ({})); showToast(d.detail || "Failed to revoke key.", "error"); }
  }

  // Quota bar
  const quotaSection = quota && quota.total > 0 ? (() => {
    const pct = Math.min(100, (quota.used / quota.total) * 100);
    return (
      <div id="quota-section" style={{ marginBottom: "16px" }}>
        <div className="quota-bar">
          <div
            className={`quota-bar-fill${pct >= 90 ? " danger" : pct >= 70 ? " warn" : ""}`}
            style={{ width: pct.toFixed(1) + "%" }}
          />
        </div>
        <div className="text-xs text-muted" style={{ marginTop: "4px" }}>
          {formatBytes(quota.used)} used of {formatBytes(quota.total)}
        </div>
      </div>
    );
  })() : null;

  const queuedItems = fileQueue.filter(i => i.status === "queued");
  const uploadBtnDisabled = uploading || queuedItems.length === 0;

  return (
    <div className="page-wrap">
      {/* Nav */}
      <nav className="nav">
        <div className="nav-brand">Oxymoron</div>
        <div className="nav-links">
          <a className="nav-link active" href="/files">Files</a>
          {user.get()?.role === "master" && <a className="nav-link" href="/admin">Admin</a>}
        </div>
        <div className="nav-user-area">
          <span id="nav-user">{user.get()?.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <div className="container">
        <h1 className="page-title">Upload</h1>

        {quotaSection}

        {/* Mode selector */}
        <div className="mode-selector">
          {["files", "folder", "remote", "receive"].map(mode => (
            <button
              key={mode}
              className={`mode-btn${uploadMode === mode ? " active" : ""}`}
              data-mode={mode}
              onClick={() => changeMode(mode)}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

        {/* Local upload panel */}
        {(uploadMode === "files" || uploadMode === "folder") && (
          <div id="local-upload-panel">
            <div
              id="drop-zone"
              className={`drop-zone${dragOver ? " drag-over" : ""}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer.files);
                if (files.length) addToQueue(files);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="drop-icon">↑</div>
              <div className="drop-label">Drop files here or click to browse</div>
              <div id="drop-sub" className="drop-sub">
                {uploadMode === "folder"
                  ? "Select a folder — it becomes one shared page with a download-all link"
                  : "Select one or many files · encrypt and set limits below"}
              </div>
            </div>
            <input
              ref={fileInputRef}
              id="file-input"
              type="file"
              style={{ display: "none" }}
              multiple={uploadMode === "files" || uploadMode === "folder"}
              {...(uploadMode === "folder" ? { webkitdirectory: "", directory: "" } : {})}
              onChange={() => {
                if (fileInputRef.current?.files?.length) {
                  addToQueue(Array.from(fileInputRef.current.files));
                  fileInputRef.current.value = "";
                }
              }}
            />

            {/* Queue */}
            {fileQueue.length > 0 && (
              <div style={{ marginTop: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                  <span id="upload-count-label" className="text-sm text-muted">
                    {queuedItems.length > 0
                      ? `${queuedItems.length} file${queuedItems.length !== 1 ? "s" : ""} queued`
                      : (() => {
                        const done = fileQueue.filter(i => i.status === "done").length;
                        const errs = fileQueue.filter(i => i.status === "error").length;
                        return done || errs
                          ? `${done} uploaded${errs ? `, ${errs} failed` : ""}`
                          : "";
                      })()
                    }
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={clearQueue}>Clear all</button>
                </div>
                <div id="file-queue">
                  {fileQueue.map(item => (
                    <QueueItem key={item.id} item={item} uploadMode={uploadMode} onRemove={removeFromQueue} />
                  ))}
                </div>
              </div>
            )}

            {/* Overall progress */}
            {uploadProgress && (
              <div id="progress-wrap" style={{ marginTop: "10px" }}>
                <div className="quota-bar">
                  <div className="quota-bar-fill" style={{ width: uploadProgress.pct + "%" }} />
                </div>
                <div className="text-sm text-muted" style={{ marginTop: "4px" }}>
                  {uploadProgress.label || `${uploadProgress.current} / ${uploadProgress.total} uploaded`}
                </div>
              </div>
            )}

            {/* Advanced options */}
            <div style={{ marginTop: "16px" }}>
              <button
                id="adv-toggle"
                className="btn btn-ghost btn-sm"
                aria-expanded={advOpen}
                onClick={() => setAdvOpen(o => !o)}
              >
                {advOpen ? "▼" : "▶"} Options
              </button>
              {advOpen && (
                <div id="adv-body" className="adv-body open" style={{ marginTop: "10px" }}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Max downloads</label>
                      <input type="number" min="1" value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="Unlimited" />
                    </div>
                    <div className="form-group">
                      <label>Expires in</label>
                      <input type="text" value={expiresIn} onChange={e => setExpiresIn(e.target.value)} placeholder='e.g. "7d", "24h"' />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Encryption</label>
                      <select id="opt-encrypt" value={encMode} onChange={e => setEncMode(e.target.value)}>
                        <option value="none">None</option>
                        <option value="server">Server-side</option>
                        {perms.canClientEnc && <option value="client">End-to-end (client)</option>}
                      </select>
                    </div>
                    <div className="form-group" style={{ justifyContent: "flex-end" }}>
                      <label className="checkbox-label">
                        <input type="checkbox" checked={randomize} onChange={e => setRandomize(e.target.checked)} />
                        Randomize filename
                      </label>
                      <label className="checkbox-label">
                        <input type="checkbox" checked={compress} onChange={e => setCompress(e.target.checked)} />
                        Compress
                      </label>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Temp days</label>
                      <input type="number" min="1" value={tempDays} onChange={e => setTempDays(e.target.value)} placeholder="Permanent" />
                    </div>
                    <div className="form-group">
                      <label>Archive after idle (days)</label>
                      <input type="number" min="1" value={archDays} onChange={e => setArchDays(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>Delete if idle (days)</label>
                      <input type="number" min="1" value={delDays} onChange={e => setDelDays(e.target.value)} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", marginTop: "16px", alignItems: "center" }}>
              <button
                id="upload-btn"
                className="btn btn-primary"
                disabled={uploadBtnDisabled}
                onClick={startUpload}
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
              {perms.canCreateDirs && (
                <button id="create-dir-btn" className="btn btn-ghost" onClick={() => setShowCreateDir(true)}>
                  New folder
                </button>
              )}
            </div>
          </div>
        )}

        {/* Remote upload panel */}
        {uploadMode === "remote" && (
          <div id="remote-upload-panel" style={{ marginTop: "12px" }}>
            <div className="form-group">
              <label>Remote URL</label>
              <input type="url" value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="https://…" id="remote-url" />
            </div>
            <div className="form-group">
              <label>Save as (optional)</label>
              <input type="text" value={remoteName} onChange={e => setRemoteName(e.target.value)} placeholder="filename.ext" id="remote-name" />
            </div>
            {remoteStatus.text && <div className={remoteStatus.cls}>{remoteStatus.text}</div>}
            <button
              id="remote-upload-btn"
              className="btn btn-primary"
              disabled={remoteLoading}
              onClick={handleRemoteUpload}
            >
              {remoteLoading ? "Fetching…" : "Fetch & store"}
            </button>
          </div>
        )}

        {/* Receive / dropbox panel */}
        {uploadMode === "receive" && (
          <div id="receive-upload-panel" style={{ marginTop: "12px" }}>
            <h3>Dropbox link</h3>
            <p className="text-sm text-muted">Share this link so others can send you a file — no account needed.</p>
            <ReceivePanel />
          </div>
        )}

        {/* Files list */}
        <div style={{ marginTop: "32px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
            <h2 id="files-heading" style={{ flex: 1, margin: 0 }}>Your files & folders</h2>
            <button id="refresh-btn" className="btn btn-ghost btn-sm" onClick={loadFiles}>Refresh</button>
          </div>

          <div id="files-list">
            {filesList === null && (
              <div className="empty"><div className="empty-icon">⟳</div>Loading…</div>
            )}
            {filesList?.error && (
              <div className="empty">Network error.</div>
            )}
            {filesList && !filesList.error && !filesList.dirs.length && !filesList.files.length && (
              <div className="empty">
                <div className="empty-icon">📂</div>
                Nothing here yet. Upload a file or share a folder above.
              </div>
            )}
            {filesList && !filesList.error && (filesList.dirs.length > 0 || filesList.files.length > 0) && (
              <>
                {filesList.dirs.map(d => (
                  <DirectoryCard
                    key={d.id}
                    d={d}
                    canDeleteFiles={perms.canDelete}
                    canCreateDirectories={perms.canCreateDirs}
                    onRefresh={() => { loadFiles(); loadUsage(); }}
                    onAddFiles={addFilesToDirectory}
                  />
                ))}
                {filesList.files.map(f => (
                  <FileCard
                    key={f.id}
                    f={f}
                    canRegenerateLinks={perms.canRegenLinks}
                    canDeleteFiles={perms.canDelete}
                    canDeleteLinks={perms.canDeleteLinks}
                    onRefresh={() => { loadFiles(); loadUsage(); }}
                    onMint={id => { setMintFileId(id); setShowMint(true); }}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* API Keys section */}
        {perms.canApiKeys && (
          <div id="keys-section" style={{ marginTop: "32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
              <h2 style={{ flex: 1, margin: 0 }}>API Keys</h2>
              <button id="user-create-key-btn" className="btn btn-ghost btn-sm" onClick={createApiKey}>+ Create key</button>
            </div>
            <div id="user-keys-list">
              {apiKeys.length === 0 && (
                <div className="empty"><div className="empty-icon">🔑</div>No API keys yet.</div>
              )}
              {apiKeys.map(k => (
                <div key={k.id} className="card" style={{ marginBottom: "8px", padding: 0, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>Key #{k.user_key_number ?? k.id}</span>
                    <span className="text-xs text-muted">{k.bound_ip ? `📍 ${k.bound_ip}` : "unbound"}</span>
                    <div style={{ flex: 1 }} />
                    <button className="btn btn-ghost btn-sm" onClick={() => setResetIpModal({ show: true, keyId: k.id })}>Reset IP</button>
                    <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={() => revokeApiKey(k.id)}>Revoke</button>
                  </div>
                  <div style={{ padding: "8px 14px", fontSize: "12px", color: "var(--text-muted)" }}>
                    Created: {new Date(k.created_at).toLocaleString()}
                    {k.last_used_at && ` · Last used: ${new Date(k.last_used_at).toLocaleString()}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateDirModal
        show={showCreateDir}
        onClose={() => setShowCreateDir(false)}
        onCreated={(dir, enc, key) => {
          const shareUrl = directoryShareUrl(dir, enc, key);
          const keyOnly = enc === "client" && key ? b64urlEncode(key)
            : enc === "server" && dir.access_key ? dir.access_key : "";
          setSuccessData({ shareUrl, filename: dir.title || "folder", keyOnly, encMode: enc, isDir: true, title: dir.title });
          loadFiles();
        }}
      />
      <MintModal
        show={showMint}
        onClose={() => setShowMint(false)}
        onMinted={handleMintConfirm}
      />
      <SuccessModal
        data={successData}
        onClose={() => setSuccessData(null)}
      />
      <NewKeyModal
        show={newKeyModal.show}
        rawKey={newKeyModal.key}
        onClose={() => { setNewKeyModal({ show: false, key: "" }); loadApiKeys(); }}
      />
      <ResetIpModal
        show={resetIpModal.show}
        keyId={resetIpModal.keyId}
        onClose={() => { setResetIpModal({ show: false, keyId: null }); loadApiKeys(); }}
      />
    </div>
  );
}
