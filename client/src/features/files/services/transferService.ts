// Network boundary for server-side ingest paths: remote-URL fetch and
// receive ("dropbox") upload links. Ported from app/static/js/files.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";
import type { UploadResult } from "../../../lib/keys";

/** POST /files/remote-upload — have the server fetch a file from a URL. */
export async function remoteUpload(url: string, name?: string): Promise<UploadResult> {
  const body: Record<string, unknown> = { url };
  if (name) body.original_filename = name;
  const resp = await apiFetch("/files/remote-upload", { method: "POST", json: body });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Remote upload failed."));
  return (await resp.json()) as UploadResult;
}

/** POST /dropbox-links — create a one-time receive link that others can upload to. */
export async function createReceiveLink(expiresInSeconds: number): Promise<{ url: string }> {
  const resp = await apiFetch("/dropbox-links", {
    method: "POST",
    json: { expires_in_seconds: expiresInSeconds },
  });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Failed to create upload link."));
  return (await resp.json()) as { url: string };
}
