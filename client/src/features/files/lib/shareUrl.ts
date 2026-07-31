import type { EncryptionMode } from "../types";

/** Absolute origin for building shareable links. */
export function origin(): string {
	return window.location.origin;
}

export function fileUrl(slug: string): string {
	return `${origin()}/file/${slug}`;
}

/** The actual download endpoint (backend, under /api) -- distinct from
 * fileUrl(), which is the SPA page that shows this file's info. */
export function rawUrl(slug: string): string {
	return `${origin()}/api/file/${slug}/raw`;
}

export function folderUrl(slug: string): string {
	return `${origin()}/d/${slug}`;
}

/**
 * Compose the full shareable URL including the encryption key:
 *  - server mode          → `?ek=<accessKey>` (query, sent to server)
 *  - client/sealed mode   → `#ek=<keyB64Url>` (fragment, never sent to server)
 *  - none                 → bare URL
 *
 * `sealed` behaves exactly like `client` here: the server threw the key away,
 * so it can only ever travel in the fragment, and only whoever kept it can
 * complete the URL.
 */
export function shareUrl(
	base: string,
	mode: EncryptionMode,
	opts: { accessKey?: string | null; clientKeyB64?: string | null },
): string {
	if (mode === "server" && opts.accessKey)
		return `${base}?ek=${encodeURIComponent(opts.accessKey)}`;
	if ((mode === "client" || mode === "sealed") && opts.clientKeyB64)
		return `${base}#ek=${opts.clientKeyB64}`;
	return base;
}
