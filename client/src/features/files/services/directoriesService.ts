// Network boundary for shared folders (directories).
// Ported from app/static/js/files.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";
import type { DirMember, DirObj } from "../types";

export interface CreateDirInput {
  title: string;
  encryption_mode: string;
  expires_in_seconds?: number | null;
}

/** GET /directories/ — the current user's folders. */
export async function listDirectories(): Promise<DirObj[]> {
  const resp = await apiFetch("/directories/");
  return resp.ok ? (await resp.json()).directories : [];
}

/** POST /directories — create a new shared folder. */
export async function createDirectory(input: CreateDirInput): Promise<DirObj> {
  const body: Record<string, unknown> = {
    title: input.title,
    encryption_mode: input.encryption_mode,
  };
  if (input.expires_in_seconds) body.expires_in_seconds = input.expires_in_seconds;
  const resp = await apiFetch("/directories", { method: "POST", json: body });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Folder creation failed."));
  return (await resp.json()) as DirObj;
}

/** DELETE /directories/{id} — delete a folder and everything inside it. */
export async function deleteDirectory(id: number): Promise<void> {
  const resp = await apiFetch(`/directories/${id}`, { method: "DELETE" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Delete failed."));
}

/** GET /directories/{id}/files — list the files inside a folder. */
export async function listDirectoryFiles(id: number): Promise<DirMember[]> {
  const resp = await apiFetch(`/directories/${id}/files`);
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Could not load folder files."));
  return (await resp.json()).files;
}

/** DELETE /directories/{dirId}/files/{fileId} — remove a file from a folder. */
export async function removeDirectoryFile(dirId: number, fileId: number): Promise<void> {
  const resp = await apiFetch(`/directories/${dirId}/files/${fileId}`, { method: "DELETE" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Remove failed."));
}
