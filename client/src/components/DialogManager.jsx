import { useEffect, useRef, useState } from 'react';
import { _register } from '../lib/dialog.js';

function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  }
  return (
    <button className="btn btn-ghost btn-sm" onClick={copy}>
      {copied ? "Copied!" : label}
    </button>
  );
}

function AlertDialog({ title, message, glyph, kind, onClose }) {
  const glyphKind = kind === "error" ? "danger" : kind === "success" ? "success" : "";
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); onClose(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          {glyph && <div className={["dialog-glyph", glyphKind].filter(Boolean).join(" ")}>{glyph}</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && <div className="modal-title">{title}</div>}
            {message && <div className="dialog-msg">{message}</div>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" autoFocus onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ title, message, glyph, danger, confirmText, cancelText, onClose }) {
  const computedGlyph = glyph || (danger ? "⚠" : "?");
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onClose(false); }
      else if (e.key === "Enter") { e.preventDefault(); onClose(true); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(false); }}>
      <div className="modal dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <div className={["dialog-glyph", danger ? "danger" : ""].filter(Boolean).join(" ")}>{computedGlyph}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title">{title}</div>
            {message && <div className="dialog-msg">{message}</div>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={() => onClose(false)}>{cancelText}</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={() => onClose(true)}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog({ title, message, glyph, placeholder, defaultValue, confirmText, cancelText, onClose }) {
  const [value, setValue] = useState(defaultValue || "");
  const inputRef = useRef(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onClose(null); }
      else if (e.key === "Enter" && document.activeElement?.tagName === "INPUT") {
        e.preventDefault(); onClose(value);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, value]);

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(null); }}>
      <div className="modal dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          {glyph && <div className="dialog-glyph">{glyph}</div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title">{title}</div>
            {message && <div className="dialog-msg" style={{ whiteSpace: "pre-wrap" }}>{message}</div>}
          </div>
        </div>
        <div className="dialog-input">
          <input
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={e => setValue(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={() => onClose(null)}>{cancelText}</button>
          <button className="btn btn-primary" onClick={() => onClose(value)}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

function CopyModal({ url, filename, encKey, keyLabel, keyHint, hint, onClose }) {
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: "480px" }}>
        <div className="modal-title">Share link</div>
        <div>
          <div style={{
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", padding: "9px 12px", fontSize: "12px",
            wordBreak: "break-all", fontFamily: "var(--font-mono)", color: "var(--text-muted)",
            marginBottom: "10px"
          }}>{url}</div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "4px" }}>
            <CopyBtn text={url} label="Copy link" />
            <CopyBtn text={`[${filename}](${url})`} label="Markdown" />
            <CopyBtn text={`<a href="${url}">${filename}</a>`} label="HTML" />
            <button className="btn btn-ghost btn-sm" onClick={() => window.open(url, "_blank", "noopener")}>Open ↗</button>
          </div>
          {hint && (
            <div style={{ fontSize: "12px", color: "var(--warning)", marginTop: "10px" }}>{hint}</div>
          )}
          {encKey && (
            <>
              <div style={{ borderTop: "1px solid var(--border)", margin: "14px 0 12px" }} />
              {keyHint && <div style={{ fontSize: "12px", color: "var(--warning)", marginBottom: "8px" }}>{keyHint}</div>}
              <div className="text-xs text-muted" style={{ marginBottom: "4px" }}>{keyLabel || "Decryption key"}</div>
              <div style={{
                background: "var(--surface-2)", border: "1px solid var(--border)",
                borderRadius: "var(--radius)", padding: "8px 12px", fontSize: "12px",
                wordBreak: "break-all", fontFamily: "var(--font-mono)", color: "var(--text-muted)",
                marginBottom: "8px"
              }}>{encKey}</div>
              <CopyBtn text={encKey} label="Copy key" />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function DialogManager() {
  const [dialog, setDialog] = useState(null);

  useEffect(() => {
    _register(spec => setDialog(spec));
    return () => _register(null);
  }, []);

  if (!dialog) return null;

  function close(value) {
    const resolve = dialog.resolve;
    setDialog(null);
    resolve(value);
  }

  if (dialog.type === 'alert') {
    return (
      <AlertDialog
        title={dialog.title}
        message={dialog.message}
        glyph={dialog.glyph}
        kind={dialog.kind}
        onClose={() => close(undefined)}
      />
    );
  }

  if (dialog.type === 'confirm') {
    return (
      <ConfirmDialog
        title={dialog.title}
        message={dialog.message}
        glyph={dialog.glyph}
        danger={dialog.danger}
        confirmText={dialog.confirmText}
        cancelText={dialog.cancelText}
        onClose={close}
      />
    );
  }

  if (dialog.type === 'prompt') {
    return (
      <PromptDialog
        title={dialog.title}
        message={dialog.message}
        glyph={dialog.glyph}
        placeholder={dialog.placeholder}
        defaultValue={dialog.defaultValue}
        confirmText={dialog.confirmText}
        cancelText={dialog.cancelText}
        onClose={close}
      />
    );
  }

  if (dialog.type === 'copy') {
    return (
      <CopyModal
        url={dialog.url}
        filename={dialog.filename}
        encKey={dialog.key}
        keyLabel={dialog.keyLabel}
        keyHint={dialog.keyHint}
        hint={dialog.hint}
        onClose={() => close(undefined)}
      />
    );
  }

  return null;
}
