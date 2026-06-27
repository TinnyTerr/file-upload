import { useEffect, useState } from "react";
import { formatBytes, formatDate } from "../../../lib/api";
import { directoryShareUrl, linkUrlWithKey } from "../../../lib/keys";
import { fileIcon } from "../../../lib/fileIcon";
import { Badge, Card, EmptyState, Spinner } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { listDirectoryFiles } from "../services/directoriesService";
import type { DirMember, DirObj, FileObj, LinkObj, Permissions } from "../types";

export interface FilesActions {
  deleteDirectory: (d: DirObj) => void;
  addFilesToDirectory: (d: DirObj) => void;
  removeMember: (dirId: number, fileId: number, name: string) => void;
  openMint: (fileId: number) => void;
  deleteFile: (id: number, name: string) => void;
  setLinkActive: (link: LinkObj, active: boolean) => void;
  deleteLink: (link: LinkObj) => void;
  copy: (text: string) => void;
}

function EncBadge({ mode }: { mode: string }) {
  if (mode === "client")
    return (
      <Badge tone="accent" title="End-to-end encrypted — key lives only in the share link (#ek=)">
        🔒 e2e
      </Badge>
    );
  if (mode === "server")
    return (
      <Badge tone="accent" title="Server-side encrypted — needs the ?ek= access key">
        🔐 server
      </Badge>
    );
  return null;
}

function LinkRow({ lk, f, perms, actions }: { lk: LinkObj; f: FileObj; perms: Permissions; actions: FilesActions }) {
  const now = Date.now();
  const expired = !!lk.expires_at && new Date(lk.expires_at).getTime() < now;
  const usedUp = lk.max_uses != null && lk.use_count >= lk.max_uses;
  const inactive = !lk.active || expired || usedUp;
  const url = linkUrlWithKey(lk.slug, f);

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/50 px-2.5 py-2 ${inactive ? "opacity-60" : ""}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: inactive ? "var(--color-ink-muted)" : "var(--color-good)" }}
      />
      <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[12px] text-[var(--color-ink-dim)]" title={url}>
        {url}
      </span>
      {f.encryption_mode === "client" && (
        <Badge tone="accent" title="Append the #ek= key you saved at upload">
          needs #ek=
        </Badge>
      )}
      {lk.max_uses != null && (
        <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
          {lk.use_count}/{lk.max_uses} dl
        </span>
      )}
      {lk.expires_at && (
        <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
          exp {new Date(lk.expires_at).toLocaleDateString()}
        </span>
      )}
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => actions.copy(url)}>
          Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={() => actions.copy(`[${f.original_filename}](${url})`)}>
          MD
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.open(url, "_blank", "noopener")}>
          Open
        </Button>
        {!inactive && perms.canRegenerateLinks && (
          <Button size="sm" variant="ghost" onClick={() => actions.setLinkActive(lk, false)}>
            Deactivate
          </Button>
        )}
        {inactive && (
          <Badge tone="neutral">{!lk.active ? "inactive" : expired ? "expired" : "used up"}</Badge>
        )}
        {inactive && !lk.active && !expired && !usedUp && perms.canRegenerateLinks && (
          <Button size="sm" variant="ghost" onClick={() => actions.setLinkActive(lk, true)}>
            Reactivate
          </Button>
        )}
        {perms.canDeleteLinks && (
          <Button size="sm" variant="ghost" className="!text-[var(--color-bad)]" onClick={() => actions.deleteLink(lk)}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function FileCard({ f, perms, actions }: { f: FileObj; perms: Permissions; actions: FilesActions }) {
  const activeLinks = f.links.filter((l) => l.active).length;
  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="text-lg opacity-70">{fileIcon(f.content_type)}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[var(--color-ink)]" title={f.original_filename}>
            {f.original_filename}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
            <span>{formatBytes(f.size_bytes)}</span>
            <span>{formatDate(f.created_at)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <EncBadge mode={String(f.encryption_mode)} />
          {f.compressed && <Badge tone="neutral" title="Stored compressed (zstd)">zst</Badge>}
          <Badge tone={activeLinks > 0 ? "good" : "neutral"}>
            {f.links.length} link{f.links.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {perms.canRegenerateLinks && (
            <Button size="sm" variant="ghost" onClick={() => actions.openMint(f.id)}>
              + Link
            </Button>
          )}
          {perms.canDeleteFiles && (
            <Button size="sm" variant="danger" onClick={() => actions.deleteFile(f.id, f.original_filename)}>
              Delete
            </Button>
          )}
        </div>
      </div>
      {f.links.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-[var(--color-line)] bg-[var(--color-canvas-2)]/40 p-3">
          {f.links.map((lk) => (
            <LinkRow key={lk.id} lk={lk} f={f} perms={perms} actions={actions} />
          ))}
        </div>
      )}
    </Card>
  );
}

function DirectoryCard({ d, perms, actions }: { d: DirObj; perms: Permissions; actions: FilesActions }) {
  const [members, setMembers] = useState<DirMember[] | null>(null);
  const [err, setErr] = useState(false);
  const shareUrl = directoryShareUrl(d, d.encryption_mode, null);

  useEffect(() => {
    let live = true;
    listDirectoryFiles(d.id)
      .then((files) => live && setMembers(files))
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, [d.id]);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="text-lg opacity-70">📁</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[var(--color-ink)]" title={d.title}>
            {d.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
            <span>
              {d.file_count} file{d.file_count !== 1 ? "s" : ""}
            </span>
            <span>{formatBytes(d.total_bytes)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <EncBadge mode={String(d.encryption_mode)} />
          <Badge tone="good">folder</Badge>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {perms.canCreateDirectories && (
            <Button size="sm" variant="ghost" onClick={() => actions.addFilesToDirectory(d)}>
              Add files
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => window.open(shareUrl, "_blank", "noopener")}>
            Open
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.copy(shareUrl)}>
            Copy
          </Button>
          {perms.canDeleteFiles && (
            <Button size="sm" variant="danger" onClick={() => actions.deleteDirectory(d)}>
              Delete all
            </Button>
          )}
        </div>
      </div>
      <div className="border-t border-[var(--color-line)] bg-[var(--color-canvas-2)]/40 p-3">
        {d.encryption_mode === "client" && (
          <div className="mb-2 text-xs text-[var(--color-ink-muted)]">
            End-to-end encrypted. Keep the #ek= key from the share link; adding files later needs it.
          </div>
        )}
        {err ? (
          <div className="text-xs text-[var(--color-bad)]">Could not load folder files.</div>
        ) : members === null ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
            <Spinner /> Loading files…
          </div>
        ) : members.length === 0 ? (
          <div className="text-xs text-[var(--color-ink-muted)]">Empty folder.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {members.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/50 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink-dim)]" title={f.filename}>
                  {f.filename}
                </span>
                <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
                  {formatBytes(f.size_bytes)}
                </span>
                {perms.canDeleteFiles && (
                  <Button size="sm" variant="danger" onClick={() => actions.removeMember(d.id, f.id, f.filename)}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

export function FilesList({
  dirs,
  files,
  loading,
  perms,
  actions,
}: {
  dirs: DirObj[];
  files: FileObj[];
  loading: boolean;
  perms: Permissions;
  actions: FilesActions;
}) {
  if (loading)
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-ink-muted)]">
        <Spinner /> Loading…
      </div>
    );
  if (!dirs.length && !files.length)
    return <EmptyState icon="📂">Nothing here yet. Upload a file or share a folder above.</EmptyState>;

  return (
    <div className="flex flex-col gap-3">
      {dirs.map((d) => (
        <DirectoryCard key={`d${d.id}`} d={d} perms={perms} actions={actions} />
      ))}
      {files.map((f) => (
        <FileCard key={`f${f.id}`} f={f} perms={perms} actions={actions} />
      ))}
    </div>
  );
}
