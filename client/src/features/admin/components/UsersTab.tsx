import { useEffect, useState } from "react";
import { ApiError, formatBytes, formatDate, parseSize } from "../../../lib/api";
import { useToast } from "../../../providers/ToastProvider";
import { useDialog } from "../../../providers/DialogProvider";
import { Badge, Field, Input, Select, Spinner, Toggle } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { InlineAlert } from "../../../components/layout/AuthShell";
import {
  createUser as createUserReq,
  deleteUser as deleteUserReq,
  listAdminDirectories,
  listAdminFiles,
  listUsers,
  updatePermissions,
  updateUser,
} from "../services/adminService";
import { PERMISSION_BADGES as PERM_BADGES, PERMISSION_FIELDS as PERM_FIELDS } from "../../../config/permissions";
import type { AdminUser } from "../types";

interface OwnerStats {
  count: number;
  bytes: number;
}

export function UsersTab({ version, bump }: { version: number; bump: () => void }) {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [byOwner, setByOwner] = useState<Record<number, OwnerStats>>({});
  const [filter, setFilter] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", password: "", role: "user", canUpload: true });
  const [createErr, setCreateErr] = useState("");

  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState({ username: "", password: "", role: "user" });
  const [editErr, setEditErr] = useState("");

  const [permUser, setPermUser] = useState<AdminUser | null>(null);
  const [permFlags, setPermFlags] = useState<Record<string, boolean>>({});
  const [permQuota, setPermQuota] = useState("");
  const [permMaxFile, setPermMaxFile] = useState("");
  const [permErr, setPermErr] = useState("");

  async function load() {
    let users: AdminUser[];
    try {
      users = await listUsers();
    } catch {
      return showToast("Failed to load users.", "error");
    }
    setUsers(users);
    const owners: Record<number, OwnerStats> = {};
    const [files, directories] = await Promise.all([
      listAdminFiles().catch(() => []),
      listAdminDirectories().catch(() => []),
    ]);
    for (const f of files) {
      const o = (owners[f.owner_id] ||= { count: 0, bytes: 0 });
      o.count++;
      o.bytes += f.stored_size_bytes ?? f.size_bytes ?? 0;
    }
    for (const d of directories) {
      const o = (owners[d.owner_id] ||= { count: 0, bytes: 0 });
      o.count += d.file_count || 0;
      o.bytes += d.total_bytes || 0;
    }
    setByOwner(owners);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const needle = filter.trim().toLowerCase();
  const shown = (users || []).filter(
    (u) => !needle || [u.username, u.role, String(u.id)].some((v) => (v || "").toLowerCase().includes(needle)),
  );

  async function createUser() {
    setCreateErr("");
    if (!createForm.username.trim()) return setCreateErr("Username is required.");
    if (createForm.password.length < 12) return setCreateErr("Password must be at least 12 characters.");
    try {
      await createUserReq({
        username: createForm.username.trim(),
        password: createForm.password,
        role: createForm.role,
        can_upload: createForm.canUpload,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return setCreateErr("Username already taken.");
      return setCreateErr((err as Error).message || "Failed.");
    }
    setCreateOpen(false);
    showToast(`User "${createForm.username.trim()}" created.`);
    bump();
  }

  async function saveEdit() {
    if (!editUser) return;
    setEditErr("");
    if (!editForm.username.trim()) return setEditErr("Username is required.");
    if (editForm.password && editForm.password.length < 12)
      return setEditErr("Password must be at least 12 characters.");
    const body: Record<string, unknown> = { username: editForm.username.trim(), role: editForm.role };
    if (editForm.password) body.password = editForm.password;
    try {
      await updateUser(editUser.id, body);
    } catch (err) {
      return setEditErr((err as Error).message || "Update failed.");
    }
    setEditUser(null);
    showToast("User updated.");
    bump();
  }

  async function savePerms() {
    if (!permUser) return;
    setPermErr("");
    const quotaBytes = permQuota.trim() ? parseSize(permQuota) : null;
    const maxFileBytes = permMaxFile.trim() ? parseSize(permMaxFile) : null;
    if (permQuota.trim() && quotaBytes === null) return setPermErr('Invalid quota — use "100 GB"');
    if (permMaxFile.trim() && maxFileBytes === null) return setPermErr('Invalid max file size — use "10 GB"');
    const body: Record<string, unknown> = {};
    for (const f of PERM_FIELDS) body[f.key] = !!permFlags[f.key];
    if (quotaBytes != null) body.quota_bytes = quotaBytes;
    if (maxFileBytes != null) body.max_file_bytes = maxFileBytes;
    try {
      await updatePermissions(permUser.id, body);
    } catch (err) {
      return setPermErr((err as Error).message || "Update failed.");
    }
    setPermUser(null);
    showToast("Permissions updated.");
    bump();
  }

  async function deleteUser(u: AdminUser) {
    const ok = await dialog.confirm({
      title: "Delete user?",
      message: `"${u.username}" will be removed along with all their files, folders, API keys, and share links. This cannot be undone.`,
      confirmText: "Delete user",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteUserReq(u.id);
      showToast("User deleted.");
      bump();
    } catch {
      showToast("Delete failed.", "error");
    }
  }

  function openPerm(u: AdminUser) {
    const p = u.permissions || {};
    const flags: Record<string, boolean> = {};
    for (const f of PERM_FIELDS) flags[f.key] = !!p[f.key];
    setPermFlags(flags);
    setPermQuota(p.quota_bytes != null ? formatBytes(p.quota_bytes as number) : "");
    setPermMaxFile(p.max_file_bytes != null ? formatBytes(p.max_file_bytes as number) : "");
    setPermErr("");
    setPermUser(u);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter users…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <Button
          className="ml-auto"
          onClick={() => {
            setCreateForm({ username: "", password: "", role: "user", canUpload: true });
            setCreateErr("");
            setCreateOpen(true);
          }}
        >
          + New user
        </Button>
      </div>

      {users === null ? (
        <div className="flex items-center gap-2 py-10 text-sm text-[var(--color-ink-muted)]">
          <Spinner /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--color-surface-2)] text-left font-[var(--font-mono)] text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
                <th className="px-3 py-2.5">User</th>
                <th className="px-3 py-2.5">Role</th>
                <th className="px-3 py-2.5">Permissions</th>
                <th className="px-3 py-2.5">Files</th>
                <th className="px-3 py-2.5">Storage</th>
                <th className="px-3 py-2.5">Created</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {!shown.length && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-ink-muted)]">
                    No users match the filter.
                  </td>
                </tr>
              )}
              {shown.map((u) => {
                const p = u.permissions || {};
                const stats = byOwner[u.id] || { count: 0, bytes: 0 };
                const quota = (p.quota_bytes as number) ?? 0;
                const pct = quota > 0 ? Math.min(100, (stats.bytes / quota) * 100) : 0;
                return (
                  <tr key={u.id} className="align-top hover:bg-[var(--color-surface-2)]/40">
                    <td className="px-3 py-3">
                      <span className="font-medium text-[var(--color-ink)]">{u.username}</span>
                      {u.must_change_credentials && (
                        <Badge tone="warn" className="ml-2">setup pending</Badge>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={u.role === "master" ? "accent" : "neutral"}>{u.role}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {PERM_BADGES.map((b) => (
                          <Badge key={b.key} tone={p[b.key] ? "good" : "neutral"} className={p[b.key] ? "" : "opacity-50"}>
                            {b.label}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3 font-[var(--font-mono)] text-xs">{stats.count.toLocaleString()}</td>
                    <td className="px-3 py-3">
                      <div className="mb-1 text-xs text-[var(--color-ink-muted)]">
                        {formatBytes(stats.bytes)} / {quota ? formatBytes(quota) : "∞"}
                      </div>
                      <div className="h-1.5 w-40 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-surface-3)]">
                        <div
                          className="h-full rounded-[var(--radius-pill)]"
                          style={{
                            width: `${pct}%`,
                            background: pct >= 90 ? "var(--color-bad)" : pct >= 70 ? "var(--color-warn)" : "var(--color-accent)",
                          }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs text-[var(--color-ink-muted)]">{formatDate(u.created_at)}</td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => {
                          setEditForm({ username: u.username, password: "", role: u.role });
                          setEditErr("");
                          setEditUser(u);
                        }}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openPerm(u)}>
                          Permissions
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => deleteUser(u)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create user */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create user"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createUser}>Create</Button>
          </>
        }
      >
        {createErr && <InlineAlert kind="error">{createErr}</InlineAlert>}
        <div className="space-y-3">
          <Field label="Username">
            <Input autoFocus value={createForm.username} onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))} />
          </Field>
          <Field label="Password (min 12 chars)">
            <Input type="password" value={createForm.password} onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))} />
          </Field>
          <Field label="Role">
            <Select value={createForm.role} onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="user">user</option>
              <option value="master">master</option>
            </Select>
          </Field>
          <Toggle checked={createForm.canUpload} onChange={(v) => setCreateForm((f) => ({ ...f, canUpload: v }))} label="Can upload" />
        </div>
      </Modal>

      {/* Edit user */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={editUser ? `Edit ${editUser.username}` : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save</Button>
          </>
        }
      >
        {editErr && <InlineAlert kind="error">{editErr}</InlineAlert>}
        <div className="space-y-3">
          <Field label="Username">
            <Input value={editForm.username} onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))} />
          </Field>
          <Field label="New password (optional)">
            <Input type="password" value={editForm.password} onChange={(e) => setEditForm((f) => ({ ...f, password: e.target.value }))} />
          </Field>
          <Field label="Role">
            <Select value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="user">user</option>
              <option value="master">master</option>
            </Select>
          </Field>
        </div>
      </Modal>

      {/* Permissions */}
      <Modal
        open={!!permUser}
        onClose={() => setPermUser(null)}
        title={permUser ? `Permissions — ${permUser.username}` : ""}
        width="max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPermUser(null)}>Cancel</Button>
            <Button onClick={savePerms}>Save</Button>
          </>
        }
      >
        {permErr && <InlineAlert kind="error">{permErr}</InlineAlert>}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {PERM_FIELDS.map((f) => (
            <Toggle
              key={f.key}
              checked={!!permFlags[f.key]}
              onChange={(v) => setPermFlags((s) => ({ ...s, [f.key]: v }))}
              label={f.label}
            />
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Quota">
            <Input placeholder="unlimited" value={permQuota} onChange={(e) => setPermQuota(e.target.value)} />
          </Field>
          <Field label="Max file size">
            <Input placeholder="unlimited" value={permMaxFile} onChange={(e) => setPermMaxFile(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
