import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isLoggedIn, apiFetch, formatBytes } from '../lib/api.js';
import { showToast } from '../lib/toast.js';
import { showAlert, showPrompt } from '../lib/dialog.js';

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

function saveBlob(bytes, filename) {
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }
  return <button className="btn btn-ghost btn-sm" onClick={copy}>{copied ? "Copied!" : label}</button>;
}

function PreviewSection({ ct, rawSrc, filename, limitedUse }) {
  const [text, setText] = useState(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const previewable = ct !== "none" && !ct.includes("text/html") && !ct.includes("svg");
  const previewableNow = previewable && !limitedUse;

  useEffect(() => {
    if (!previewableNow) return;
    if (ct.startsWith("text/") && !ct.includes("html")) {
      fetch(rawSrc)
        .then(r => { if (!r.ok) throw new Error(); return r.text(); })
        .then(t => {
          if (t.length > 65536) { setText(t.slice(0, 65536)); setTextTruncated(true); }
          else setText(t);
        })
        .catch(() => setText(null));
    }
  }, [previewableNow, rawSrc, ct]);

  if (!previewableNow) {
    if (limitedUse) return (
      <div className="alert alert-info" style={{ marginBottom: "24px" }}>
        Preview unavailable for limited-use links — download to view.
      </div>
    );
    return null;
  }

  if (ct.startsWith("image/")) {
    return (
      <div className="preview-wrap">
        <div className="preview-header">
          <span className="preview-label">Preview</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{ct}</span>
        </div>
        <div className="preview-body">
          <img alt={filename} src={rawSrc} style={{ display: "block", maxWidth: "100%", maxHeight: "480px", objectFit: "contain", margin: "0 auto" }} />
        </div>
      </div>
    );
  }
  if (ct.startsWith("video/")) {
    return (
      <div className="preview-wrap">
        <div className="preview-header">
          <span className="preview-label">Preview</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{ct}</span>
        </div>
        <div className="preview-body">
          <video controls preload="metadata" style={{ width: "100%", maxHeight: "480px", display: "block", background: "#000" }}>
            <source src={rawSrc} type={ct} />
          </video>
        </div>
      </div>
    );
  }
  if (ct.startsWith("audio/")) {
    return (
      <div className="preview-wrap">
        <div className="preview-header">
          <span className="preview-label">Preview</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{ct}</span>
        </div>
        <div className="preview-body" style={{ background: "var(--surface-2)" }}>
          <audio controls preload="metadata" style={{ width: "100%", display: "block", padding: "16px" }}>
            <source src={rawSrc} type={ct} />
          </audio>
        </div>
      </div>
    );
  }
  if (ct.startsWith("text/") && !ct.includes("html")) {
    if (text === null) return null;
    return (
      <div className="preview-wrap">
        <div className="preview-header">
          <span className="preview-label">Preview</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{ct}</span>
        </div>
        <div className="preview-body">
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {text}
            {textTruncated && "\n\n[… truncated at 64 KB]"}
          </pre>
        </div>
      </div>
    );
  }
  if (ct === "application/pdf") {
    return (
      <div className="preview-wrap">
        <div className="preview-header">
          <span className="preview-label">Preview</span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{ct}</span>
        </div>
        <div className="preview-body">
          <iframe src={rawSrc} sandbox="allow-same-origin" title={filename} style={{ width: "100%", height: "600px", border: "none", display: "block" }} />
        </div>
      </div>
    );
  }
  return null;
}

export default function DownloadPage() {
  const { slug } = useParams();

  const [state, setState] = useState("loading"); // loading | error | ready
  const [info, setInfo] = useState(null);
  const [dlLabel, setDlLabel] = useState("Download");
  const [dlDisabled, setDlDisabled] = useState(false);
  const [dlHref, setDlHref] = useState(null);
  const [dlClick, setDlClick] = useState(null);
  const [saving, setSaving] = useState(false);
  const [encMsg, setEncMsg] = useState(null);
  const [encMsgKind, setEncMsgKind] = useState("info");

  const fragmentKeyRef = useRef(getFragmentKey());
  const queryKeyRef = useRef(getQueryKey());

  useEffect(() => {
    if (!slug) { setState("error"); return; }
    fetch(`/file/${slug}/info`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setInfo(d); setState("ready"); })
      .catch(() => setState("error"));
  }, [slug]);

  useEffect(() => {
    if (!info || state !== "ready") return;
    const ct = (info.content_type || "").toLowerCase();
    document.title = `${info.filename} — Oxymoron`;

    const fragKey = fragmentKeyRef.current;
    const queryKey = queryKeyRef.current;
    const encMode = info.encryption_mode || "none";
    const needsKey = (encMode === "client" && !fragKey) || (encMode === "server" && !queryKey);
    const rawUrl = `${location.origin}/file/${slug}/raw`;

    if (encMode === "client") {
      if (fragKey) {
        setEncMsg("🔒 End-to-end encrypted. The key is in this link (#ek=) — your browser decrypts locally; the server never sees it.");
      } else {
        setEncMsg("🔒 End-to-end encrypted, but this link has no key (#ek=). You need the full link to decrypt.");
        setEncMsgKind("error");
      }
    } else if (encMode === "server") {
      if (queryKey) {
        setEncMsg("🔐 Server-side encrypted. The access key (?ek=) in this link unlocks the download.");
      } else {
        setEncMsg("🔐 Server-side encrypted. This link is missing its access key (?ek=) — without it the download is blocked.");
        setEncMsgKind("error");
      }
    }

    const remaining = info.max_uses != null ? info.max_uses - info.use_count : null;
    const linkDead = remaining != null && remaining <= 0;
    if (linkDead) {
      setDlLabel("Link exhausted");
      setDlDisabled(true);
      return;
    }

    if (encMode === "client" && fragKey) {
      setDlLabel("Download");
      setDlClick(() => () => doClientDecrypt(fragKey, info.filename));
    } else if (encMode === "server" && queryKey) {
      setDlHref(`${rawUrl}?ek=${encodeURIComponent(queryKey)}`);
    } else if (encMode === "client" || encMode === "server") {
      setDlLabel("🔑 Enter key to download");
      setDlClick(() => () => requestKeyAndDownload(encMode, rawUrl, info.filename));
    } else {
      setDlHref(rawUrl);
    }

    if (needsKey && !linkDead) {
      setTimeout(() => requestKeyAndDownload(encMode, rawUrl, info.filename), 250);
    }
  }, [info, state, slug]);

  async function doClientDecrypt(fragKey, filename) {
    setDlLabel("⟳ Decrypting…");
    setDlDisabled(true);
    try {
      let keyBytes;
      try { keyBytes = b64urlDecode(fragKey); }
      catch { throw new Error("the key in the URL is malformed"); }
      if (keyBytes.length !== 32) throw new Error("wrong key length — check the full #ek= value was copied");

      const resp = await fetch(`/file/${slug}/raw`);
      if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
      const ciphertext = await resp.arrayBuffer();

      const plaintext = await new Promise((resolve, reject) => {
        const worker = new Worker("/aead-worker.js");
        worker.onmessage = (e) => {
          if (e.data.type === "progress") {
            setDlLabel(`⟳ Decrypting… ${e.data.percent}%`);
            return;
          }
          worker.terminate();
          if (e.data.type === "decrypted") resolve(e.data.plaintext);
          else reject(new Error(e.data.message || "decryption failed — wrong key?"));
        };
        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "worker error")); };
        worker.postMessage({ type: "decrypt", ciphertext, key: keyBytes }, [ciphertext]);
      });

      saveBlob(plaintext, filename);
    } catch (err) {
      showAlert({ title: "Decryption failed", message: err.message, glyph: "🔒", kind: "error" });
    } finally {
      setDlLabel("Download");
      setDlDisabled(false);
    }
  }

  async function requestKeyAndDownload(encMode, rawUrl, filename) {
    if (encMode === "client") {
      const k = await showPrompt({
        title: "End-to-end encrypted",
        message: "This file is encrypted in your browser. Paste the decryption key — the part after #ek= in the share link.",
        placeholder: "decryption key",
        glyph: "🔒",
        confirmText: "Decrypt & download",
      });
      if (k && k.trim()) doClientDecrypt(k.trim(), filename);
    } else if (encMode === "server") {
      const k = await showPrompt({
        title: "Encrypted file",
        message: "This file needs an access key to download. Paste the part after ?ek= in the share link.",
        placeholder: "access key",
        glyph: "🔐",
        confirmText: "Unlock & download",
      });
      if (k && k.trim()) window.location.href = `${rawUrl}?ek=${encodeURIComponent(k.trim())}`;
    }
  }

  async function handleSave() {
    setSaving(true);
    const resp = await apiFetch(`/files/${slug}/save`, { method: "POST" });
    setSaving(false);
    if (resp.ok) showToast("Saved to your files.");
    else {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Save failed.", "error");
    }
  }

  if (state === "loading") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "600px", marginTop: "80px", textAlign: "center" }}>
          <div style={{ fontSize: "32px" }}>⟳</div>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="page-wrap">
        <div className="container" style={{ maxWidth: "600px", marginTop: "80px" }}>
          <div id="error-state" className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>😕</div>
            <h2 style={{ margin: "0 0 8px" }}>File not found</h2>
            <p className="text-sm text-muted">This link doesn't exist or has been removed.</p>
          </div>
        </div>
      </div>
    );
  }

  const ct = (info.content_type || "").toLowerCase();
  const encMode = info.encryption_mode || "none";
  const fragKey = fragmentKeyRef.current;
  const queryKey = queryKeyRef.current;
  const rawUrl = `${location.origin}/file/${slug}/raw`;
  let shareUrl = `${location.origin}/file/${slug}`;
  if (encMode === "server" && queryKey) shareUrl += `?ek=${encodeURIComponent(queryKey)}`;
  if (encMode === "client" && fragKey) shareUrl += `#ek=${encodeURIComponent(fragKey)}`;
  let displayRawUrl = rawUrl;
  if (encMode === "server" && queryKey) displayRawUrl += `?ek=${encodeURIComponent(queryKey)}`;
  const rawSrc = encMode === "server" && queryKey
    ? `${rawUrl}?ek=${encodeURIComponent(queryKey)}`
    : `${location.origin}/file/${slug}/preview`;

  const remaining = info.max_uses != null ? info.max_uses - info.use_count : null;
  const limitedUse = info.max_uses != null;

  const hashes = Object.entries(info.hashes || {}).filter(([, v]) => v);

  return (
    <div className="page-wrap">
      <div className="container" style={{ maxWidth: "680px" }}>
        <div id="file-state">
          {encMsg && (
            <div className={`alert alert-${encMsgKind}`} style={{ marginBottom: "20px" }}>{encMsg}</div>
          )}

          <div className="card" style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "12px" }}>
              <span id="dl-type-icon" style={{ fontSize: "36px", flexShrink: 0 }}>{fileTypeIcon(ct)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div id="dl-filename" style={{ fontWeight: 600, fontSize: "17px", wordBreak: "break-word" }}>{info.filename}</div>
                <div style={{ display: "flex", gap: "12px", marginTop: "4px", flexWrap: "wrap" }}>
                  <span id="dl-size" className="text-sm text-muted">{formatBytes(info.size_bytes)}</span>
                  <span id="dl-type" className="text-sm text-muted">{ct || "unknown type"}</span>
                </div>
                {remaining != null && (
                  <div id="dl-uses" className="text-sm" style={{ marginTop: "4px", color: remaining <= 0 ? "var(--danger)" : "var(--text-muted)" }}>
                    {remaining > 0 ? `${remaining} download${remaining !== 1 ? "s" : ""} remaining` : "No downloads remaining"}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {dlHref ? (
                <a
                  id="dl-button"
                  className="btn btn-primary"
                  href={dlHref}
                  download
                >
                  {dlLabel}
                </a>
              ) : (
                <button
                  id="dl-button"
                  className="btn btn-primary"
                  disabled={dlDisabled}
                  onClick={dlClick || undefined}
                >
                  {dlLabel}
                </button>
              )}
              {isLoggedIn() && (
                <button id="save-file" className="btn btn-ghost" disabled={saving} onClick={handleSave}>
                  {saving ? "Saving…" : "Save to my files"}
                </button>
              )}
              <button id="open-link" className="btn btn-ghost" onClick={() => window.open(shareUrl, "_blank", "noopener")}>Open ↗</button>
            </div>
          </div>

          {/* Preview */}
          <PreviewSection ct={ct} rawSrc={rawSrc} filename={info.filename} limitedUse={limitedUse} />

          {/* URLs */}
          <div className="card" style={{ marginBottom: "20px" }}>
            <div style={{ marginBottom: "12px" }}>
              <div className="text-xs text-muted" style={{ marginBottom: "4px" }}>Share URL</div>
              <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <code id="share-url" style={{ flex: 1, fontSize: "12px", wordBreak: "break-all", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {shareUrl}
                </code>
                <CopyBtn text={shareUrl} label="Copy" />
                <CopyBtn text={`[${info.filename}](${shareUrl})`} label="Markdown" />
                <CopyBtn text={`<a href="${shareUrl}">${info.filename}</a>`} label="HTML" />
              </div>
            </div>
            <div>
              <div className="text-xs text-muted" style={{ marginBottom: "4px" }}>Raw URL</div>
              <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <code id="raw-url" style={{ flex: 1, fontSize: "12px", wordBreak: "break-all", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {displayRawUrl}
                </code>
                <CopyBtn text={displayRawUrl} label="Copy" />
              </div>
              <div className="text-xs text-muted" style={{ marginTop: "6px" }}>
                <code id="curl-cmd" style={{ fontFamily: "var(--font-mono)" }}>
                  curl -L -O "{displayRawUrl}"
                </code>
                <CopyBtn text={`curl -L -O "${displayRawUrl}"`} label="Copy" />
              </div>
            </div>
          </div>

          {/* Hashes */}
          {hashes.length > 0 && (
            <HashSection hashes={Object.fromEntries(hashes)} />
          )}
        </div>
      </div>
    </div>
  );
}

function HashSection({ hashes }) {
  const entries = Object.entries(hashes);
  const [selected, setSelected] = useState(entries[0]?.[0] || "");
  return (
    <div id="hash-wrap" className="card">
      <div className="text-xs text-muted" style={{ marginBottom: "6px" }}>File hashes</div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <select id="hash-select" value={selected} onChange={e => setSelected(e.target.value)}>
          {entries.map(([name]) => (
            <option key={name} value={name}>{name.toUpperCase()}</option>
          ))}
        </select>
        <code id="hash-value" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", wordBreak: "break-all" }}>
          {hashes[selected] || ""}
        </code>
      </div>
    </div>
  );
}
