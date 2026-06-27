import { formatBytes, isLoggedIn } from "../../../lib/api";
import { fileIcon } from "../../../lib/fileIcon";
import { PublicShell, PublicBanner } from "../../../components/layout/PublicShell";
import { Button } from "../../../components/ui/Button";
import { Card, EmptyState, Eyebrow, Spinner } from "../../../components/ui/primitives";
import type { DirFile } from "../services/directoryService";
import { useDirectory } from "../hooks/useDirectory";

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
  const {
    data, preview, status, enc, haveKey,
    previewsEnabled, setPreviewsEnabled,
    dlNote, dlAllBusy, busyFile,
    downloadOne, downloadAll, saveFolder,
  } = useDirectory();

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
