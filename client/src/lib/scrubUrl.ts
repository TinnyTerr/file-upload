/** Share links carry their secret in the path (`/file/<slug>`, `/d/<slug>`,
 * dropbox tokens) and in the query (`?ek=`, `?k=`, `?receive=`) or fragment
 * (`#ek=`). A trace, breadcrumb or replay must show the route, never the
 * credential. Mirrors server/src/sentry.ts::scrubPath. */
export function scrubUrl(url: string): string {
	return url
		.replace(/#.*$/, "")
		.replace(/\/(api\/)?(file|d)\/[^/?#]+/g, "/$1$2/:slug")
		.replace(/\/(api\/)?dropbox\/[^/?#]+/g, "/$1dropbox/:token")
		.replace(/([?&](?:ek|k|receive)=)[^&]*/g, "$1[redacted]");
}

/** Pages whose address *is* a credential. Session replay records nothing
 * while one of these is on screen. */
export function isSecretRoute(pathname: string, search: string): boolean {
	return /^\/(file|d)\//.test(pathname) || /[?&]receive=/.test(search);
}
