import type { NextFunction, Request, Response } from "express";
import { Sentry, sentryEnabled } from "../sentry.ts";

/**
 * Names the request's trace after the *route pattern*. The SDK opens the root
 * `http.server` span (and continues the browser's `sentry-trace`) by itself;
 * left alone it is named from the URL, which would put share slugs into
 * transaction names. Once Express has matched a route this renames it to e.g.
 * `GET /api/file/:slug/info`.
 */
export function sentryTracing() {
	if (!sentryEnabled) {
		return (_req: Request, _res: Response, next: NextFunction) => next();
	}
	return (req: Request, res: Response, next: NextFunction): void => {
		const active = Sentry.getActiveSpan();
		const root = active ? Sentry.getRootSpan(active) : undefined;
		if (root) {
			res.once("finish", () => {
				const route = req.route?.path;
				if (typeof route !== "string") return;
				const pattern = `${req.baseUrl}${route}`;
				Sentry.updateSpanName(root, `${req.method} ${pattern}`);
				root.setAttribute("http.route", pattern);
			});
		}
		next();
	};
}
