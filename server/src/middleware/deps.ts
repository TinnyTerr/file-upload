import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import type { ApiKeyRow, OauthTokenRow, UserRow } from "../db/rows.ts";
import {
	ensurePermissions,
	hasPermission,
	missingRequiredCredential,
	type PermissionFlag,
} from "../permissions.ts";
import { bindOrReject, hashKey } from "../security/apiKeys.ts";
import {
	ACCESS_TOKEN_PREFIX,
	findLiveToken,
	parseScope,
	SCOPES,
	touchToken,
} from "../security/oauth.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { clientIp } from "./auth.ts";

declare module "express-serve-static-core" {
	interface Request {
		currentUser?: UserRow;
		apiKey?: ApiKeyRow;
		oauthToken?: OauthTokenRow;
	}
}

/** The 403 an account gets when `require_mfa`/`require_passkey` is set but the
 * matching credential isn't enrolled yet. Same shape as the
 * must_change_credentials block: everything is refused except the one surface
 * that lets the account fix itself -- here the enrollment routes under
 * /api/account/mfa, which authenticate with `requireSession` rather than
 * `requireActiveUser` and so never reach this gate. */
export function enrollmentBlock(
	res: Response,
	missing: "passkey" | "mfa",
): void {
	res.status(403).json({
		detail:
			missing === "passkey"
				? "passkey enrollment required"
				: "mfa enrollment required",
	});
}

/** Mirrors app/deps.py::require_active_user. Resolves the session cookie if
 * requireSession hasn't already, loads the user, and rejects accounts still
 * on their one-time bootstrap credentials or missing a required second
 * factor. */
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
		const missing = missingRequiredCredential(state.db, user);
		if (missing) {
			enrollmentBlock(res, missing);
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

/** Resolves an OAuth access token presented as `Authorization: Bearer fuo_...`
 * and checks it carries `scope`.
 *
 * The scope is *not* the last word on what the token may do: the permission
 * flag the scope maps to is re-checked against the user's live permissions on
 * every request, so revoking (say) can_upload immediately neuters every
 * outstanding token carrying files:write, without having to hunt them down. */
function resolveOauthBearer(
	state: AppState,
	req: Request,
	res: Response,
	scope: string,
): UserRow | null {
	const db = state.db;
	const raw = (req.header("authorization") ?? "")
		.slice("Bearer ".length)
		.trim();
	const token = findLiveToken(db, raw, "access");
	if (!token) {
		res.status(401).json({ detail: "invalid or expired access token" });
		return null;
	}
	if (!parseScope(token.scope).includes(scope)) {
		res
			.status(403)
			.json({ detail: `token is missing required scope: ${scope}` });
		return null;
	}
	const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: token.user_id,
	});
	if (!user || user.must_change_credentials) {
		res.status(401).json({ detail: "invalid access token subject" });
		return null;
	}
	const flag = SCOPES[scope] ?? null;
	if (flag && user.role !== "master") {
		const perm = ensurePermissions(db, user.id, {
			master: user.role === "master",
		});
		if (!hasPermission(perm, flag)) {
			res.status(403).json({ detail: "permission denied" });
			return null;
		}
	}
	touchToken(db, token);
	req.oauthToken = token;
	req.currentUser = user;
	return user;
}

/** True when the Bearer value is an OAuth access token rather than an API key.
 * API keys carry no prefix, so the prefix is what disambiguates the two
 * credential tables without probing both. */
function isOauthBearer(req: Request): boolean {
	const header = req.header("authorization") ?? "";
	return header.startsWith(`Bearer ${ACCESS_TOKEN_PREFIX}`);
}

/** Bearer-only guard for endpoints that exist purely for OAuth clients
 * (routes/oauth.ts's /userinfo). */
export function requireOauthScope(
	state: AppState,
	scope: string,
): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		if (!isOauthBearer(req)) {
			res.status(401).json({ detail: "missing oauth access token" });
			return;
		}
		if (!resolveOauthBearer(state, req, res, scope)) return;
		next();
	};
}

/** Best-effort OAuth identification for endpoints that serve signed-out
 * visitors too (routes/media.ts's public library). Returns null instead of
 * writing a response, so an absent or bad token simply means "not signed in". */
export function optionalOauthViewer(
	state: AppState,
	req: Request,
	scope: string,
): UserRow | null {
	if (!isOauthBearer(req)) return null;
	const raw = (req.header("authorization") ?? "")
		.slice("Bearer ".length)
		.trim();
	const token = findLiveToken(state.db, raw, "access");
	if (!token || !parseScope(token.scope).includes(scope)) return null;
	const user = state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: token.user_id,
	});
	if (!user || user.must_change_credentials) return null;
	touchToken(state.db, token);
	req.oauthToken = token;
	return user;
}

/** Session cookie OR an OAuth access token carrying `scope`.
 *
 * GET-only: the session branch performs no CSRF check (matching
 * requireReadUser's reasoning -- CSRF exists to stop cross-site *writes*), and
 * an OAuth token isn't ambient credentials, so it can't be ridden cross-site
 * either. API keys are deliberately not accepted here: which routes they reach
 * is existing behaviour, and this middleware is only about extending OAuth. */
export function requireScopeOrSession(
	state: AppState,
	scope: string,
): RequestHandler {
	const session = requireActiveUser(state);
	return (req: Request, res: Response, next: NextFunction): void => {
		if (isOauthBearer(req)) {
			if (!resolveOauthBearer(state, req, res, scope)) return;
			next();
			return;
		}
		session(req, res, next);
	};
}

/** Mirrors app/deps.py::get_upload_user: session+CSRF auth OR Bearer API key /
 * OAuth access token; either way the user must hold can_upload. */
export function getUploadUser(state: AppState): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		const db = state.db;
		const authHeader = req.header("authorization") ?? "";
		if (isOauthBearer(req)) {
			if (!resolveOauthBearer(state, req, res, "files:write")) return;
			next();
			return;
		}
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
			const missing = missingRequiredCredential(db, user);
			if (missing) {
				enrollmentBlock(res, missing);
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
		const missing = missingRequiredCredential(db, user);
		if (missing) {
			enrollmentBlock(res, missing);
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

/** Read-only sibling of getUploadUser: Bearer API key OR session cookie, with
 * no permission and no CSRF check. Safe to use on GETs only -- CSRF exists to
 * stop cross-site *writes*, and demanding the header here would lock out plain
 * `fetch`/curl callers that legitimately hold a session. */
export function requireReadUser(state: AppState): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		const db = state.db;
		const authHeader = req.header("authorization") ?? "";
		if (isOauthBearer(req)) {
			if (!resolveOauthBearer(state, req, res, "files:read")) return;
			next();
			return;
		}
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
			const keyOwnerMissing = missingRequiredCredential(db, user);
			if (keyOwnerMissing) {
				enrollmentBlock(res, keyOwnerMissing);
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
		const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: row.user_id,
		});
		if (!user || user.must_change_credentials) {
			res.status(401).json({ detail: "not authenticated" });
			return;
		}
		const missing = missingRequiredCredential(db, user);
		if (missing) {
			enrollmentBlock(res, missing);
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
