import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, formatBytes, isLoggedIn } from "../lib/api";
import { b64urlDecodeBytes } from "../lib/keys";
import { clientDecrypt, saveBlob } from "../lib/crypto";
import { buildZip } from "../lib/zip";
import { fileIcon } from "../lib/fileIcon";
import { useToast } from "../providers/ToastProvider";
import { useDialog } from "../providers/DialogProvider";
import { PublicShell, PublicBanner } from "../components/PublicShell";
import { Button } from "../components/Button";
import { Card, EmptyState, Eyebrow, Spinner } from "../components/primitives";

interface DirFile {
  slug: string;
  filename: string;
  size_bytes: number;
  content_type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}
interface DirInfo {
  title: string;
  file_count: number;
  total_bytes: number;
  encryption_mode: string;
  files: DirFile[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PreviewData = { groups: Record<string, any[]> } | null;

const GROUP_LABELS: Record<string, string> = {
  images: "Images",
  videos: "Videos",
  audio: "Audio",
  text: "Text",
  pdfs: "PDFs",
  archives: "Archives",
  other: "Other files",
};

export function DirectoryPage() {
  const { slug = "" } = useParams();
  const { showToast } = useToast();
  const dialog = useDialog();

  const [data, setData] = useState<DirInfo | null>(null);
  const [preview, setPreview] = useState<PreviewData>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [previewsEnabled, setPreviewsEnabled] = useState(true);
  const [dlNote, setDlNote] = useState("");
  const [dlAllBusy, setDlAllBusy] = useState(false);
  const [busyFile, setBusyFile] = useState<string>("");

  const fragKey = useRef<string | null>(null);
  const queryKey = useRef<string | null>(null);
  const enc = data?.encryption_mode || "none";

  useEffect(() => {
    const m = window.location.hash.match(/[#&]ek=([^&]*)/);
    fragKey.current = m ? m[1] : null;
    queryKey.current = new URLSearchParams(window.location.search).get("ek");
  }, []);

  useEffect(() => {
    if (!slug) return setStatus("error");
    (async () => {
      try {
        const resp = await fetch(`/d/${slug}/info`);
        if (!resp.ok) return setStatus("error");
        const info: DirInfo = await resp.json();
        setData(info);
        document.title = `${info.title} — Oxymoron`;
        try {
          const m = await fetch(`/d/${slug}/preview-manifest`);
          if (m.ok) setPreview(await m.json());
        } catch {
          /* ignore */
        }
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    })();
  }, [slug]);

  const ensureKey = useCallback(async (): Promise<boolean> => {
    if (enc === "client" && !fragKey.current) {
      const k = await dialog.prompt({
        title: "End-to-end encrypted",
        message: "Paste the folder key — the part after #ek= in the share link.",
        placeholder: "decryption key",
        glyph: "🔒",
        confirmText: "Unlock",
      });
      if (k && k.trim()) fragKey.current = k.trim();
    } else if (enc === "server" && !queryKey.current) {
      const k = await dialog.prompt({
        title: "Encrypted folder",
        message: "Paste the access key — the part after ?ek= in the share link.",
        placeholder: "access key",
        glyph: "🔐",
        confirmText: "Unlock",
      });
      if (k && k.trim()) queryKey.current = k.trim();
    }
    return enc === "client" ? !!fragKey.current : enc === "server" ? !!queryKey.current : true;
  }, [enc, dialog]);

  async function downloadOne(f: DirFile) {
    if (!(await ensureKey())) return;
    if (enc === "client") {
      setBusyFile(f.slug);
      try {
        const resp = await fetch(`/file/${f.slug}/raw`);
        if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
        const ct = await resp.arrayBuffer();
        const keyBytes = b64urlDecodeBytes(fragKey.current!);
        if (keyBytes.length !== 32) throw new Error("wrong key length — check the full #ek= value");
        const pt = await clientDecrypt(ct, keyBytes);
        saveBlob(new Blob([pt]), f.filename);
      } catch (err) {
        dialog.alert({ title: "Couldn't open file", message: (err as Error).message, glyph: "🔒", kind: "error" });
      } finally {
        setBusyFile("");
      }
    } else if (enc === "server") {
      window.location.href = `/file/${f.slug}/raw?ek=${encodeURIComponent(queryKey.current!)}`;
    } else {
      window.location.href = `/file/${f.slug}/raw`;
    }
  }

  async function downloadAll() {
    if (!data || !(await ensureKey())) return;
    if (enc !== "client") {
      const ek = enc === "server" ? `?ek=${encodeURIComponent(queryKey.current!)}` : "";
      window.location.href = `/d/${slug}/zip${ek}`;
      return;
    }
    setDlAllBusy(true);
    setDlNote("");
    let keyBytes: Uint8Array;
    try {
      keyBytes = b64urlDecodeBytes(fragKey.current!);
      if (keyBytes.length !== 32) throw new Error("wrong key length");
    } catch (err) {
      setDlAllBusy(false);
      return dialog.alert({ title: "Bad key", message: (err as Error).message, glyph: "🔒", kind: "error" });
    }
    const entries: { name: string; data: Uint8Array }[] = [];
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
      saveBlob(buildZip(entries), `${data.title || "bundle"}.zip`);
      setDlNote(`✓ Downloaded ${entries.length} files.`);
      showToast("Bundle ready.");
    } catch (err) {
      setDlNote("");
      dialog.alert({ title: "Bundle failed", message: (err as Error).message, glyph: "🔒", kind: "error" });
    } finally {
      setDlAllBusy(false);
    }
  }

  async function saveFolder() {
    const resp = await apiFetch(`/d/${slug}/save`, { method: "POST" });
    if (resp.ok) showToast("Folder saved to your files.");
    else {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Folder save failed.", "error");
    }
  }

  if (status === "loading")
    return (
      <PublicShell>
        <EmptyState icon={<Spinner />}>Opening folder…</EmptyState>
      </PublicShell>
    );
  if (status === "error" || !data)
    return (
      <PublicShell>
        <Card className="text-center">
          <div className="text-4xl">🔗</div>
          <div className="mt-2 font-[var(--font-display)] text-lg font-semibold text-[var(--color-ink)]">Folder not found</div>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">This share link is invalid or has expired.</p>
        </Card>
      </PublicShell>
    );

  const haveKey = enc === "client" ? !!fragKey.current : enc === "server" ? !!queryKey.current : true;

  return (
    <PublicShell>
      <div className="reveal mb-6">
        <Eyebrow>Shared folder</Eyebrow>
        <h1 className="mt-1 font-[var(--font-display)] text-2xl font-bold text-[var(--color-ink)]">{data.title}</h1>
        <div className="mt-1 flex flex-wrap gap-3 font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">
          <span>{data.file_count} file{data.file_count !== 1 ? "s" : ""}</span>
          <span>{formatBytes(data.total_bytes)}</span>
          <span>{enc === "client" ? "end-to-end encrypted" : enc === "server" ? "server-encrypted" : "unencrypted"}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={downloadAll} disabled={!data.files.length || dlAllBusy}>
            {dlAllBusy ? "Working…" : "↓ Download all (.zip)"}
          </Button>
          {preview && (
            <Button variant="ghost" onClick={() => setPreviewsEnabled((v) => !v)}>
              {previewsEnabled ? "Disable previews" : "Enable previews"}
            </Button>
          )}
          {isLoggedIn() && (
            <Button variant="ghost" onClick={saveFolder}>
              Save to my files
            </Button>
          )}
        </div>
        {dlNote && <div className="mt-2 text-sm text-[var(--color-ink-muted)]">{dlNote}</div>}
      </div>

      {enc !== "none" && (
        <PublicBanner tone={haveKey ? "info" : "error"}>
          {enc === "client"
            ? haveKey
              ? "🔒 End-to-end encrypted. The key is in this link (#ek=) — every file is decrypted in your browser; the server never sees it."
              : "🔒 End-to-end encrypted, but this link is missing its key (#ek=). You need the full link to open these files."
            : haveKey
              ? "🔐 Server-encrypted. The access key (?ek=) in this link unlocks the whole folder."
              : "🔐 Server-encrypted. This link is missing its access key (?ek=) — without it downloads are blocked."}
        </PublicBanner>
      )}

      {!data.files.length ? (
        <EmptyState icon="📂">This folder is empty.</EmptyState>
      ) : preview && previewsEnabled ? (
        <div className="space-y-6">
          {Object.entries(preview.groups || {}).map(([group, files]) =>
            files.length ? (
              <section key={group}>
                <div className="mb-2 font-[var(--font-mono)] text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
                  {GROUP_LABELS[group] || group} ({files.length})
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {files.map((f: DirFile) => (
                    <Card key={f.slug} className="flex flex-col gap-2 p-3">
                      <div className="grid h-28 place-items-center overflow-hidden rounded-[var(--radius-field)] bg-[var(--color-surface-2)] text-3xl">
                        {group === "images" && enc === "none" ? (
                          <img src={f.preview_url} alt={f.filename} className="h-full w-full object-cover" />
                        ) : group === "videos" && enc === "none" ? (
                          <video src={f.preview_url} preload="metadata" muted className="h-full w-full object-cover" />
                        ) : group === "archives" ? (
                          <span className="text-xs text-[var(--color-ink-muted)]">
                            {f.preview?.status === "readable"
                              ? `${f.preview.entry_count || f.preview.entries?.length || 0} entries`
                              : "Cannot read preview"}
                          </span>
                        ) : (
                          fileIcon(f.content_type)
                        )}
                      </div>
                      <div className="truncate text-sm text-[var(--color-ink)]" title={f.filename}>
                        {f.filename}
                      </div>
                      <div className="font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">{formatBytes(f.size_bytes)}</div>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => downloadOne(f)} disabled={busyFile === f.slug}>
                          {busyFile === f.slug ? "…" : "Download"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => window.open(`/file/${f.slug}`, "_blank", "noopener")}>
                          Open
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            ) : null,
          )}
        </div>
      ) : (
        <Card className="p-0 overflow-hidden divide-y divide-[var(--color-line)]">
          {data.files.map((f, i) => (
            <div key={f.slug} className="flex items-center gap-3 px-3 py-2.5">
              <span className="w-6 font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-base">{fileIcon(f.content_type)}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink)]" title={f.filename}>
                {f.filename}
              </span>
              <span className="font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">{formatBytes(f.size_bytes)}</span>
              <Button size="sm" variant="ghost" onClick={() => downloadOne(f)} disabled={busyFile === f.slug}>
                {busyFile === f.slug ? "…" : "↓"}
              </Button>
            </div>
          ))}
        </Card>
      )}
    </PublicShell>
  );
}
