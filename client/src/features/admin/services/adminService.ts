// Network boundary for the entire admin dashboard.
// Every admin-scoped HTTP call lives here so each contract is reviewable in one
// place. Ported from app/static/js/admin.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";
import type { AdminDir, AdminFile, AdminKey, AdminUser, AuditEntry, BackendLogEntry } from "../types";

async function ok(resp: Response, fallback: string): Promise<Response> {
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, fallback));
  return resp;
}

// ── Disk + storage ─────────────────────────────────────────────────────────
export interface DiskStats {
  total_files: number;
  total_bytes: number;
  total_users: number;
  total_links: number;
}

/** GET /files/disk-stats — top-line counters for the admin header. */
export async function fetchDiskStats(): Promise<DiskStats> {
  const resp = await ok(await apiFetch("/files/disk-stats"), "Failed to load disk stats.");
  return (await resp.json()) as DiskStats;
}

/** GET /admin/storage — full storage breakdown + fun stats. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchStorage(): Promise<any> {
  const resp = await ok(await apiFetch("/admin/storage"), "Failed to load storage details.");
  return resp.json();
}

/** PATCH /admin/storage — set the global storage cap. */
export async function updateStorageCap(bytes: number): Promise<void> {
  await ok(
    await apiFetch("/admin/storage", { method: "PATCH", json: { global_storage_quota_bytes: bytes } }),
    "Failed to update cap.",
  );
}

/** POST /admin/lifecycle/* — run a maintenance job; returns {processed}. */
export async function runLifecycle(path: string): Promise<{ processed?: number }> {
  const resp = await ok(await apiFetch(path, { method: "POST", json: {} }), "Lifecycle action failed.");
  return resp.json();
}

// ── Users ──────────────────────────────────────────────────────────────────
export async function listUsers(): Promise<AdminUser[]> {
  const resp = await ok(await apiFetch("/users/"), "Failed to load users.");
  return (await resp.json()).users;
}

export async function createUser(body: Record<string, unknown>): Promise<void> {
  await ok(await apiFetch("/users/", { method: "POST", json: body }), "Failed.");
}

export async function updateUser(id: number, body: Record<string, unknown>): Promise<void> {
  await ok(await apiFetch(`/users/${id}`, { method: "PATCH", json: body }), "Update failed.");
}

export async function deleteUser(id: number): Promise<void> {
  await ok(await apiFetch(`/users/${id}`, { method: "DELETE" }), "Delete failed.");
}

export async function updatePermissions(id: number, body: Record<string, unknown>): Promise<void> {
  await ok(await apiFetch(`/users/${id}/permissions`, { method: "POST", json: body }), "Update failed.");
}

// ── Files / directories (admin views) ────────────────────────────────────────
export async function listAdminFiles(): Promise<AdminFile[]> {
  const resp = await ok(await apiFetch("/admin/files"), "Failed to load files.");
  return (await resp.json()).files;
}

export async function listAdminDirectories(): Promise<AdminDir[]> {
  const resp = await ok(await apiFetch("/admin/directories"), "Failed to load directories.");
  return (await resp.json()).directories;
}

export async function deleteFile(id: number): Promise<void> {
  await ok(await apiFetch(`/files/${id}`, { method: "DELETE" }), "Delete failed.");
}

/** POST /admin/files/{id}/archive|unarchive — returns lifecycle deltas. */
export async function archiveFile(id: number, archived: boolean): Promise<{ archive_saved_bytes?: number }> {
  const endpoint = archived ? "unarchive" : "archive";
  const resp = await ok(
    await apiFetch(`/admin/files/${id}/${endpoint}`, { method: "POST", json: {} }),
    "Archive action failed.",
  );
  return resp.json();
}

export async function deleteDirectory(id: number): Promise<void> {
  await ok(await apiFetch(`/directories/${id}`, { method: "DELETE" }), "Delete failed.");
}

// ── Links ────────────────────────────────────────────────────────────────────
export async function mintLink(fileId: number): Promise<{ slug: string }> {
  const resp = await ok(await apiFetch(`/files/${fileId}/links`, { method: "POST", json: {} }), "Failed to create link.");
  return resp.json();
}

export async function setLinkActive(id: number, active: boolean): Promise<void> {
  await ok(await apiFetch(`/links/${id}`, { method: "PATCH", json: { active } }), "Failed.");
}

export async function updateLink(id: number, body: Record<string, unknown>): Promise<void> {
  await ok(await apiFetch(`/links/${id}`, { method: "PATCH", json: body }), "Update failed.");
}

export async function deleteLink(id: number): Promise<void> {
  await ok(await apiFetch(`/links/${id}`, { method: "DELETE" }), "Failed to delete link.");
}

// ── API keys (admin) ──────────────────────────────────────────────────────────
export async function listAdminKeys(): Promise<AdminKey[]> {
  const resp = await ok(await apiFetch("/admin/keys"), "Failed to load API keys.");
  return (await resp.json()).keys;
}

export async function createKey(): Promise<string> {
  const resp = await ok(await apiFetch("/keys/", { method: "POST", json: {} }), "Failed to create key.");
  return (await resp.json()).key as string;
}

export async function revokeKey(id: number): Promise<void> {
  await ok(await apiFetch(`/keys/${id}`, { method: "DELETE" }), "Failed to revoke key.");
}

export async function resetKeyIp(id: number, password: string): Promise<void> {
  await ok(await apiFetch(`/keys/${id}/reset-ip`, { method: "POST", json: { password } }), "Failed to reset IP.");
}

// ── Audit ────────────────────────────────────────────────────────────────────
export interface AuditPage {
  entries: AuditEntry[];
  actions: string[];
  chain_ok: boolean;
  total_count: number;
  filtered_count: number;
}

export async function fetchAudit(params: { limit: number; offset: number; q?: string; action?: string }): Promise<AuditPage> {
  const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.action) qs.set("action", params.action);
  const resp = await ok(await apiFetch(`/audit/?${qs.toString()}`), "Failed to load audit log.");
  return (await resp.json()) as AuditPage;
}

// ── Backend logs ──────────────────────────────────────────────────────────────
export interface BackendLogPage {
  entries: BackendLogEntry[];
  filtered_count: number;
  total_count: number;
}

export async function fetchBackendLogs(params: { limit?: number; q?: string; level?: string }): Promise<BackendLogPage> {
  const qs = new URLSearchParams({ limit: String(params.limit ?? 300) });
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.level) qs.set("level", params.level);
  const resp = await ok(await apiFetch(`/admin/backend/logs?${qs.toString()}`), "Failed to load backend logs.");
  return (await resp.json()) as BackendLogPage;
}

export async function restartWorkers(): Promise<{ status: string }> {
  const resp = await ok(
    await apiFetch("/admin/backend/restart-workers", { method: "POST", json: {} }),
    "Failed to restart backend workers.",
  );
  return resp.json();
}

// ── Bulk operations ───────────────────────────────────────────────────────────
export interface BulkPreview {
  affected_count: number;
  confirmation_phrase: string;
}
export interface BulkRunResult {
  processed_count: number;
  affected_count: number;
}

export async function bulkPreview(action: string, ids: number[]): Promise<BulkPreview> {
  const resp = await ok(
    await apiFetch("/admin/bulk/preview", { method: "POST", json: { action, ids } }),
    "Bulk preview failed.",
  );
  return (await resp.json()) as BulkPreview;
}

export async function bulkRun(action: string, ids: number[], confirm: string): Promise<BulkRunResult> {
  const resp = await ok(
    await apiFetch("/admin/bulk/run", { method: "POST", json: { action, ids, confirm } }),
    "Bulk action failed.",
  );
  return (await resp.json()) as BulkRunResult;
}
