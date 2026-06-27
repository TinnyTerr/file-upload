// Network boundary for the public shared-folder page.
// Ported from app/static/js/directory.js.

import { ApiError, apiFetch, readDetail } from "../../../lib/api";

export interface DirFile {
  slug: string;
  filename: string;
  size_bytes: number;
  content_type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}
export interface DirInfo {
  title: string;
  file_count: number;
  total_bytes: number;
  encryption_mode: string;
  files: DirFile[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreviewData = { groups: Record<string, any[]> } | null;

/** GET /d/{slug}/info — folder metadata + file list. */
export async function fetchDirInfo(slug: string): Promise<DirInfo> {
  const resp = await fetch(`/d/${slug}/info`);
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Folder not found."));
  return (await resp.json()) as DirInfo;
}

/** GET /d/{slug}/preview-manifest — grouped preview tiles (best-effort). */
export async function fetchPreviewManifest(slug: string): Promise<PreviewData> {
  try {
    const resp = await fetch(`/d/${slug}/preview-manifest`);
    if (resp.ok) return (await resp.json()) as PreviewData;
  } catch {
    /* ignore */
  }
  return null;
}

/** GET /file/{slug}/raw — ciphertext bytes for one member file (client decrypt). */
export async function fetchMemberCiphertext(fileSlug: string): Promise<ArrayBuffer> {
  const resp = await fetch(`/file/${fileSlug}/raw`);
  if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status})`);
  return resp.arrayBuffer();
}

/** POST /d/{slug}/save — copy the shared folder into the signed-in user's storage. */
export async function saveFolder(slug: string): Promise<void> {
  const resp = await apiFetch(`/d/${slug}/save`, { method: "POST" });
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, "Folder save failed."));
}
