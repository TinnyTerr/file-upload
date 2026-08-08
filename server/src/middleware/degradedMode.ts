import type { NextFunction, Request, Response } from "express";
import type { AppState } from "../appState.ts";
import { isDegraded } from "../cluster/degraded.ts";
import { getLogger } from "../logging.ts";

/**
 * Degraded mode's write gate (redesign §5.5).
 *
 * When this node has been unable to reach the master for longer than the
 * restart grace window, it stops accepting writes. Reads keep working — every
 * read in this system is local by construction, which is the property that made
 * Option C (a shared Postgres) the wrong answer in Part 6 and is what makes a
 * degraded node genuinely useful rather than merely up.
 *
 * **It gates by method, with an allowlist, rather than by enumerating the write
 * routes.** Two reasons. It fails *closed*: a route added later is refused
 * while degraded unless someone deliberately allowlists it, whereas an
 * enumeration silently omits it and the omission is invisible until a cluster
 * splits. And the allowlist is short enough to read, which an enumeration of
 * every mutating route in the app would not be.
 *
 * What stays open, and why each one:
 *
 * | Prefix | Why it survives |
 * |---|---|
 * | `/api/auth` | Sessions are node-local. An operator has to be able to log in *to* a degraded node to fix it, and cutting off logout would strand sessions. |
 * | `/api/cluster`, `/api/admin/cluster` | The endpoints that diagnose and end the outage, including `/promote`. Gating these would make degraded mode unrecoverable. |
 * | `/api/oauth` | `oauth_clients`/`_codes`/`_tokens` are node-local by design; a token exchange writes nothing that replicates. |
 * | `/api/media` | Play keys are node-local and are how external players authenticate. §5.5 lists media streaming as surviving. |
 * | `/file/`, `/d/` | Public read paths that happen to POST — unlocking a key-protected node, and preview manifests. No replicated write behind them. |
 *
 * Everything else that mutates is refused with a 503 naming the cause. That
 * includes uploads (quota is unverifiable), renames/moves/deletes (no ordering
 * authority), permission and quota changes, link creation, encryption changes
 * and sealing — exactly §5.5's table.
 */

const log = getLogger("app.degraded");

const ALLOWED_PREFIXES = [
	"/api/auth",
	"/api/cluster",
	"/api/admin/cluster",
	"/api/oauth",
	"/api/media",
	"/api/file/",
	"/api/d/",
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function degradedMode(state: AppState) {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (READ_METHODS.has(req.method)) {
			next();
			return;
		}
		const path = req.path;
		if (ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
			next();
			return;
		}
		if (!isDegraded(state)) {
			next();
			return;
		}
		log.warning(`degraded: refusing ${req.method} ${path}`);
		res.status(503).json({
			detail:
				"this node cannot reach the cluster master, so it is read-only. " +
				"Writes resume when the master returns, or when an operator promotes a node.",
			degraded: true,
		});
	};
}
