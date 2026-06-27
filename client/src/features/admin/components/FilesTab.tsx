import { useEffect, useState } from "react";
import { formatBytes, formatDate, parseDuration } from "../../../lib/api";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import { Badge, Card, Field, Input, Spinner, Toggle } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import {
  archiveFile,
  deleteDirectory,
  deleteFile,
  deleteLink,
  listAdminDirectories,
  listAdminFiles,
  listUsers,
  mintLink,
  setLinkActive,
  updateLink,
} from "../services/adminService";
import type { AdminDir, AdminFile, AdminLink, AdminUser, Selection } from "../types";

function adminLinkUrl(slug: string, f: { encryption_mode?: string; access_key?: string }) {
  const base = `${location.origin}/file/${slug}`;
  if (f.encryption_mode === "server" && f.access_key) return base + "?ek=" + encodeURIComponent(f.access_key);
  return base;
}
function adminDirUrl(d: AdminDir) {
  let url = d.url || `${location.origin}/d/${d.slug}`;
  if (d.encryption_mode === "server" && d.access_key) url += "?ek=" + encodeURIComponent(d.access_key);
  return url;
}

function EncBadge({ mode }: { mode: string }) {
  if (mode === "client") return <Badge tone="accent">🔒 e2e</Badge>;
  if (mode === "server") return <Badge tone="accent">🔐 server</Badge>;
  return null;
}

interface Props {
  version: number;
  bump: () => void;
  selection: Selection;
  toggleSel: (kind: keyof Selection, id: number) => void;
  clearSel: (kinds: (keyof Selection)[]) => void;
  onEditLink: (lk: AdminLink) => void;
}

function LinkPanel({ f, bump, copy, onEditLink }: { f: AdminFile; bump: () => void; copy: (t: string) => void; onEditLink: (lk: AdminLink) => void }) {
  const { showToast } = useToast();
  const dialog = useDialog();
  const now = Date.now();

  async function mint() {
    let data;
    try {
      data = await mintLink(f.id);
    } catch {
      return showToast("Failed to create link.", "error");
    }
    const url = adminLinkUrl(data.slug, f);
    showToast(f.encryption_mode === "client" ? "Link created — append the #ek= key before sharing." : "Link created & copied.");
    navigator.clipboard.writeText(url).catch(() => {});
    bump();
  }
  async function setActive(lk: AdminLink, active: boolean) {
    try {
      await setLinkActive(lk.id, active);
      showToast(active ? "Link reactivated." : "Link deactivated.");
      bump();
    } catch {
      showToast("Failed.", "error");
    }
  }
  async function del(lk: AdminLink) {
    const ok = await dialog.confirm({
      title: "Delete link?",
      message: "This permanently removes the share link. The file remains stored.",
      confirmText: "Delete link",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLink(lk.id);
      showToast("Link deleted.");
      bump();
    } catch {
      showToast("Failed to delete link.", "error");
    }
  }

  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-canvas-2)]/40 p-3">
      <Button size="sm" variant="ghost" onClick={mint} className="mb-2">
        + New link
      </Button>
      {!f.links.length ? (
        <div className="text-xs text-[var(--color-ink-muted)]">No links yet — create one above.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {f.links.map((lk) => {
            const expired = !!lk.expires_at && new Date(lk.expires_at).getTime() < now;
            const usedUp = lk.max_uses != null && lk.use_count >= lk.max_uses;
            const inactive = !lk.active || expired || usedUp;
            const url = adminLinkUrl(lk.slug, f);
            return (
              <div
                key={lk.id}
                className={`flex flex-wrap items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/50 px-2.5 py-1.5 ${inactive ? "opacity-60" : ""}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: inactive ? "var(--color-ink-muted)" : "var(--color-good)" }} />
                <span className="min-w-0 flex-1 truncate font-[var(--font-mono)] text-[12px] text-[var(--color-ink-dim)]" title={url}>
                  {url}
                </span>
                {f.encryption_mode === "client" && <Badge tone="accent">needs #ek=</Badge>}
                <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
                  {lk.max_uses != null ? `${lk.use_count}/${lk.max_uses} dl` : `${lk.use_count} dl`}
                </span>
                <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
                  {lk.expires_at ? new Date(lk.expires_at).toLocaleDateString() : "no expiry"}
                </span>
                {inactive && <Badge tone="neutral">{!lk.active ? "inactive" : expired ? "expired" : "used up"}</Badge>}
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => copy(url)}>Copy</Button>
                  <Button size="sm" variant="ghost" onClick={() => copy(`[${f.original_filename}](${url})`)}>MD</Button>
                  <Button size="sm" variant="ghost" onClick={() => window.open(url, "_blank", "noopener")}>Open</Button>
                  {!inactive && <Button size="sm" variant="ghost" onClick={() => onEditLink(lk)}>Edit</Button>}
                  {!inactive && <Button size="sm" variant="ghost" onClick={() => setActive(lk, false)}>Deactivate</Button>}
                  {inactive && !lk.active && !expired && !usedUp && (
                    <Button size="sm" variant="ghost" onClick={() => setActive(lk, true)}>Reactivate</Button>
                  )}
                  <Button size="sm" variant="ghost" className="!text-[var(--color-bad)]" onClick={() => del(lk)}>Delete</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FileRow({ f, sel, toggleSel, bump, copy, onEditLink }: { f: AdminFile; sel: boolean; toggleSel: () => void; bump: () => void; copy: (t: string) => void; onEditLink: (lk: AdminLink) => void }) {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  const activeLinks = f.links.filter((l) => l.active).length;

  async function del() {
    const ok = await dialog.confirm({
      title: "Delete file?",
      message: `"${f.original_filename}" and all its links will be permanently removed. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFile(f.id);
      showToast("File deleted.");
      bump();
    } catch {
      showToast("Delete failed.", "error");
    }
  }
  async function archive() {
    try {
      const d = await archiveFile(f.id, !!f.archived);
      showToast(f.archived ? "File unarchived." : `File archived. Saved ${formatBytes(d.archive_saved_bytes || 0)}.`);
      bump();
    } catch {
      showToast("Archive action failed.", "error");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 hover:bg-[var(--color-surface-2)]/40">
        <input type="checkbox" checked={sel} onChange={toggleSel} onClick={(e) => e.stopPropagation()} className="accent-[var(--color-accent)]" />
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink)]" title={f.original_filename}>
          {f.original_filename}
        </span>
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">{formatBytes(f.size_bytes)}</span>
        <span className="hidden font-[var(--font-mono)] text-[11px] text-[var(--color-ink-muted)] sm:inline">{formatDate(f.created_at)}</span>
        <EncBadge mode={String(f.encryption_mode)} />
        {f.compressed && <Badge tone="neutral">zst</Badge>}
        <Badge tone={activeLinks > 0 ? "good" : "neutral"}>{activeLinks}/{f.links.length} links</Badge>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? "▼" : "▶"} Links</Button>
        <Button size="sm" variant="ghost" onClick={archive}>{f.archived ? "Unarchive" : "Archive"}</Button>
        <Button size="sm" variant="danger" onClick={del}>Delete</Button>
      </div>
      {open && <LinkPanel f={f} bump={bump} copy={copy} onEditLink={onEditLink} />}
    </div>
  );
}

export function FilesTab({ version, bump, selection, toggleSel, clearSel, onEditLink }: Props) {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [files, setFiles] = useState<AdminFile[]>([]);
  const [dirs, setDirs] = useState<AdminDir[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [u, f, d] = await Promise.all([listUsers(), listAdminFiles(), listAdminDirectories()]);
      setUsers(u);
      setFiles(f);
      setDirs(d);
    } catch {
      showToast("Failed to load.", "error");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const userMap: Record<number, AdminUser> = {};
  for (const u of users) userMap[u.id] = u;
  const needle = filter.trim().toLowerCase();
  const fFiles = needle
    ? files.filter((f) =>
        [f.original_filename, f.content_type, userMap[f.owner_id]?.username || "", String(f.id)].some((v) =>
          (v || "").toLowerCase().includes(needle),
        ),
      )
    : files;
  const fDirs = needle
    ? dirs.filter((d) =>
        [d.title, d.slug || "", userMap[d.owner_id]?.username || "", String(d.id)].some((v) =>
          (v || "").toLowerCase().includes(needle),
        ),
      )
    : dirs;

  const sections: Record<number, { files: AdminFile[]; dirs: AdminDir[] }> = {};
  for (const d of fDirs) (sections[d.owner_id] ||= { files: [], dirs: [] }).dirs.push(d);
  for (const f of fFiles) (sections[f.owner_id] ||= { files: [], dirs: [] }).files.push(f);

  const copy = (t: string) => {
    navigator.clipboard.writeText(t).catch(() => {});
    showToast("Copied.");
  };

  async function delDir(d: AdminDir) {
    const ok = await dialog.confirm({
      title: "Delete folder?",
      message: `"${d.title}" and all ${d.file_count} file${d.file_count !== 1 ? "s" : ""} inside will be permanently removed. This cannot be undone.`,
      confirmText: "Delete folder",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDirectory(d.id);
      showToast("Folder deleted.");
      bump();
    } catch {
      showToast("Delete failed.", "error");
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input placeholder="Filter files & folders…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        <Button variant="ghost" onClick={() => clearSel(["files", "directories"])}>Clear selection</Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-[var(--color-ink-muted)]">
          <Spinner /> Loading…
        </div>
      ) : !fFiles.length && !fDirs.length ? (
        <div className="py-10 text-center text-sm text-[var(--color-ink-muted)]">No files or folders.</div>
      ) : (
        <div className="space-y-5">
          {Object.entries(sections).map(([ownerId, items]) => {
            const owner = userMap[Number(ownerId)];
            const total =
              items.files.reduce((a, f) => a + f.size_bytes, 0) + items.dirs.reduce((a, d) => a + (d.total_bytes || 0), 0);
            return (
              <div key={ownerId}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-[var(--font-display)] font-semibold text-[var(--color-ink)]">
                    {owner ? owner.username : `User #${ownerId}`}
                  </span>
                  <Badge tone="neutral">{items.files.length} file{items.files.length !== 1 ? "s" : ""}</Badge>
                  <Badge tone="good">{items.dirs.length} folder{items.dirs.length !== 1 ? "s" : ""}</Badge>
                  <span className="text-xs text-[var(--color-ink-muted)]">{formatBytes(total)}</span>
                </div>
                <Card className="p-0 overflow-hidden divide-y divide-[var(--color-line)]">
                  {items.dirs.map((d) => (
                    <div key={`d${d.id}`} className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 hover:bg-[var(--color-surface-2)]/40">
                      <input
                        type="checkbox"
                        checked={selection.directories.has(d.id)}
                        onChange={() => toggleSel("directories", d.id)}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink)]">📁 {d.title}</span>
                      <span className="font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">{formatBytes(d.total_bytes || 0)}</span>
                      <Badge tone="neutral">{d.file_count} file{d.file_count !== 1 ? "s" : ""}</Badge>
                      <EncBadge mode={String(d.encryption_mode)} />
                      <Button size="sm" variant="ghost" onClick={() => window.open(adminDirUrl(d), "_blank", "noopener")}>Open</Button>
                      <Button size="sm" variant="ghost" onClick={() => copy(adminDirUrl(d))}>Copy</Button>
                      <Button size="sm" variant="danger" onClick={() => delDir(d)}>Delete all</Button>
                    </div>
                  ))}
                  {items.files.map((f) => (
                    <FileRow
                      key={`f${f.id}`}
                      f={f}
                      sel={selection.files.has(f.id)}
                      toggleSel={() => toggleSel("files", f.id)}
                      bump={bump}
                      copy={copy}
                      onEditLink={onEditLink}
                    />
                  ))}
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function LinkEditModal({
  link,
  onClose,
  onSaved,
}: {
  link: AdminLink | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { showToast } = useToast();
  const [maxUses, setMaxUses] = useState("");
  const [expires, setExpires] = useState("");
  const [active, setActive] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (link) {
      setMaxUses(link.max_uses != null ? String(link.max_uses) : "");
      setExpires("");
      setActive(!!link.active);
      setErr("");
    }
  }, [link]);

  async function save() {
    if (!link) return;
    const expiresInSec = expires.trim() ? parseDuration(expires) : null;
    if (expires.trim() && expiresInSec === null) return setErr('Invalid duration — use "7d", "24h"');
    const body: Record<string, unknown> = { active };
    body.max_uses = maxUses !== "" ? parseInt(maxUses, 10) : null;
    if (expiresInSec) body.expires_in_seconds = expiresInSec;
    try {
      await updateLink(link.id, body);
    } catch (err) {
      return setErr((err as Error).message || "Update failed.");
    }
    showToast("Link updated.");
    onClose();
    onSaved();
  }

  return (
    <Modal
      open={!!link}
      onClose={onClose}
      title="Edit link"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </>
      }
    >
      {err && <div className="mb-3 text-sm text-[var(--color-bad)]">{err}</div>}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max downloads">
            <Input placeholder="unlimited" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </Field>
          <Field label="Extend expiry">
            <Input placeholder='e.g. "7d"' value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <Toggle checked={active} onChange={setActive} label="Active" />
      </div>
    </Modal>
  );
}
