import express, { type Request, type Response, Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import {
	nowIso,
	type OauthClientRow,
	type OauthTokenRow,
	type UserRow,
} from "../db/rows.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import {
	clientIp,
	requestProtocol,
	requireSession,
} from "../middleware/auth.ts";
import {
	requireActiveUser,
	requireOauthScope,
	requirePermission,
} from "../middleware/deps.ts";
import { ensurePermissions, hasPermission } from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import {
	consumeAuthCode,
	findClient,
	generateClientId,
	generateClientSecret,
	hashToken,
	isConfidential,
	issueAuthCode,
	issueTokens,
	OauthError,
	parseRedirectUris,
	parseScope,
	redirectUriAllowed,
	resolveRequestedScopes,
	revokeGrant,
	rotateRefreshToken,
	SCOPES,
	validateRedirectUri,
	verifyClientSecret,
	verifyPkce,
} from "../security/oauth.ts";

/** OAuth 2.0 authorization server, mounted at /api/oauth.
 *
 * The consent step is a *client-side* page (`/oauth/authorize` in the SPA), not
 * a server-rendered form: this app has no template layer, and the SPA already
 * owns the session cookie. So `GET /authorize/info` describes the pending
 * request for the page to render, and `POST /authorize` records the decision
 * and hands back the URL to bounce to. Everything else (`/token`, `/revoke`) is
 * the ordinary RFC 6749 machine surface, spoken to directly by third-party
 * apps. */

const MAX_CLIENTS_PER_USER = 20;
const MAX_REDIRECT_URIS = 10;

interface CountRow {
	n: number;
}

function serializeClient(c: OauthClientRow) {
	return {
		id: c.id,
		client_id: c.client_id,
		name: c.name,
		redirect_uris: parseRedirectUris(c),
		scopes: parseScope(c.scopes),
		confidential: isConfidential(c),
		active: !!c.active,
		created_at: c.created_at,
	};
}

/** Renders an OauthError as the RFC 6749 body shape. Note this is deliberately
 * NOT the app-wide {detail} envelope -- OAuth client libraries parse
 * {error, error_description} and will choke on anything else. */
function sendOauthError(res: Response, err: unknown): void {
	if (err instanceof OauthError) {
		res
			.status(err.status)
			.json({ error: err.code, error_description: err.description });
		return;
	}
	throw err;
}

/** Appends query params to a redirect_uri, preserving any it already carries. */
function buildRedirect(
	redirectUri: string,
	params: Record<string, string | undefined>,
): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	return url.toString();
}

interface AuthorizeRequest {
	client: OauthClientRow;
	redirectUri: string;
	scope: string[];
	state?: string;
	codeChallenge: string | null;
	codeChallengeMethod: string | null;
}

/** Validates the incoming /authorize parameters. Anything wrong with
 * `client_id` or `redirect_uri` must be reported to the *user*, never bounced
 * back to the supplied URI -- redirecting on an unvalidated redirect_uri is
 * exactly the open-redirect hole the exact-match rule exists to close. */
function parseAuthorizeRequest(
	state: AppState,
	source: Record<string, unknown>,
): AuthorizeRequest {
	const clientId = source.client_id;
	const redirectUri = source.redirect_uri;
	if (typeof clientId !== "string" || !clientId) {
		throw new OauthError("invalid_request", "client_id required");
	}
	if (typeof redirectUri !== "string" || !redirectUri) {
		throw new OauthError("invalid_request", "redirect_uri required");
	}
	const client = findClient(state.db, clientId);
	if (!client) {
		throw new OauthError("invalid_client", "unknown client_id", 401);
	}
	if (!redirectUriAllowed(client, redirectUri)) {
		throw new OauthError(
			"invalid_request",
			"redirect_uri is not registered for this client",
		);
	}
	const responseType = source.response_type;
	if (responseType !== undefined && responseType !== "code") {
		throw new OauthError(
			"invalid_request",
			"only response_type=code is supported",
		);
	}
	const scope = resolveRequestedScopes(
		client,
		parseScope(typeof source.scope === "string" ? source.scope : null),
	);

	const challenge = source.code_challenge;
	const method = source.code_challenge_method;
	if (challenge !== undefined && typeof challenge !== "string") {
		throw new OauthError("invalid_request", "invalid code_challenge");
	}
	if (challenge && method !== undefined && method !== "S256") {
		throw new OauthError(
			"invalid_request",
			"only code_challenge_method=S256 is supported",
		);
	}
	// A public client has no secret to authenticate the token exchange with, so
	// PKCE is the only thing standing between a stolen code and a token.
	if (!isConfidential(client) && !challenge) {
		throw new OauthError(
			"invalid_request",
			"code_challenge is required for public clients",
		);
	}
	return {
		client,
		redirectUri,
		scope,
		state: typeof source.state === "string" ? source.state : undefined,
		codeChallenge: typeof challenge === "string" ? challenge : null,
		codeChallengeMethod: challenge ? "S256" : null,
	};
}

/** Session-authenticated surface: app registration, the consent step, and the
 * user's own list of authorized apps. */
export function oauthRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	// ---- App registration (an app is owned by the user who registered it) ----

	router.post(
		"/clients",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_use_api_keys"),
		(req, res) => {
			const user = req.currentUser!;
			const { name, redirect_uris, scopes, confidential } = req.body ?? {};
			if (typeof name !== "string" || !name.trim() || name.length > 100) {
				res.status(400).json({ detail: "name required (1-100 chars)" });
				return;
			}
			if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
				res.status(400).json({ detail: "at least one redirect_uri required" });
				return;
			}
			if (redirect_uris.length > MAX_REDIRECT_URIS) {
				res
					.status(400)
					.json({ detail: `at most ${MAX_REDIRECT_URIS} redirect URIs` });
				return;
			}
			const uris: string[] = [];
			for (const uri of redirect_uris) {
				if (typeof uri !== "string" || !uri.trim()) {
					res.status(400).json({ detail: "redirect_uris must be strings" });
					return;
				}
				try {
					validateRedirectUri(uri.trim());
				} catch (err) {
					res.status(400).json({
						detail: err instanceof OauthError ? err.description : "bad URI",
					});
					return;
				}
				uris.push(uri.trim());
			}
			const requested = Array.isArray(scopes) ? scopes.map(String) : [];
			if (!requested.length) {
				res.status(400).json({ detail: "at least one scope required" });
				return;
			}
			for (const scope of requested) {
				if (!Object.hasOwn(SCOPES, scope)) {
					res.status(400).json({ detail: `unknown scope: ${scope}` });
					return;
				}
			}
			const activeCount = db.get<CountRow>(
				"SELECT COUNT(*) as n FROM oauth_clients WHERE owner_id = $id AND active = 1",
				{ $id: user.id },
			)!.n;
			if (activeCount >= MAX_CLIENTS_PER_USER) {
				res.status(429).json({
					detail: `app limit reached (${MAX_CLIENTS_PER_USER}); delete one first`,
				});
				return;
			}

			const clientId = generateClientId();
			// A confidential client gets a secret shown exactly once, like an API
			// key; a public one gets none and is forced onto PKCE at /authorize.
			const secret = confidential === false ? null : generateClientSecret();
			db.run(
				`INSERT INTO oauth_clients (
           client_id, client_secret_hash, name, owner_id, redirect_uris, scopes, active, created_at
         ) VALUES ($clientId, $secretHash, $name, $ownerId, $uris, $scopes, 1, $now)`,
				{
					$clientId: clientId,
					$secretHash: secret ? hashToken(secret) : null,
					$name: name.trim(),
					$ownerId: user.id,
					$uris: uris.join("\n"),
					$scopes: [...new Set(requested)].join(" "),
					$now: nowIso(),
				},
			);
			const client = findClient(db, clientId)!;
			recordAudit(db, {
				actor: user.username,
				action: "oauth.client_created",
				target: `oauth_client:${clientId}`,
				ip: clientIp(state, req),
			});
			res.json({ ...serializeClient(client), client_secret: secret });
		},
	);

	router.get("/clients", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const clients = db.all<OauthClientRow>(
			"SELECT * FROM oauth_clients WHERE owner_id = $id AND active = 1 ORDER BY id ASC",
			{ $id: user.id },
		);
		res.json({ clients: clients.map(serializeClient) });
	});

	router.delete(
		"/clients/:clientId",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const client = db.get<OauthClientRow>(
				"SELECT * FROM oauth_clients WHERE client_id = $clientId",
				{ $clientId: req.params.clientId },
			);
			if (!client) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && client.owner_id !== user.id) {
				res.status(403).json({ detail: "not your app" });
				return;
			}
			db.transaction(() => {
				// Deleting the app must kill everything it can still act with --
				// leaving live tokens behind would let a deleted app keep calling.
				db.run("DELETE FROM oauth_tokens WHERE client_id = $clientId", {
					$clientId: client.client_id,
				});
				db.run("DELETE FROM oauth_auth_codes WHERE client_id = $clientId", {
					$clientId: client.client_id,
				});
				db.run("DELETE FROM oauth_clients WHERE id = $id", { $id: client.id });
			});
			recordAudit(db, {
				actor: user.username,
				action: "oauth.client_deleted",
				target: `oauth_client:${client.client_id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

	// ---- Consent step (rendered by the SPA at /oauth/authorize) ----

	router.get("/authorize/info", requireActiveUser(state), (req, res) => {
		try {
			const parsed = parseAuthorizeRequest(
				state,
				req.query as Record<string, unknown>,
			);
			const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: parsed.client.owner_id,
			});
			const user = req.currentUser!;
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			res.json({
				client: {
					client_id: parsed.client.client_id,
					name: parsed.client.name,
					owner_username: owner?.username ?? null,
				},
				redirect_uri: parsed.redirectUri,
				state: parsed.state ?? null,
				// Per-scope grantability: the user cannot delegate a permission they
				// do not hold, and the page says so rather than failing at approval.
				scopes: parsed.scope.map((scope) => {
					const flag = SCOPES[scope] ?? null;
					return {
						scope,
						requires: flag,
						granted:
							user.role === "master" || !flag || hasPermission(perm, flag),
					};
				}),
			});
		} catch (err) {
			sendOauthError(res, err);
		}
	});

	router.post(
		"/authorize",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			try {
				const body = (req.body ?? {}) as Record<string, unknown>;
				const parsed = parseAuthorizeRequest(state, body);
				const user = req.currentUser!;

				if (body.approve !== true) {
					recordAudit(db, {
						actor: user.username,
						action: "oauth.authorize_denied",
						target: `oauth_client:${parsed.client.client_id}`,
						ip: clientIp(state, req),
					});
					res.json({
						redirect_to: buildRedirect(parsed.redirectUri, {
							error: "access_denied",
							error_description: "the user denied the request",
							state: parsed.state,
						}),
					});
					return;
				}

				// Re-check every scope against live permissions: the ceiling is what
				// this user can do *now*, not what the app asked for.
				const perm = ensurePermissions(db, user.id, {
					master: user.role === "master",
				});
				for (const scope of parsed.scope) {
					const flag = SCOPES[scope] ?? null;
					if (user.role !== "master" && flag && !hasPermission(perm, flag)) {
						throw new OauthError(
							"access_denied",
							`you do not hold the permission required by scope: ${scope}`,
							403,
						);
					}
				}

				const issued = issueAuthCode(db, {
					client: parsed.client,
					userId: user.id,
					redirectUri: parsed.redirectUri,
					scope: parsed.scope,
					codeChallenge: parsed.codeChallenge,
					codeChallengeMethod: parsed.codeChallengeMethod,
				});
				recordAudit(db, {
					actor: user.username,
					action: "oauth.authorize_granted",
					target: `oauth_client:${parsed.client.client_id}`,
					ip: clientIp(state, req),
				});
				res.json({
					redirect_to: buildRedirect(parsed.redirectUri, {
						code: issued.code,
						state: parsed.state,
					}),
				});
			} catch (err) {
				sendOauthError(res, err);
			}
		},
	);

	// ---- The user's own view of what they have authorized ----

	router.get("/authorizations", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const rows = db.all<OauthTokenRow>(
			`SELECT * FROM oauth_tokens
         WHERE user_id = $id AND revoked_at IS NULL AND expires_at > $now
         ORDER BY created_at DESC`,
			{ $id: user.id, $now: nowIso() },
		);
		// One entry per app, not per token: an app that has refreshed ten times is
		// still one authorization from the user's point of view.
		const byClient = new Map<
			string,
			{
				client_id: string;
				name: string | null;
				scopes: string[];
				authorized_at: string;
				last_used_at: string | null;
			}
		>();
		for (const row of rows) {
			const existing = byClient.get(row.client_id);
			if (existing) {
				existing.scopes = [
					...new Set([...existing.scopes, ...parseScope(row.scope)]),
				];
				if (
					row.last_used_at &&
					(!existing.last_used_at || row.last_used_at > existing.last_used_at)
				) {
					existing.last_used_at = row.last_used_at;
				}
				if (row.created_at < existing.authorized_at) {
					existing.authorized_at = row.created_at;
				}
				continue;
			}
			const client = findClient(db, row.client_id);
			byClient.set(row.client_id, {
				client_id: row.client_id,
				name: client?.name ?? null,
				scopes: parseScope(row.scope),
				authorized_at: row.created_at,
				last_used_at: row.last_used_at,
			});
		}
		res.json({ authorizations: [...byClient.values()] });
	});

	router.delete(
		"/authorizations/:clientId",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			db.run(
				`UPDATE oauth_tokens SET revoked_at = $now
           WHERE user_id = $userId AND client_id = $clientId AND revoked_at IS NULL`,
				{
					$now: nowIso(),
					$userId: user.id,
					$clientId: req.params.clientId,
				},
			);
			recordAudit(db, {
				actor: user.username,
				action: "oauth.authorization_revoked",
				target: `oauth_client:${req.params.clientId}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "revoked" });
		},
	);

	return router;
}

/** Client-facing machine surface: no session, no CSRF (there is no cookie to
 * ride on), form-encoded bodies as RFC 6749 requires. Mounted at /api/oauth
 * alongside oauthRouter. */
export function oauthPublicRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	// OAuth clients POST application/x-www-form-urlencoded; app.ts only installs
	// express.json(), so the parser is added here rather than globally.
	const form = express.urlencoded({ extended: false, limit: "16kb" });

	/** Client authentication: HTTP Basic (preferred by RFC 6749) or form body. */
	function authenticateClient(req: Request): OauthClientRow {
		let clientId = req.body?.client_id as string | undefined;
		let secret = req.body?.client_secret as string | undefined;

		const authz = req.header("authorization") ?? "";
		if (authz.startsWith("Basic ")) {
			const decoded = Buffer.from(authz.slice(6), "base64").toString("utf-8");
			const idx = decoded.indexOf(":");
			if (idx === -1) {
				throw new OauthError("invalid_client", "malformed Basic header", 401);
			}
			clientId = decodeURIComponent(decoded.slice(0, idx));
			secret = decodeURIComponent(decoded.slice(idx + 1));
		}
		if (!clientId) {
			throw new OauthError("invalid_client", "client_id required", 401);
		}
		const client = findClient(db, clientId);
		if (!client) {
			throw new OauthError("invalid_client", "unknown client", 401);
		}
		verifyClientSecret(client, secret);
		return client;
	}

	router.post(
		"/token",
		form,
		asyncHandler(async (req, res) => {
			// Tokens must never be cached by an intermediary (RFC 6749 §5.1).
			res.set("Cache-Control", "no-store");
			res.set("Pragma", "no-cache");
			try {
				const client = authenticateClient(req);
				const grantType = req.body?.grant_type;

				if (grantType === "authorization_code") {
					const code = req.body?.code;
					if (typeof code !== "string" || !code) {
						throw new OauthError("invalid_request", "code required");
					}
					const consumed = consumeAuthCode(db, code);
					if (!consumed) {
						throw new OauthError("invalid_grant", "unknown code");
					}
					const { row, replayed } = consumed;
					if (replayed) {
						// A second redemption means the code leaked. Everything already
						// minted from it is suspect, so the grant dies.
						revokeGrant(db, row.grant_id);
						throw new OauthError("invalid_grant", "code already used");
					}
					if (row.client_id !== client.client_id) {
						throw new OauthError(
							"invalid_grant",
							"code was issued to another client",
						);
					}
					if (row.expires_at <= nowIso()) {
						throw new OauthError("invalid_grant", "code expired");
					}
					const redirectUri = req.body?.redirect_uri;
					if (redirectUri !== row.redirect_uri) {
						throw new OauthError("invalid_grant", "redirect_uri mismatch");
					}
					verifyPkce(row, req.body?.code_verifier);

					const tokens = issueTokens(db, {
						clientId: client.client_id,
						userId: row.user_id,
						scope: parseScope(row.scope),
						grantId: row.grant_id,
					});
					recordAudit(db, {
						actor: `oauth:${client.client_id}`,
						action: "oauth.token_issued",
						target: `user:${row.user_id}`,
						ip: clientIp(state, req),
					});
					res.json(tokens);
					return;
				}

				if (grantType === "refresh_token") {
					const presented = req.body?.refresh_token;
					if (typeof presented !== "string" || !presented) {
						throw new OauthError("invalid_request", "refresh_token required");
					}
					const { tokens } = rotateRefreshToken(
						db,
						presented,
						client.client_id,
					);
					res.json(tokens);
					return;
				}

				throw new OauthError(
					"unsupported_grant_type",
					"supported grant types: authorization_code, refresh_token",
				);
			} catch (err) {
				sendOauthError(res, err);
			}
		}),
	);

	router.post("/revoke", form, (req, res) => {
		res.set("Cache-Control", "no-store");
		try {
			const client = authenticateClient(req);
			const token = req.body?.token;
			if (typeof token !== "string" || !token) {
				throw new OauthError("invalid_request", "token required");
			}
			const row = db.get<OauthTokenRow>(
				"SELECT * FROM oauth_tokens WHERE token_hash = $hash",
				{ $hash: hashToken(token) },
			);
			// RFC 7009: an unknown token is a success, so a client can't probe for
			// which tokens exist. A token belonging to another client is likewise
			// answered 200 without touching it.
			if (row && row.client_id === client.client_id) {
				revokeGrant(db, row.grant_id);
			}
			res.json({ status: "revoked" });
		} catch (err) {
			sendOauthError(res, err);
		}
	});

	/** Minimal identity endpoint -- the `profile` scope's entire payload. */
	router.get("/userinfo", requireOauthScope(state, "profile"), (req, res) => {
		const user = req.currentUser!;
		res.json({
			sub: String(user.id),
			username: user.username,
			role: user.role,
			scope: req.oauthToken?.scope ?? "",
		});
	});

	/** Discovery document (RFC 8414 shape, served under /api/oauth rather than
	 * a root .well-known path so it stays inside the /api namespace). */
	router.get("/metadata", (req, res) => {
		const base = `${requestProtocol(state.settings, req)}://${req.get("host")}`;
		res.json({
			issuer: base,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/api/oauth/token`,
			revocation_endpoint: `${base}/api/oauth/revoke`,
			userinfo_endpoint: `${base}/api/oauth/userinfo`,
			scopes_supported: Object.keys(SCOPES),
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			token_endpoint_auth_methods_supported: [
				"client_secret_basic",
				"client_secret_post",
				"none",
			],
			code_challenge_methods_supported: ["S256"],
		});
	});

	return router;
}

/** Exposed for routes/users.ts: an account being deleted takes its apps, its
 * grants and every token issued to it along with it. */
export function purgeOauthForUser(state: AppState, userId: number): void {
	const { db } = state;
	const clients = db.all<OauthClientRow>(
		"SELECT * FROM oauth_clients WHERE owner_id = $id",
		{ $id: userId },
	);
	for (const client of clients) {
		db.run("DELETE FROM oauth_tokens WHERE client_id = $clientId", {
			$clientId: client.client_id,
		});
		db.run("DELETE FROM oauth_auth_codes WHERE client_id = $clientId", {
			$clientId: client.client_id,
		});
	}
	db.run("DELETE FROM oauth_clients WHERE owner_id = $id", { $id: userId });
	db.run("DELETE FROM oauth_tokens WHERE user_id = $id", { $id: userId });
	db.run("DELETE FROM oauth_auth_codes WHERE user_id = $id", { $id: userId });
}
