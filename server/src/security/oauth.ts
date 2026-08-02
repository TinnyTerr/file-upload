import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	nowIso,
	type OauthAuthCodeRow,
	type OauthClientRow,
	type OauthTokenRow,
} from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import type { PermissionFlag } from "../permissions.ts";

/** OAuth 2.0 authorization-code flow with PKCE (RFC 6749 + RFC 7636), backing
 * routes/oauth.ts. Third-party apps act *as* a fileupload user, so a token can
 * never exceed what that user could do themselves: every scope names the
 * permission flag it needs, and middleware/deps.ts re-checks the flag on every
 * request rather than trusting the scope recorded at grant time. */

/** Access tokens are prefixed so middleware/deps.ts can route a Bearer value to
 * the right table without probing both -- API keys carry no prefix. */
export const ACCESS_TOKEN_PREFIX = "fuo_";
const REFRESH_TOKEN_PREFIX = "fur_";

export const AUTH_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Every scope this server will issue, and the permission its bearer must hold.
 * `null` means the scope needs no flag beyond being a live account -- it only
 * ever exposes the user's own data.
 *
 * Deliberately small: a scope only belongs here once some endpoint actually
 * honours it, or an app would be granted something that silently does nothing.
 * Adding one means wiring requireScopeOrSession (or getUploadUser's OAuth
 * branch) into the routes it is supposed to unlock -- see middleware/deps.ts. */
export const SCOPES: Record<string, PermissionFlag | null> = {
	profile: null,
	"files:read": null,
	"files:write": "can_upload",
	"directories:read": null,
	"media:read": "can_watch_media",
};

export type OauthErrorCode =
	| "invalid_request"
	| "invalid_client"
	| "invalid_grant"
	| "invalid_scope"
	| "unauthorized_client"
	| "unsupported_grant_type"
	| "access_denied"
	| "server_error";

/** An OAuth-shaped failure. Rendered as {error, error_description} by
 * routes/oauth.ts -- deliberately NOT the app-wide {detail} shape, because
 * OAuth clients parse the RFC 6749 body. */
export class OauthError extends Error {
	constructor(
		readonly code: OauthErrorCode,
		readonly description: string,
		readonly status = 400,
	) {
		super(`${code}: ${description}`);
		this.name = "OauthError";
	}
}

export function hashToken(plain: string): string {
	return createHash("sha256").update(plain, "utf-8").digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf-8");
	const right = Buffer.from(b, "utf-8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function generateClientId(): string {
	return `fuc_${randomBytes(16).toString("hex")}`;
}

export function generateClientSecret(): string {
	return randomBytes(32).toString("base64url");
}

/** Splits a space-separated scope string, dropping empties and duplicates. */
export function parseScope(raw: string | undefined | null): string[] {
	if (!raw) return [];
	return [...new Set(raw.split(/\s+/).filter(Boolean))];
}

export function isKnownScope(scope: string): boolean {
	return Object.hasOwn(SCOPES, scope);
}

/** Narrows a requested scope set to what the client is registered for.
 * Unknown or unregistered scopes are an error, never silently dropped -- an app
 * that thinks it got `files:write` and didn't would fail confusingly later. */
export function resolveRequestedScopes(
	client: OauthClientRow,
	requested: string[],
): string[] {
	const allowed = new Set(parseScope(client.scopes));
	const scopes = requested.length ? requested : parseScope(client.scopes);
	for (const scope of scopes) {
		if (!isKnownScope(scope)) {
			throw new OauthError("invalid_scope", `unknown scope: ${scope}`);
		}
		if (!allowed.has(scope)) {
			throw new OauthError(
				"invalid_scope",
				`client is not registered for scope: ${scope}`,
			);
		}
	}
	if (!scopes.length) {
		throw new OauthError("invalid_scope", "no scopes requested");
	}
	return scopes;
}

export function parseRedirectUris(client: OauthClientRow): string[] {
	return client.redirect_uris
		.split("\n")
		.map((u) => u.trim())
		.filter(Boolean);
}

/** Exact-match redirect_uri validation. Prefix or origin matching would let an
 * open redirect or a path on the same host receive somebody's code. */
export function redirectUriAllowed(
	client: OauthClientRow,
	redirectUri: string,
): boolean {
	return parseRedirectUris(client).includes(redirectUri);
}

/** A redirect_uri is only usable if it is https, or a loopback/custom-scheme
 * URL of the kind native apps use. Plain http to a remote host would leak the
 * code over the wire. */
export function validateRedirectUri(uri: string): void {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new OauthError("invalid_request", `invalid redirect_uri: ${uri}`);
	}
	if (parsed.hash) {
		throw new OauthError(
			"invalid_request",
			"redirect_uri must not contain a fragment",
		);
	}
	if (parsed.protocol === "https:") return;
	if (
		parsed.protocol === "http:" &&
		(parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "[::1]" ||
			parsed.hostname === "::1")
	) {
		return;
	}
	// A private-use scheme (com.example.app:/cb) has no host component.
	if (parsed.protocol !== "http:" && parsed.protocol.includes(".")) return;
	throw new OauthError(
		"invalid_request",
		"redirect_uri must be https, a loopback http URL, or a private-use scheme",
	);
}

export function findClient(
	db: Db,
	clientId: string,
): OauthClientRow | undefined {
	return db.get<OauthClientRow>(
		"SELECT * FROM oauth_clients WHERE client_id = $clientId AND active = 1",
		{ $clientId: clientId },
	);
}

export function isConfidential(client: OauthClientRow): boolean {
	return client.client_secret_hash !== null;
}

/** Verifies a PKCE code_verifier against the challenge recorded on the code.
 * S256 only: `plain` offers no protection against an attacker who can already
 * read the authorization request. */
export function verifyPkce(code: OauthAuthCodeRow, verifier: unknown): void {
	if (!code.code_challenge) return;
	if (typeof verifier !== "string" || !verifier) {
		throw new OauthError("invalid_grant", "code_verifier required");
	}
	if (verifier.length < 43 || verifier.length > 128) {
		throw new OauthError("invalid_grant", "malformed code_verifier");
	}
	const digest = createHash("sha256")
		.update(verifier, "ascii")
		.digest("base64url");
	if (!constantTimeEquals(digest, code.code_challenge)) {
		throw new OauthError("invalid_grant", "code_verifier mismatch");
	}
}

export function verifyClientSecret(
	client: OauthClientRow,
	secret: unknown,
): void {
	if (!client.client_secret_hash) return;
	if (typeof secret !== "string" || !secret) {
		throw new OauthError("invalid_client", "client_secret required", 401);
	}
	if (!constantTimeEquals(hashToken(secret), client.client_secret_hash)) {
		throw new OauthError("invalid_client", "invalid client credentials", 401);
	}
}

export interface IssuedCode {
	code: string;
	expiresAt: string;
}

/** Mints a one-time authorization code bound to the client, user, redirect_uri
 * and (when present) the PKCE challenge. */
export function issueAuthCode(
	db: Db,
	params: {
		client: OauthClientRow;
		userId: number;
		redirectUri: string;
		scope: string[];
		codeChallenge: string | null;
		codeChallengeMethod: string | null;
	},
): IssuedCode {
	const code = randomBytes(32).toString("base64url");
	const now = Date.now();
	const expiresAt = new Date(now + AUTH_CODE_TTL_MS).toISOString();
	db.run(
		`INSERT INTO oauth_auth_codes (
       code_hash, client_id, user_id, redirect_uri, scope, code_challenge,
       code_challenge_method, grant_id, expires_at, created_at
     ) VALUES (
       $hash, $clientId, $userId, $redirectUri, $scope, $challenge,
       $method, $grantId, $expiresAt, $now
     )`,
		{
			$hash: hashToken(code),
			$clientId: params.client.client_id,
			$userId: params.userId,
			$redirectUri: params.redirectUri,
			$scope: params.scope.join(" "),
			$challenge: params.codeChallenge,
			$method: params.codeChallengeMethod,
			$grantId: randomBytes(16).toString("hex"),
			$expiresAt: expiresAt,
			$now: nowIso(),
		},
	);
	return { code, expiresAt };
}

/** Marks a code consumed, atomically. The single conditional UPDATE is what
 * makes replay detection sound: two concurrent redemptions of the same code
 * cannot both see it as unconsumed. */
export function consumeAuthCode(
	db: Db,
	code: string,
): { row: OauthAuthCodeRow; replayed: boolean } | null {
	const row = db.get<OauthAuthCodeRow>(
		"SELECT * FROM oauth_auth_codes WHERE code_hash = $hash",
		{ $hash: hashToken(code) },
	);
	if (!row) return null;
	const claimed = db.get<{ id: number }>(
		`UPDATE oauth_auth_codes SET consumed_at = $now
       WHERE id = $id AND consumed_at IS NULL
       RETURNING id`,
		{ $now: nowIso(), $id: row.id },
	);
	return { row, replayed: !claimed };
}

/** Revokes every live token minted from one grant. Used both when the user
 * withdraws consent and when a consumed code or rotated refresh token is
 * replayed -- the safe reading of a replay is that the token leaked. */
export function revokeGrant(db: Db, grantId: string): void {
	db.run(
		"UPDATE oauth_tokens SET revoked_at = $now WHERE grant_id = $grantId AND revoked_at IS NULL",
		{ $now: nowIso(), $grantId: grantId },
	);
}

export interface IssuedTokens {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	refresh_token: string;
	scope: string;
}

/** Issues an access/refresh pair for a grant. Both are stored hashed -- a
 * database read must not yield usable credentials. */
export function issueTokens(
	db: Db,
	params: {
		clientId: string;
		userId: number;
		scope: string[];
		grantId: string;
	},
): IssuedTokens {
	const access = ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
	const refresh = REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
	const now = Date.now();
	const scope = params.scope.join(" ");
	const insert = (
		token: string,
		kind: "access" | "refresh",
		ttlMs: number,
	): void => {
		db.run(
			`INSERT INTO oauth_tokens (
         token_hash, kind, client_id, user_id, scope, grant_id, expires_at, created_at
       ) VALUES ($hash, $kind, $clientId, $userId, $scope, $grantId, $expiresAt, $now)`,
			{
				$hash: hashToken(token),
				$kind: kind,
				$clientId: params.clientId,
				$userId: params.userId,
				$scope: scope,
				$grantId: params.grantId,
				$expiresAt: new Date(now + ttlMs).toISOString(),
				$now: nowIso(),
			},
		);
	};
	db.transaction(() => {
		insert(access, "access", ACCESS_TOKEN_TTL_MS);
		insert(refresh, "refresh", REFRESH_TOKEN_TTL_MS);
	});
	return {
		access_token: access,
		token_type: "Bearer",
		expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
		refresh_token: refresh,
		scope,
	};
}

/** Looks up a live token of the given kind. Expiry is a lexicographic string
 * comparison, which is only sound because nowIso() is fixed-width UTC. */
export function findLiveToken(
	db: Db,
	plain: string,
	kind: "access" | "refresh",
): OauthTokenRow | undefined {
	return db.get<OauthTokenRow>(
		`SELECT * FROM oauth_tokens
       WHERE token_hash = $hash AND kind = $kind
         AND revoked_at IS NULL AND expires_at > $now`,
		{ $hash: hashToken(plain), $kind: kind, $now: nowIso() },
	);
}

/** Rotates a refresh token: the presented one is revoked and a fresh pair is
 * issued under the same grant. A *reused* refresh token (already revoked but
 * still on record) kills the whole grant. */
export function rotateRefreshToken(
	db: Db,
	presented: string,
	clientId: string,
): { row: OauthTokenRow; tokens: IssuedTokens } {
	const hash = hashToken(presented);
	const row = db.get<OauthTokenRow>(
		"SELECT * FROM oauth_tokens WHERE token_hash = $hash AND kind = 'refresh'",
		{ $hash: hash },
	);
	if (!row || row.client_id !== clientId) {
		throw new OauthError("invalid_grant", "unknown refresh token");
	}
	if (row.revoked_at) {
		revokeGrant(db, row.grant_id);
		throw new OauthError("invalid_grant", "refresh token already used");
	}
	if (row.expires_at <= nowIso()) {
		throw new OauthError("invalid_grant", "refresh token expired");
	}
	// Revoke the presented token *and* the access token it accompanies, so a
	// rotation can't leave two live access tokens on one grant.
	db.run(
		"UPDATE oauth_tokens SET revoked_at = $now WHERE grant_id = $grantId AND revoked_at IS NULL",
		{ $now: nowIso(), $grantId: row.grant_id },
	);
	const tokens = issueTokens(db, {
		clientId: row.client_id,
		userId: row.user_id,
		scope: parseScope(row.scope),
		grantId: row.grant_id,
	});
	return { row, tokens };
}

/** Throttled last_used_at write, matching the sessions table's approach: an
 * actively polling client shouldn't cause a write per request. */
const LAST_USED_THROTTLE_MS = 60_000;

export function touchToken(db: Db, row: OauthTokenRow): void {
	const now = Date.now();
	if (
		row.last_used_at &&
		now - Date.parse(row.last_used_at) < LAST_USED_THROTTLE_MS
	) {
		return;
	}
	const iso = nowIso();
	db.run("UPDATE oauth_tokens SET last_used_at = $now WHERE id = $id", {
		$now: iso,
		$id: row.id,
	});
	row.last_used_at = iso;
}

/** Deletes expired codes and expired tokens. Only rows past `expires_at` go --
 * never a still-unexpired *revoked* row, because that row is the reuse-detection
 * record: dropping it early would downgrade a replayed refresh token from
 * "revoke the whole grant" to a bare unknown-token error. Once expired, the
 * token is refused on expiry anyway, so removing it changes nothing. */
export function pruneOauth(db: Db): void {
	const now = nowIso();
	db.run("DELETE FROM oauth_auth_codes WHERE expires_at <= $now", {
		$now: now,
	});
	db.run("DELETE FROM oauth_tokens WHERE expires_at <= $now", { $now: now });
}
