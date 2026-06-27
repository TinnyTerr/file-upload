import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isLoggedIn, apiFetch, formatBytes } from '../lib/api.js';
import { showToast } from '../lib/toast.js';
import { showAlert, showPrompt } from '../lib/dialog.js';
import { buildZip } from '../lib/zip.js';

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

function b64urlDecode(v) {
  const pad = 4 - (v.length % 4);
  const b64 = (v + "====".slice(0, pad % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function getFragmentKey() {
  const m = window.location.hash.match(/[#&]ek=([^&]*)/);
  return m ? m[1] : null;
}

function getQueryKey() {
  return new URLSearchParams(window.location.search).get("ek");
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function clientDecrypt(ciphertext, keyBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/aead-worker.js");
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

const GROUP_LABELS = { images: "Images", videos: "Videos", audio: "Audio", text: "Text", pdfs: "PDFs", archives: "Archives", other: "Other files" };

// ── Lightbox ───────────────────────────────────────────────────────────────
function Lightbox({ media, startIdx, onClose }) {
  const [idx, setIdx] = useState(startIdx);

  const nav = useCallback((dir) => {
    setIdx(i => Math.max(0, Math.min(media.length - 1, i + dir)));
  }, [media.length]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "ArrowLeft") nav(-1);
      else if (e.key === "ArrowRight") nav(1);
      else if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [nav, onClose]);

  const { f, group } = media[idx];

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="lightbox-counter">{idx + 1} / {media.length}</div>
      <button className="lightbox-close" aria-label="Close" onClick={onClose}>✕</button>
      <button className="lightbox-arrow lightbox-prev" aria-label="Previous" disabled={idx === 0} onClick={() => nav(-1)}>‹</button>
      <button className="lightbox-arrow lightbox-next" aria-label="Next" disabled={idx === media.length - 1} onClick={() => nav(1)}>›</button>
      <div className="lightbox-media-wrap">
        {group === "images" && (
          <img className="lightbox-media" src={f.preview_url} alt={f.filename} />
        )}
        {group === "videos" && (
          <video className="lightbox-media" src={f.preview_url} controls autoPlay />
        )}
      </div>
      <div className="lightbox-caption">
        <div className="lightbox-caption-name">{f.filename}</div>
        <div className="lightbox-caption-meta">{formatBytes(f.size_bytes)}</div>
      </div>
    </div>
  );
}

// ── Gallery tile ────────────────────────────────────────────────────────────
function GalleryTile({ f, group, previewIdx, onDownload, onOpenLightbox }) {
  return (
    <div
      className={`dir-gallery-tile${previewIdx >= 0 ? " previewable" : ""}`}
      onClick={() => previewIdx >= 0 && onOpenLightbox(previewIdx)}
    >
      <div className="dir-gallery-thumb">
        {group === "images" && f.preview_url ? (
          <img alt={f.filename} src={f.preview_url} loading="lazy" onError={e => {
            const thumb = e.currentTarget.parentElement;
            thumb.innerHTML = "";
            const icon = document.createElement("span");
            icon.className = "dir-gallery-thumb-icon";
            icon.textContent = fileIcon(f.content_type);
            thumb.appendChild(icon);
          }} />
        ) : group === "videos" && f.preview_url ? (
          <video preload="metadata" muted src={f.preview_url} />
        ) : (
          <span className="dir-gallery-thumb-icon">{fileIcon(f.content_type)}</span>
        )}
        {previewIdx >= 0 && (
          <div className="dir-gallery-tile-overlay">
            <span className="dir-gallery-tile-overlay-icon">{group === "videos" ? "▶" : "⤢"}</span>
          </div>
        )}
      </div>
      <div className="dir-gallery-info">
        <div className="dir-gallery-name" title={f.filename}>{f.filename}</div>
        <div className="dir-gallery-size">{formatBytes(f.size_bytes)}</div>
      </div>
      <div className="dir-gallery-actions">
        <button
          className="btn btn-ghost btn-sm"
          data-tooltip="Download"
          onClick={e => { e.stopPropagation(); onDownload(f); }}
        >↓</button>
      </div>
    </div>
  );
}

export default function DirectoryPage() {
  const { slug } = useParams();

  const [state, setState] = useState("loading"); // loading | error | ready
  const [data, setData] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewsEnabled, setPreviewsEnabled] = useState(true);
  const [lightbox, setLightbox] = useState(null); // { media, idx }
  const [dlAllLabel, setDlAllLabel] = useState("Download all");
  const [dlAllDisabled, setDlAllDisabled] = useState(false);
  const [dlNote, setDlNote] = useState("");
  const [saving, setSaving] = useState(false);

  const fragKeyRef = useRef(getFragmentKey());
  const queryKeyRef = useRef(getQueryKey());

  useEffect(() => {
    if (!slug) { setState("error"); return; }
    Promise.all([
      fetch(`/d/${slug}/info`),
      fetch(`/d/${slug}/preview-manifest`).catch(() => null),
    ]).then(async ([infoResp, manifestResp]) => {
      if (!infoResp.ok) throw new Error();
      const d = await infoResp.json();
      let pm = null;
      if (manifestResp?.ok) pm = await manifestResp.json();
      setData(d);
      setPreviewData(pm);
      document.title = `${d.title} — Oxymoron`;
      setState("ready");
    }).catch(() => setState("error"));
  }, [slug]);

  const enc = data?.encryption_mode || "none";
  const fragKey = fragKeyRef.current;
  const queryKey = queryKeyRef.current;

  async function ensureKey() {
    if (enc === "client" && !fragKeyRef.current) {
      const k = await showPrompt({
        title: "End-to-end encrypted",
        message: "Paste the folder key — the part after #ek= in the share link.",
        placeholder: "decryption key", glyph: "🔒", confirmText: "Unlock",
      });
      if (k && k.trim()) fragKeyRef.current = k.trim();
    } else if (enc === "server" && !queryKeyRef.current) {
      const k = await showPrompt({
        title: "Encrypted folder",
        message: "Paste the access key — the part after ?ek= in the share link.",
        placeholder: "access key", glyph: "🔐", confirmText: "Unlock",
      });
      if (k && k.trim()) queryKeyRef.current = k.trim();
    }
    return enc === "client" ? !!fragKeyRef.current : enc === "server" ? !!queryKeyRef.current : true;
  }

  async function downloadOne(f) {
    if (!(await ensureKey())) return;
    if (enc === "client") {
      const fk = fragKeyRef.current;
      try {
        const resp = await fetch(`/file/${f.slug}/raw`);
        if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
        const ct = await resp.arrayBuffer();
        const keyBytes = b64urlDecode(fk);
        if (keyBytes.length !== 32) throw new Error("wrong key length — check the full #ek= value");
        const pt = await clientDecrypt(ct, keyBytes);
        saveBlob(new Blob([pt]), f.filename);
      } catch (err) {
        showAlert({ title: "Couldn't open file", message: err.message, glyph: "🔒", kind: "error" });
      }
    } else if (enc === "server") {
      window.location.href = `/file/${f.slug}/raw?ek=${encodeURIComponent(queryKeyRef.current)}`;
    } else {
      window.location.href = `/file/${f.slug}/raw`;
    }
  }

  async function downloadAll() {
    if (!(await ensureKey())) return;
    if (enc !== "client") {
      const ek = enc === "server" ? `?ek=${encodeURIComponent(queryKeyRef.current)}` : "";
      window.location.href = `/d/${slug}/zip${ek}`;
      return;
    }
    // Client-side: decrypt each file, build zip
    setDlAllDisabled(true);
    let keyBytes;
    try {
      keyBytes = b64urlDecode(fragKeyRef.current);
      if (keyBytes.length !== 32) throw new Error("wrong key length");
    } catch (err) {
      setDlAllDisabled(false);
      return showAlert({ title: "Bad key", message: err.message, glyph: "🔒", kind: "error" });
    }

    const entries = [];
    try {
      for (let i = 0; i < data.files.length; i++) {
        const f = data.files[i];
        setDlNote(`Decrypting ${i + 1} / ${data.files.length} — ${f.filename}`);
        const resp = await fetch(`/file/${f.slug}/raw`);
        if (!resp.ok) throw new Error(`${f.filename}: HTTP ${resp.status}`);
        const ct = await resp.arrayBuffer();
        const pt = await clientDecrypt(ct, keyBytes);
        entries.push({ name: f.filename, data: new Uint8Array(pt) });
      }
      setDlNote("Packaging .zip…");
      const zip = buildZip(entries);
      saveBlob(zip, `${data.title || "bundle"}.zip`);
      setDlNote(`✓ Downloaded ${entries.length} files.`);
      showToast("Bundle ready.");
    } catch (err) {
      setDlNote("");
      showAlert({ title: "Bundle failed", message: err.message, glyph: "🔒", kind: "error" });
    } finally {
      setDlAllDisabled(false);
    }
  }

  async function saveFolder() {
    setSaving(true);
    const resp = await apiFetch(`/d/${slug}/save`, { method: "POST" });
    setSaving(false);
    if (resp.ok) showToast("Folder saved to your files.");
    else {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Folder save failed.", "error");
    }
  }

  // Build previewable media list
  const previewableMedia = [];
  const filePreviewIdx = new Map();
  if (previewData && previewsEnabled && enc === "none") {
    const groups = previewData.groups || {};
    for (const [group, files] of Object.entries(groups)) {
      for (const f of files) {
        if (f.preview_url && (group === "images" || group === "videos")) {
          filePreviewIdx.set(f.slug, previewableMedia.length);
          previewableMedia.push({ f, group });
        }
      }
    }
  }

  if (state === "loading") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "700px", marginTop: "80px", textAlign: "center" }}>
          <div style={{ fontSize: "32px" }}>⟳</div>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "700px", marginTop: "80px" }}>
          <div id="error-state" className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>😕</div>
            <h2 style={{ margin: "0 0 8px" }}>Folder not found</h2>
            <p className="text-sm text-muted">This link doesn't exist or has been removed.</p>
          </div>
        </div>
      </div>
    );
  }

  const haveKey = enc === "client" ? !!fragKey : enc === "server" ? !!queryKey : true;
  const encBannerKind = haveKey ? "info" : "error";
  let encBannerMsg = null;
  if (enc === "client") {
    encBannerMsg = haveKey
      ? "🔒 End-to-end encrypted. The key is in this link (#ek=) — every file is decrypted in your browser; the server never sees it."
      : "🔒 End-to-end encrypted, but this link is missing its key (#ek=). You need the full link to open these files.";
  } else if (enc === "server") {
    encBannerMsg = haveKey
      ? "🔐 Server-encrypted. The access key (?ek=) in this link unlocks the whole folder."
      : "🔐 Server-encrypted. This link is missing its access key (?ek=) — without it downloads are blocked.";
  }

  const showPreviewGroups = previewData && previewsEnabled && enc === "none";

  return (
    <div className="page-wrap">
      <div className="container" style={{ maxWidth: "800px" }}>
        <div id="dir-state">
          {encBannerMsg && (
            <div className={`alert alert-${encBannerKind}`} id="enc-banner" style={{ marginBottom: "22px" }}>{encBannerMsg}</div>
          )}

          <div style={{ marginBottom: "24px" }}>
            <h1 id="dir-title" style={{ margin: "0 0 6px" }}>{data.title}</h1>
            <div style={{ display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
              <span id="dir-count" className="text-sm text-muted">
                {data.file_count} file{data.file_count !== 1 ? "s" : ""}
              </span>
              <span id="dir-size" className="text-sm text-muted">{formatBytes(data.total_bytes)}</span>
              <span id="dir-enc" className="text-sm text-muted">
                {enc === "client" ? "end-to-end encrypted" : enc === "server" ? "server-encrypted" : "unencrypted"}
              </span>
            </div>
          </div>

          {/* Toolbar */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
            <button
              id="dl-all"
              className="btn btn-primary"
              disabled={dlAllDisabled || !data.files.length}
              onClick={downloadAll}
            >
              {dlAllLabel}
            </button>
            {previewData && (
              <button
                id="toggle-previews"
                className="btn btn-ghost"
                onClick={() => setPreviewsEnabled(p => !p)}
              >
                {previewsEnabled ? "Disable previews" : "Enable previews"}
              </button>
            )}
            {isLoggedIn() && (
              <button id="save-folder" className="btn btn-ghost" disabled={saving} onClick={saveFolder}>
                {saving ? "Saving…" : "Save to my files"}
              </button>
            )}
          </div>

          {dlNote && (
            <div id="dl-note" className="text-sm text-muted" style={{ marginBottom: "12px" }}>{dlNote}</div>
          )}

          {/* Manifest */}
          <div id="dir-manifest">
            {data.files.length === 0 && (
              <div className="empty">This folder is empty.</div>
            )}

            {data.files.length > 0 && !showPreviewGroups && (
              <>
                {data.files.map((f, i) => (
                  <div key={f.slug} className="dir-row">
                    <span className="dir-row-idx">{String(i + 1).padStart(2, "0")}</span>
                    <span className="dir-row-icon">{fileIcon(f.content_type)}</span>
                    <span className="dir-row-name" title={f.filename}>{f.filename}</span>
                    <span className="dir-row-size">{formatBytes(f.size_bytes)}</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      data-tooltip="Download this file"
                      onClick={() => downloadOne(f)}
                    >↓</button>
                  </div>
                ))}
              </>
            )}

            {data.files.length > 0 && showPreviewGroups && (
              <>
                {Object.entries(previewData.groups || {})
                  .filter(([, files]) => files.length > 0)
                  .map(([group, files]) => (
                    <section key={group} className="dir-section">
                      <div className="dir-section-title">{GROUP_LABELS[group] || group} ({files.length})</div>
                      <div className="dir-gallery">
                        {files.map(f => {
                          const pIdx = filePreviewIdx.has(f.slug) ? filePreviewIdx.get(f.slug) : -1;
                          return (
                            <GalleryTile
                              key={f.slug}
                              f={f}
                              group={group}
                              previewIdx={pIdx}
                              onDownload={downloadOne}
                              onOpenLightbox={idx => setLightbox({ media: previewableMedia, idx })}
                            />
                          );
                        })}
                      </div>
                    </section>
                  ))
                }
              </>
            )}
          </div>
        </div>
      </div>

      {lightbox && (
        <Lightbox
          media={lightbox.media}
          startIdx={lightbox.idx}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
