import type { EncryptionMode } from "../types";

/** Absolute origin for building shareable links. */
export function origin(): string {
  return window.location.origin;
}

export function fileUrl(slug: string): string {
  return `${origin()}/file/${slug}`;
}

export function rawUrl(slug: string): string {
  return `${fileUrl(slug)}/raw`;
}

export function folderUrl(slug: string): string {
  return `${origin()}/d/${slug}`;
}

/**
 * Compose the full shareable URL including the encryption key:
 *  - server mode → `?ek=<accessKey>` (query, sent to server)
 *  - client mode → `#ek=<keyB64Url>` (fragment, never sent to server)
 *  - none        → bare URL
 */
export function shareUrl(
  base: string,
  mode: EncryptionMode,
  opts: { accessKey?: string | null; clientKeyB64?: string | null },
): string {
  if (mode === "server" && opts.accessKey) return `${base}?ek=${encodeURIComponent(opts.accessKey)}`;
  if (mode === "client" && opts.clientKeyB64) return `${base}#ek=${opts.clientKeyB64}`;
  return base;
}
