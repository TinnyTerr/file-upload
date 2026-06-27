// Network boundary for personal API keys.
// Ported from app/static/js/files.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";
import type { ApiKeyObj } from "../types";

/** GET /keys/ — all of the current user's API keys (active + revoked). */
export async function listKeys(): Promise<ApiKeyObj[]> {
  const resp = await apiFetch("/keys/");
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to load API keys."));
  return (await resp.json()).keys;
}

/** POST /keys/ — create a new key; the secret is returned exactly once. */
export async function createKey(): Promise<string> {
  const resp = await apiFetch("/keys/", { method: "POST", json: {} });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to create key."));
  return (await resp.json()).key as string;
}

/** DELETE /keys/{id} — revoke a key. */
export async function revokeKey(id: number): Promise<void> {
  const resp = await apiFetch(`/keys/${id}`, { method: "DELETE" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to revoke key."));
}

/** POST /keys/{id}/reset-ip — clear the IP binding after confirming the password. */
export async function resetKeyIp(id: number, password: string): Promise<void> {
  const resp = await apiFetch(`/keys/${id}/reset-ip`, { method: "POST", json: { password } });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to reset IP."));
}
