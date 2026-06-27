// Network boundary for a user's own files + storage usage.
// Ported from app/static/js/files.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";
import type { FileObj } from "../types";

export interface Usage {
  used: number;
  quota: number;
}

/** GET /files/usage — storage quota for the current user (null on failure). */
export async function fetchUsage(): Promise<Usage | null> {
  const resp = await apiFetch("/files/usage");
  if (!resp.ok) return null;
  const { used_bytes, quota_bytes } = await resp.json();
  return { used: used_bytes, quota: quota_bytes };
}

/** GET /files/ — the current user's loose (non-folder) files. */
export async function listFiles(): Promise<FileObj[]> {
  const resp = await apiFetch("/files/");
  return resp.ok ? (await resp.json()).files : [];
}

/** DELETE /files/{id} — remove a file and all its links. */
export async function deleteFile(id: number): Promise<void> {
  const resp = await apiFetch(`/files/${id}`, { method: "DELETE" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Delete failed."));
}
