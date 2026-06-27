// Network boundary for per-file share links.
// Ported from app/static/js/files.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";
import type { EncMode } from "../../../lib/keys";

export interface MintResult {
  url: string;
  encryption_mode: EncMode;
  access_key?: string;
}

export interface MintInput {
  max_uses?: number;
  expires_in_seconds?: number;
}

/** POST /files/{fileId}/links — mint a fresh share link for a file. */
export async function mintLink(fileId: number, input: MintInput): Promise<MintResult> {
  const body: Record<string, unknown> = {};
  if (input.max_uses != null) body.max_uses = input.max_uses;
  if (input.expires_in_seconds != null) body.expires_in_seconds = input.expires_in_seconds;
  const resp = await apiFetch(`/files/${fileId}/links`, { method: "POST", json: body });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to create link."));
  return (await resp.json()) as MintResult;
}

/** PATCH /links/{id} — toggle a link active/inactive. */
export async function setLinkActive(id: number, active: boolean): Promise<void> {
  const resp = await apiFetch(`/links/${id}`, { method: "PATCH", json: { active } });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to update link."));
}

/** DELETE /links/{id} — permanently remove a share link. */
export async function deleteLink(id: number): Promise<void> {
  const resp = await apiFetch(`/links/${id}`, { method: "DELETE" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to delete link."));
}
