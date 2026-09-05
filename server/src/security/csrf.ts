import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { SessionRow } from "./sessions.ts";

/** Constant-time check of a presented CSRF header against the session's
 * token. Every other secret comparison in this codebase is constant-time; the
 * CSRF token is no less a secret for being per-session. */
export function csrfMatches(
	presented: string | undefined,
	row: SessionRow,
): boolean {
	if (!presented) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(row.csrf_token);
	return a.length === b.length && timingSafeEqual(a, b);
}

declare module "express-serve-static-core" {
	interface Request {
		sessionRow?: SessionRow;
	}
}

/** Requires an already-resolved req.sessionRow (see currentSession middleware)
 * and a matching X-CSRF-Token header. Mirrors app/security/csrf.py::require_csrf. */
export function requireCsrf(
	req: Request,
	res: Response,
	next: NextFunction,
): void {
	const sessionRow = req.sessionRow;
	if (!sessionRow) {
		res.status(401).json({ detail: "not authenticated" });
		return;
	}
	if (!csrfMatches(req.header("x-csrf-token"), sessionRow)) {
		res.status(403).json({ detail: "invalid or missing CSRF token" });
		return;
	}
	next();
}
