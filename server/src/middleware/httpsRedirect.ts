import type { NextFunction, Request, Response } from "express";
import type { Settings } from "../config.ts";

/** Mirrors app/main.py::_HttpsRedirect: outside dev, redirects http->https
 * with 308, honoring X-Forwarded-Proto/Host only when trust_proxy is set and
 * the host is in the allowed list. */
export function httpsRedirect(settings: Settings) {
	const allowedHosts = new Set(
		settings.allowedHosts
			.split(",")
			.map((h) => h.trim())
			.filter(Boolean),
	);

	return (req: Request, res: Response, next: NextFunction): void => {
		if (settings.appEnv === "dev") {
			next();
			return;
		}
		const host = req.header("host") ?? "";
		let proto = req.protocol;
		let effectiveHost = host;
		// An empty ALLOWED_HOSTS means "not configured", not "deny all" -- config.ts
		// never generates it, so requiring an exact host match here would make
		// TRUST_PROXY=true behind any reverse proxy 308-redirect forever (req.protocol
		// stays http, the host is never in the empty set). Falling back to trusting
		// the proxy when the allowlist is empty still requires the operator to have
		// explicitly opted in via TRUST_PROXY; TRUST_PROXY=false still yields no
		// proxy trust regardless of allowedHosts.
		if (
			settings.trustProxy &&
			(allowedHosts.size === 0 || allowedHosts.has(host))
		) {
			proto = req.header("x-forwarded-proto") || proto;
			effectiveHost = req.header("x-forwarded-host") || host;
		}
		if (proto !== "https") {
			res.redirect(308, `https://${effectiveHost}${req.originalUrl}`);
			return;
		}
		next();
	};
}
