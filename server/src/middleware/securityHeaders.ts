import type { NextFunction, Request, Response } from "express";

/**
 * Policy for everything this server sends unless a route says otherwise: the
 * SPA shell, its assets, and every JSON endpoint. Written for what the client
 * actually does -- no external origins, `blob:` for the E2E worker's output
 * and the media player, `data:` for rendered QR codes, same-origin frames for
 * the PDF preview, `'unsafe-inline'` styles because Radix positions with
 * inline `style=` and the standalone error page carries its own `<style>`.
 * `connect-src 'self'` covers the same-origin websocket firehose.
 */
const PAGE_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"worker-src 'self' blob:",
	"connect-src 'self'",
	"frame-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

/**
 * Headers for a response whose body is *uploaded bytes*: `/file/:slug/raw`,
 * `/preview`, `/thumbnail`, the folder zip, media streams. The body is
 * attacker-supplied, so it gets no permissions at all rather than the page
 * policy -- `script-src 'self'` on a response that *is* the script would be
 * same-origin execution the moment a content-type check is missed. `sandbox`
 * makes a directly navigated-to file inert; `frame-ancestors 'self'` (and its
 * legacy twin) is what lets the download page's same-origin PDF iframe render
 * while still refusing cross-site framing.
 */
export const BYTES_HEADERS: Readonly<Record<string, string>> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "SAMEORIGIN",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy":
		"default-src 'none'; sandbox; frame-ancestors 'self'",
};

/** Mirrors app/main.py::_SecurityHeaders, plus the page CSP. */
export function securityHeaders(secure: boolean) {
	return (_req: Request, res: Response, next: NextFunction): void => {
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Content-Security-Policy", PAGE_CSP);
		res.setHeader(
			"Permissions-Policy",
			"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		);
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		if (secure) {
			res.setHeader(
				"Strict-Transport-Security",
				"max-age=63072000; includeSubDomains",
			);
		}
		next();
	};
}
