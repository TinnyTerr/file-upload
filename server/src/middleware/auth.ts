import type { NextFunction, Request, Response } from "express";
import type { AppState } from "../appState.ts";
import { COOKIE_NAME } from "../security/sessions.ts";

/** Resolves the fu_session cookie into req.sessionRow, mirrors
 * app/deps.py::current_session. 401s if missing/invalid/expired. */
export function requireSession(state: AppState) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const cookieValue = req.cookies?.[COOKIE_NAME] as string | undefined;
		const sessionRow = state.sessionManager.resolve(state.db, cookieValue);
		if (!sessionRow) {
			res.status(401).json({ detail: "not authenticated" });
			return;
		}
		req.sessionRow = sessionRow;
		next();
	};
}

/** Real client IP behind a trusted proxy. TRUST_PROXY=cloudflare prefers
 * CF-Connecting-IP; TRUST_PROXY=true uses leftmost X-Forwarded-For but still
 * honors CF-Connecting-IP when Cloudflare headers are present, since
 * Cloudflare sets it authoritatively while XFF is client-appendable. */
export function clientIp(state: AppState, req: Request): string {
	const mode = state.settings.trustProxyMode;
	if (mode !== "off") {
		const cfIp = req.header("cf-connecting-ip");
		if (cfIp && (mode === "cloudflare" || req.header("cf-ray")))
			return cfIp.trim();
		if (mode !== "cloudflare") {
			const forwarded = req.header("x-forwarded-for");
			if (forwarded) return forwarded.split(",")[0]!.trim();
		}
	}
	return req.socket.remoteAddress || "";
}

/** Cloudflare's own marker for "no country data for this client". */
export const COUNTRY_UNKNOWN = "XX";
/** Cloudflare's own marker for a client arriving over the Tor network. It is
 * not an ISO country, so it must never be rendered as a flag or looked up in a
 * country table -- it means "exit node, origin unknowable". */
export const COUNTRY_TOR = "T1";

/**
 * The visitor's region, from Cloudflare's `CF-IPCountry` header.
 *
 * Two-character ISO 3166-1 alpha-2, plus Cloudflare's two specials: `XX` for a
 * client it has no country data for, and `T1` for one coming out of Tor.
 *
 * Only trusted on the same terms as `clientIp`: `TRUST_PROXY=cloudflare`, or
 * `TRUST_PROXY=true` with a `CF-Ray` present to show the request really did
 * pass through Cloudflare. Any client can *send* this header, so reading it
 * without that gate would let a visitor pick their own country. Returns null
 * when there is nothing trustworthy to report -- the column stays NULL rather
 * than being filled with a guess.
 */
export function clientCountry(state: AppState, req: Request): string | null {
	const mode = state.settings.trustProxyMode;
	if (mode === "off") return null;
	if (mode !== "cloudflare" && !req.header("cf-ray")) return null;
	const raw = (req.header("cf-ipcountry") ?? "").trim().toUpperCase();
	// A letter followed by a letter or digit: covers every ISO alpha-2 code and
	// both of Cloudflare's specials (XX is letters, T1 is not). Anything else is
	// a malformed header and is treated as absent.
	if (!/^[A-Z][A-Z0-9]$/.test(raw)) return null;
	return raw;
}
