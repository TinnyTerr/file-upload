import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import type { ApiKeyRow, UserRow } from "../db/rows.ts";
import {
	ensurePermissions,
	hasPermission,
	type PermissionFlag,
} from "../permissions.ts";
import { bindOrReject, hashKey } from "../security/apiKeys.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { clientIp } from "./auth.ts";

declare module "express-serve-static-core" {
	interface Request {
		currentUser?: UserRow;
		apiKey?: ApiKeyRow;
	}
}

/** Mirrors app/deps.py::require_active_user. Resolves the session cookie if
 * requireSession hasn't already, loads the user, and rejects accounts still
 * on their one-time bootstrap credentials. */
export function requireActiveUser(state: AppState): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (!req.sessionRow) {
			const cookieValue = req.cookies?.[COOKIE_NAME] as string | undefined;
			const row = state.sessionManager.resolve(state.db, cookieValue);
			if (!row) {
				res.status(401).json({ detail: "not authenticated" });
				return;
			}
			req.sessionRow = row;
		}
		const user = state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: req.sessionRow.user_id,
		});
		if (!user) {
			res.status(401).json({ detail: "not authenticated" });
			return;
		}
		if (user.must_change_credentials) {
			res.status(403).json({ detail: "must change credentials" });
			return;
		}
		req.currentUser = user;
		next();
	};
}

/** Mirrors app/deps.py::require_master. */
export function requireMaster(state: AppState): RequestHandler {
	const active = requireActiveUser(state);
	return (req, res, next) => {
		active(req, res, () => {
			if (req.currentUser!.role !== "master") {
				res.status(403).json({ detail: "master only" });
				return;
			}
			next();
		});
	};
}

/** Mirrors app/deps.py::require_permission(name). */
export function requirePermission(
	state: AppState,
	name: PermissionFlag,
): RequestHandler {
	const active = requireActiveUser(state);
	return (req, res, next) => {
		active(req, res, () => {
			const user = req.currentUser!;
			const perm = ensurePermissions(state.db, user.id, {
				master: user.role === "master",
			});
			if (!hasPermission(perm, name)) {
				res.status(403).json({ detail: "permission denied" });
				return;
			}
			next();
		});
	};
}

function resolveApiKey(
	state: AppState,
	req: Request,
	res: Response,
): ApiKeyRow | null {
	const header = req.header("authorization") ?? "";
	const raw = header.slice("Bearer ".length).trim();
	if (!raw) {
		res.status(401).json({ detail: "missing api key" });
		return null;
	}
	const apiKey = state.db.get<ApiKeyRow>(
		"SELECT * FROM api_keys WHERE key_hash = $hash AND active = 1",
		{
			$hash: hashKey(raw),
		},
	);
	if (!apiKey) {
		res.status(401).json({ detail: "invalid api key" });
		return null;
	}
	const ip = clientIp(state, req);
	if (!bindOrReject(state.db, apiKey, ip)) {
		recordAudit(state.db, {
			actor: `apikey:${apiKey.id}`,
			action: "apikey.ip_rejected",
			target: `apikey:${apiKey.id}`,
			ip,
		});
		res.status(403).json({ detail: "api key ip mismatch" });
		return null;
	}
	return apiKey;
}

/** Mirrors app/deps.py::get_upload_user: session+CSRF auth OR Bearer API key
 * auth; either way the user must hold can_upload. */
export function getUploadUser(state: AppState): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		const db = state.db;
		const authHeader = req.header("authorization") ?? "";
		if (authHeader.startsWith("Bearer ")) {
			const apiKey = resolveApiKey(state, req, res);
			if (!apiKey) return;
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: apiKey.owner_id,
			});
			if (!user || user.must_change_credentials) {
				res.status(401).json({ detail: "invalid api key owner" });
				return;
			}
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!hasPermission(perm, "can_upload")) {
				res.status(403).json({ detail: "permission denied" });
				return;
			}
			req.apiKey = apiKey;
			req.currentUser = user;
			next();
			return;
		}

		const cookieValue = req.cookies?.[COOKIE_NAME] as string | undefined;
		const row = state.sessionManager.resolve(db, cookieValue);
		if (!row) {
			res.status(401).json({ detail: "not authenticated" });
			return;
		}
		const csrf = req.header("x-csrf-token") ?? "";
		if (!csrf || csrf !== row.csrf_token) {
			res.status(403).json({ detail: "invalid or missing CSRF token" });
			return;
		}
		const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: row.user_id,
		});
		if (!user || user.must_change_credentials) {
			res.status(401).json({ detail: "not authenticated" });
			return;
		}
		const perm = ensurePermissions(db, user.id, {
			master: user.role === "master",
		});
		if (!hasPermission(perm, "can_upload")) {
			res.status(403).json({ detail: "permission denied" });
			return;
		}
		req.sessionRow = row;
		req.currentUser = user;
		next();
	};
}

/** Mirrors app/deps.py::require_api_key (Bearer-only auth). */
export function requireApiKey(state: AppState): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		const header = req.header("authorization") ?? "";
		if (!header.startsWith("Bearer ")) {
			res.status(401).json({ detail: "missing api key" });
			return;
		}
		const apiKey = resolveApiKey(state, req, res);
		if (!apiKey) return;
		req.apiKey = apiKey;
		next();
	};
}
