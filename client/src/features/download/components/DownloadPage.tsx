import { useEffect, useState } from "react";
import { formatBytes, isLoggedIn } from "../../../lib/api";
import { fileIcon } from "../../../lib/fileIcon";
import { useToast } from "../../../providers/ToastProvider";
import { PublicShell, PublicBanner } from "../../../components/layout/PublicShell";
import { Button } from "../../../components/ui/Button";
import { Card, EmptyState, Select, Spinner } from "../../../components/ui/primitives";
import { fetchTextPreview } from "../services/downloadService";
import { useDownload } from "../hooks/useDownload";

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1.5 pl-3">
      <span className="w-12 shrink-0 font-[var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)]">
        {label}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-dim)] ${mono ? "font-[var(--font-mono)]" : ""}`}>
        {value}
      </span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(value).catch(() => {});
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        className="shrink-0 rounded-[8px] border border-[var(--color-line)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
      >
        {done ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

function Preview({ ct, src, filename }: { ct: string; src: string; filename: string }) {
  const [text, setText] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const isText = ct.startsWith("text/") && !ct.includes("html");

  useEffect(() => {
    if (!isText) return;
    fetchTextPreview(src)
      .then((t) => setText(t.length > 65536 ? t.slice(0, 65536) + "\n\n[… truncated at 64 KB]" : t))
      .catch(() => setDead(true));
  }, [src, isText]);

  // Never render HTML or SVG inline — XSS risk.
  if (ct.includes("text/html") || ct.includes("svg")) return null;
  if (dead) return null;

  let body: React.ReactNode = null;
  if (ct.startsWith("image/")) {
    body = <img src={src} alt={filename} className="mx-auto block max-h-[480px] max-w-full object-contain" onError={() => setDead(true)} />;
  } else if (ct.startsWith("video/")) {
    body = (
      <video controls preload="metadata" className="block max-h-[480px] w-full bg-black">
        <source src={src} type={ct} />
      </video>
    );
  } else if (ct.startsWith("audio/")) {
    body = (
      <audio controls preload="metadata" className="block w-full p-4">
        <source src={src} type={ct} />
      </audio>
    );
  } else if (isText) {
    body = (
      <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap p-4 font-[var(--font-mono)] text-[12px] text-[var(--color-ink-dim)]">
        {text ?? "Loading preview…"}
      </pre>
    );
  } else if (ct === "application/pdf") {
    body = <iframe src={src} sandbox="allow-same-origin" title={filename} className="block h-[600px] w-full border-0" />;
  } else {
    return null;
  }

  return (
    <Card className="mb-6 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-surface-2)] px-4 py-2">
        <span className="font-[var(--font-mono)] text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">Preview</span>
        <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">{ct}</span>
      </div>
      {body}
    </Card>
  );
}

export function DownloadPage() {
  const { showToast } = useToast();
  const { slug, info, status, hash, setHash, btnBusy, btnLabel, frag, qk, clientDownload, saveFile, dialog } =
    useDownload();

  if (status === "loading")
    return (
      <PublicShell>
        <EmptyState icon={<Spinner />}>Loading…</EmptyState>
      </PublicShell>
    );
  if (status === "error" || !info)
    return (
      <PublicShell>
        <Card className="text-center">
          <div className="text-4xl">🔗</div>
          <div className="mt-2 font-[var(--font-display)] text-lg font-semibold text-[var(--color-ink)]">Link not found</div>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">This share link is invalid or has expired.</p>
        </Card>
      </PublicShell>
    );

  const ct = (info.content_type || "").toLowerCase();
  const rawUrl = `${location.origin}/file/${slug}/raw`;
  const baseShareUrl = `${location.origin}/file/${slug}`;
  const encMode = info.encryption_mode || "none";

  let shareUrl = baseShareUrl;
  if (encMode === "server" && qk) shareUrl += `?ek=${encodeURIComponent(qk)}`;
  if (encMode === "client" && frag) shareUrl += `#ek=${encodeURIComponent(frag)}`;
  let displayRawUrl = rawUrl;
  if (encMode === "server" && qk) displayRawUrl += `?ek=${encodeURIComponent(qk)}`;
  let rawSrc = `${location.origin}/file/${slug}/preview`;
  if (encMode === "server" && qk) rawSrc = `${rawUrl}?ek=${encodeURIComponent(qk)}`;

  const haveKey = encMode === "client" ? !!frag : encMode === "server" ? !!qk : true;
  const needsKey = (encMode === "client" && !frag) || (encMode === "server" && !qk);
  const limitedUse = info.max_uses != null;
  const remaining = info.max_uses != null ? info.max_uses - info.use_count : Infinity;
  const linkDead = limitedUse && remaining <= 0;

  async function requestKeyAndDownload() {
    if (!info) return;
    if (encMode === "client") {
      const k = await dialog.prompt({
        title: "End-to-end encrypted",
        message: "This file is encrypted in your browser. Paste the decryption key — the part after #ek= in the share link.",
        placeholder: "decryption key",
        glyph: "🔒",
        confirmText: "Decrypt & download",
      });
      if (k && k.trim()) clientDownload(k.trim(), info.filename);
    } else if (encMode === "server") {
      const k = await dialog.prompt({
        title: "Encrypted file",
        message: "This file needs an access key to download. Paste the part after ?ek= in the share link.",
        placeholder: "access key",
        glyph: "🔐",
        confirmText: "Unlock & download",
      });
      if (k && k.trim()) window.location.href = `${rawUrl}?ek=${encodeURIComponent(k.trim())}`;
    }
  }

  function onDownloadClick() {
    if (!info || linkDead) return;
    if (encMode === "client" && frag) clientDownload(frag, info.filename);
    else if (encMode === "server" && qk) window.location.href = `${rawUrl}?ek=${encodeURIComponent(qk)}`;
    else if (encMode === "client" || encMode === "server") requestKeyAndDownload();
    else window.location.href = rawUrl;
  }

  const downloadLabel = linkDead
    ? "Link exhausted"
    : needsKey
      ? "🔑 Enter key to download"
      : btnBusy
        ? btnLabel
        : "Download";

  const previewable = encMode === "none";
  const hashEntries = Object.entries(info.hashes || {}).filter(([, v]) => v);

  return (
    <PublicShell>
      {/* Hero */}
      <div className="reveal mb-6 text-center">
        <div className="text-5xl">{fileIcon(ct)}</div>
        <h1 className="mt-3 break-all font-[var(--font-display)] text-2xl font-bold text-[var(--color-ink)]">
          {info.filename}
        </h1>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">
          <span>{formatBytes(info.size_bytes)}</span>
          <span>{ct || "unknown type"}</span>
          {limitedUse && <span>{Math.max(0, remaining)} download{remaining !== 1 ? "s" : ""} remaining</span>}
        </div>
        <div className="mt-5">
          <Button onClick={onDownloadClick} disabled={btnBusy || linkDead} variant={linkDead ? "ghost" : "primary"}>
            {downloadLabel}
          </Button>
        </div>
      </div>

      {encMode !== "none" && (
        <PublicBanner tone={haveKey ? "info" : "error"}>
          {encMode === "client"
            ? haveKey
              ? "🔒 End-to-end encrypted. The key is in this link (#ek=) — your browser decrypts locally; the server never sees it."
              : "🔒 End-to-end encrypted, but this link has no key (#ek=). You need the full link to decrypt."
            : haveKey
              ? "🔐 Server-side encrypted. The access key (?ek=) in this link unlocks the download."
              : "🔐 Server-side encrypted. This link is missing its access key (?ek=) — without it the download is blocked."}
        </PublicBanner>
      )}

      {/* Preview */}
      {!limitedUse && previewable && <Preview ct={ct} src={rawSrc} filename={info.filename} />}
      {limitedUse && remaining > 0 && (
        <PublicBanner tone="info">Preview unavailable for limited-use links — download to view.</PublicBanner>
      )}

      {/* Share & copy */}
      <Card className="space-y-2.5">
        <div className="mb-1 font-[var(--font-mono)] text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
          Share &amp; copy
        </div>
        <div className="flex flex-wrap gap-2">
          {isLoggedIn() && (
            <Button size="sm" variant="ghost" onClick={saveFile}>
              Save to my files
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => window.open(shareUrl, "_blank", "noopener")}>
            Open in new tab
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(`[${info.filename}](${shareUrl})`).catch(() => {}); showToast("Markdown copied."); }}>
            Copy Markdown
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(`<a href="${shareUrl}">${info.filename}</a>`).catch(() => {}); showToast("HTML copied."); }}>
            Copy HTML
          </Button>
        </div>
        <CopyRow label="Share" value={shareUrl} />
        <CopyRow label="Raw" value={displayRawUrl} />
        <CopyRow label="curl" value={`curl -L -O "${displayRawUrl}"`} />
        {hashEntries.length > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <Select value={hash} onChange={(e) => setHash(e.target.value)} className="max-w-[140px]">
              {hashEntries.map(([name]) => (
                <option key={name} value={name}>
                  {name.toUpperCase()}
                </option>
              ))}
            </Select>
            <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[12px] text-[var(--color-ink-muted)]">
              {info.hashes?.[hash] || ""}
            </span>
          </div>
        )}
      </Card>
    </PublicShell>
  );
}
