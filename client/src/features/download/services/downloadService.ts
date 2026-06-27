// Network boundary for the public single-file download page.
// Ported from app/static/js/download.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";

export interface FileInfo {
  filename: string;
  size_bytes: number;
  content_type: string;
  encryption_mode: string;
  max_uses?: number | null;
  use_count: number;
  hashes?: Record<string, string>;
}

/** GET /file/{slug}/info — public metadata for the share page. */
export async function fetchFileInfo(slug: string): Promise<FileInfo> {
  const resp = await fetch(`/file/${slug}/info`);
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Link not found."));
  return (await resp.json()) as FileInfo;
}

/** GET /file/{slug}/raw — full ciphertext bytes for client-side decryption. */
export async function fetchCiphertext(slug: string): Promise<ArrayBuffer> {
  const resp = await fetch(`/file/${slug}/raw`);
  if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
  return resp.arrayBuffer();
}

/** POST /files/{slug}/save — copy a shared file into the signed-in user's storage. */
export async function saveToMyFiles(slug: string): Promise<void> {
  const resp = await apiFetch(`/files/${slug}/save`, { method: "POST" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Save failed."));
}

/** Fetch a text preview body (used for inline text/* rendering). */
export async function fetchTextPreview(src: string): Promise<string> {
  const resp = await fetch(src);
  if (!resp.ok) throw new Error("preview unavailable");
  return resp.text();
}
