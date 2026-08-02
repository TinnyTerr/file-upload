/**
 * OAuth 2.0 authorization server (security/oauth.ts + routes/oauth.ts).
 *
 * The properties worth pinning down are the ones that stop a leaked credential
 * from being useful: codes are single-use, a replay kills the grant, refresh
 * tokens rotate, a reused refresh token kills the grant, and redirect URIs are
 * matched exactly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { nowIso, type OauthClientRow } from "../src/db/rows.ts";
import {
	consumeAuthCode,
	findLiveToken,
	hashToken,
	issueAuthCode,
	issueTokens,
	OauthError,
	parseScope,
	pruneOauth,
	redirectUriAllowed,
	resolveRequestedScopes,
	revokeGrant,
	rotateRefreshToken,
	validateRedirectUri,
	verifyPkce,
} from "../src/security/oauth.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

let h: Harness;
let userId: number;
let client: OauthClientRow;

const REDIRECT = "https://app.example.com/cb";

function registerClient(
	opts: { scopes?: string; redirectUris?: string; secret?: string | null } = {},
): OauthClientRow {
	const clientId = `fuc_${randomBytes(8).toString("hex")}`;
	h.db.run(
		`INSERT INTO oauth_clients (client_id, client_secret_hash, name, owner_id,
       redirect_uris, scopes, active, created_at)
     VALUES ($id, $secret, 'Test App', $owner, $uris, $scopes, 1, $now)`,
		{
			$id: clientId,
			$secret: opts.secret === null ? null : hashToken(opts.secret ?? "s3cret"),
			$owner: userId,
			$uris: opts.redirectUris ?? REDIRECT,
			$scopes: opts.scopes ?? "profile files:read files:write",
			$now: nowIso(),
		},
	);
	return h.db.get<OauthClientRow>(
		"SELECT * FROM oauth_clients WHERE client_id = $id",
		{ $id: clientId },
	)!;
}

beforeEach(async () => {
	h = await makeHarness();
	const user = await makeUser(h.db, "alice");
	userId = user.id;
	client = registerClient();
});

afterEach(() => h.close());

describe("redirect_uri handling", () => {
	test("matches exactly — never by prefix", () => {
		expect(redirectUriAllowed(client, REDIRECT)).toBe(true);
		// The classic open-redirect shape: same origin, attacker-chosen path.
		expect(redirectUriAllowed(client, `${REDIRECT}/../evil`)).toBe(false);
		expect(redirectUriAllowed(client, `${REDIRECT}?x=1`)).toBe(false);
		expect(redirectUriAllowed(client, "https://app.example.com")).toBe(false);
		expect(redirectUriAllowed(client, "https://evil.example.com/cb")).toBe(
			false,
		);
	});

	test("accepts https, loopback http and private-use schemes", () => {
		expect(() =>
			validateRedirectUri("https://app.example.com/cb"),
		).not.toThrow();
		expect(() => validateRedirectUri("http://localhost:3000/cb")).not.toThrow();
		expect(() => validateRedirectUri("http://127.0.0.1:3000/cb")).not.toThrow();
		expect(() => validateRedirectUri("com.example.app:/cb")).not.toThrow();
	});

	test("rejects plain http to a remote host, and any fragment", () => {
		// The code would travel over the wire in the clear.
		expect(() => validateRedirectUri("http://app.example.com/cb")).toThrow(
			OauthError,
		);
		expect(() =>
			validateRedirectUri("https://app.example.com/cb#frag"),
		).toThrow(OauthError);
		expect(() => validateRedirectUri("not a url")).toThrow(OauthError);
	});
});

describe("scopes", () => {
	test("an unregistered scope is refused, not silently dropped", () => {
		expect(() => resolveRequestedScopes(client, ["media:read"])).toThrow(
			OauthError,
		);
	});

	test("an unknown scope is refused", () => {
		expect(() => resolveRequestedScopes(client, ["files:destroy"])).toThrow(
			OauthError,
		);
	});

	test("requesting none falls back to the client's full registration", () => {
		expect(resolveRequestedScopes(client, [])).toEqual([
			"profile",
			"files:read",
			"files:write",
		]);
	});

	test("parseScope drops duplicates and empties", () => {
		expect(parseScope("  profile   files:read profile ")).toEqual([
			"profile",
			"files:read",
		]);
		expect(parseScope(null)).toEqual([]);
	});
});

describe("PKCE", () => {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256")
		.update(verifier, "ascii")
		.digest("base64url");

	function codeRow() {
		const { code } = issueAuthCode(h.db, {
			client,
			userId,
			redirectUri: REDIRECT,
			scope: ["profile"],
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
		});
		return consumeAuthCode(h.db, code)!.row;
	}

	test("accepts the matching verifier", () => {
		expect(() => verifyPkce(codeRow(), verifier)).not.toThrow();
	});

	test("rejects a wrong verifier", () => {
		expect(() =>
			verifyPkce(codeRow(), randomBytes(32).toString("base64url")),
		).toThrow(OauthError);
	});

	test("rejects a missing verifier when a challenge was recorded", () => {
		expect(() => verifyPkce(codeRow(), undefined)).toThrow(OauthError);
	});

	test("rejects a verifier outside the RFC 7636 length bounds", () => {
		expect(() => verifyPkce(codeRow(), "tooshort")).toThrow(OauthError);
	});
});

describe("authorization codes", () => {
	function mint() {
		return issueAuthCode(h.db, {
			client,
			userId,
			redirectUri: REDIRECT,
			scope: ["profile"],
			codeChallenge: null,
			codeChallengeMethod: null,
		});
	}

	test("the code is not stored in the clear", () => {
		const { code } = mint();
		const stored = h.db.get<{ code_hash: string }>(
			"SELECT code_hash FROM oauth_auth_codes",
		);
		expect(stored?.code_hash).not.toBe(code);
		expect(stored?.code_hash).toBe(hashToken(code));
	});

	test("redeeming twice reports the second as a replay", () => {
		const { code } = mint();
		expect(consumeAuthCode(h.db, code)?.replayed).toBe(false);
		expect(consumeAuthCode(h.db, code)?.replayed).toBe(true);
	});

	test("an unknown code resolves to nothing", () => {
		expect(consumeAuthCode(h.db, "nope")).toBeNull();
	});

	test("a replay revokes every token already minted from the grant", () => {
		const { code } = mint();
		const { row } = consumeAuthCode(h.db, code)!;
		const tokens = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile"],
			grantId: row.grant_id,
		});
		expect(findLiveToken(h.db, tokens.access_token, "access")).toBeDefined();

		// This is what routes/oauth.ts does on seeing replayed === true.
		revokeGrant(h.db, row.grant_id);

		expect(findLiveToken(h.db, tokens.access_token, "access")).toBeUndefined();
		expect(
			findLiveToken(h.db, tokens.refresh_token, "refresh"),
		).toBeUndefined();
	});
});

describe("tokens", () => {
	function grant() {
		return issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile", "files:read"],
			grantId: randomBytes(8).toString("hex"),
		});
	}

	test("neither token is stored in the clear", () => {
		const t = grant();
		const rows = h.db.all<{ token_hash: string }>(
			"SELECT token_hash FROM oauth_tokens",
		);
		const hashes = rows.map((r) => r.token_hash);
		expect(hashes).not.toContain(t.access_token);
		expect(hashes).toContain(hashToken(t.access_token));
	});

	test("access tokens carry the prefix the middleware routes on", () => {
		expect(grant().access_token.startsWith("fuo_")).toBe(true);
	});

	test("a refresh token is not usable as an access token", () => {
		const t = grant();
		expect(findLiveToken(h.db, t.refresh_token, "access")).toBeUndefined();
		expect(findLiveToken(h.db, t.access_token, "refresh")).toBeUndefined();
	});

	test("rotation issues a new pair and retires the old one", () => {
		const first = grant();
		const { tokens: second } = rotateRefreshToken(
			h.db,
			first.refresh_token,
			client.client_id,
		);
		expect(second.refresh_token).not.toBe(first.refresh_token);
		expect(findLiveToken(h.db, second.access_token, "access")).toBeDefined();
		// The rotation must not leave two live access tokens on one grant.
		expect(findLiveToken(h.db, first.access_token, "access")).toBeUndefined();
		expect(findLiveToken(h.db, first.refresh_token, "refresh")).toBeUndefined();
	});

	test("reusing a rotated refresh token kills the whole grant", () => {
		const first = grant();
		const { tokens: second } = rotateRefreshToken(
			h.db,
			first.refresh_token,
			client.client_id,
		);
		// Replaying the retired token is the signal that it leaked.
		expect(() =>
			rotateRefreshToken(h.db, first.refresh_token, client.client_id),
		).toThrow(OauthError);
		expect(findLiveToken(h.db, second.access_token, "access")).toBeUndefined();
		expect(
			findLiveToken(h.db, second.refresh_token, "refresh"),
		).toBeUndefined();
	});

	test("another client cannot rotate this client's refresh token", () => {
		const other = registerClient();
		const t = grant();
		expect(() =>
			rotateRefreshToken(h.db, t.refresh_token, other.client_id),
		).toThrow(OauthError);
	});
});

describe("pruning", () => {
	test("keeps a revoked-but-unexpired row as the reuse-detection record", () => {
		const grantId = randomBytes(8).toString("hex");
		const t = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile"],
			grantId,
		});
		revokeGrant(h.db, grantId);
		pruneOauth(h.db);

		// Still on record: dropping it early would downgrade a replayed refresh
		// token from "revoke the grant" to a bare unknown-token error.
		const row = h.db.get(
			"SELECT id FROM oauth_tokens WHERE token_hash = $hash",
			{ $hash: hashToken(t.refresh_token) },
		);
		expect(row).toBeDefined();
	});

	test("deletes rows that are already past expiry", () => {
		const grantId = randomBytes(8).toString("hex");
		issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile"],
			grantId,
		});
		h.db.run("UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z'");
		pruneOauth(h.db);
		expect(
			h.db.all("SELECT id FROM oauth_tokens WHERE grant_id = $g", {
				$g: grantId,
			}),
		).toHaveLength(0);
	});
});

describe("the machine surface", () => {
	test("metadata advertises S256 and the two supported grant types", async () => {
		const res = await h.request("/api/oauth/metadata");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			code_challenge_methods_supported: string[];
			grant_types_supported: string[];
			response_types_supported: string[];
		};
		expect(body.code_challenge_methods_supported).toEqual(["S256"]);
		expect(body.grant_types_supported).toEqual([
			"authorization_code",
			"refresh_token",
		]);
		expect(body.response_types_supported).toEqual(["code"]);
	});

	test("the token endpoint rejects an unknown client with 401", async () => {
		const res = await h.request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "grant_type=authorization_code&client_id=fuc_nope&code=x",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		// RFC 6749 error shape, not the app-wide {detail}.
		expect(body.error).toBe("invalid_client");
	});

	test("the token endpoint rejects a bad client secret", async () => {
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: client.client_id,
			client_secret: "wrong",
			code: "x",
		});
		const res = await h.request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});
		expect(res.status).toBe(401);
	});

	test("an unsupported grant type is named as such", async () => {
		const params = new URLSearchParams({
			grant_type: "password",
			client_id: client.client_id,
			client_secret: "s3cret",
		});
		const res = await h.request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("unsupported_grant_type");
	});

	test("token responses are marked no-store", async () => {
		const res = await h.request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "grant_type=password",
		});
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	test("userinfo refuses a session cookie — it is bearer-only", async () => {
		const user = h.db.get<{ id: number }>(
			"SELECT id FROM users WHERE username = 'alice'",
		)!;
		const { cookie } = h.signIn(user as never);
		const res = await h.request("/api/oauth/userinfo", { cookie });
		expect(res.status).toBe(401);
	});

	test("userinfo accepts an access token carrying profile", async () => {
		const t = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile"],
			grantId: randomBytes(8).toString("hex"),
		});
		const res = await h.request("/api/oauth/userinfo", {
			headers: { authorization: `Bearer ${t.access_token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sub: string; username: string };
		expect(body.username).toBe("alice");
		expect(body.sub).toBe(String(userId));
	});

	test("a token without the scope an endpoint needs is refused", async () => {
		const t = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["files:read"],
			grantId: randomBytes(8).toString("hex"),
		});
		const res = await h.request("/api/oauth/userinfo", {
			headers: { authorization: `Bearer ${t.access_token}` },
		});
		expect(res.status).toBe(403);
	});

	test("a revoked token stops working immediately", async () => {
		const grantId = randomBytes(8).toString("hex");
		const t = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile"],
			grantId,
		});
		revokeGrant(h.db, grantId);
		const res = await h.request("/api/oauth/userinfo", {
			headers: { authorization: `Bearer ${t.access_token}` },
		});
		expect(res.status).toBe(401);
	});
});

describe("scope-gated access to the real API", () => {
	test("directories:read lets a token browse the tree", async () => {
		const t = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["directories:read"],
			grantId: randomBytes(8).toString("hex"),
		});
		const res = await h.request("/api/directories", {
			headers: { authorization: `Bearer ${t.access_token}` },
		});
		expect(res.status).toBe(200);
	});

	test("a token without directories:read cannot", async () => {
		const t = issueTokens(h.db, {
			clientId: client.client_id,
			userId,
			scope: ["profile"],
			grantId: randomBytes(8).toString("hex"),
		});
		const res = await h.request("/api/directories", {
			headers: { authorization: `Bearer ${t.access_token}` },
		});
		expect(res.status).toBe(403);
	});
});
