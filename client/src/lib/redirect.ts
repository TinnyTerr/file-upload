/** Only a same-site, non-protocol-relative path may be used as a post-login
 * destination. An absolute URL or `//evil.example` would turn `?next=` into an
 * open redirect, which is exactly the hole OAuth's exact-match redirect_uri
 * rule exists to close on the server side. */
export function safeInternalPath(
	raw: string | null | undefined,
): string | null {
	if (!raw) return null;
	if (!raw.startsWith("/") || raw.startsWith("//")) return null;
	return raw;
}
