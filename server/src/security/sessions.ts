import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/types.ts";

export const COOKIE_NAME = "fu_session";
export const CSRF_HEADER = "x-csrf-token";
const SESSION_TTL_SECONDS = 86400; // 24 hours

export interface SessionRow {
	id: string;
	user_id: number;
	csrf_token: string;
	created_at: string;
	last_seen_at: string;
	expires_at: string;
	ip_address: string | null;
	user_agent: string | null;
	/** Cloudflare CF-IPCountry at login: ISO 3166-1 alpha-2, or Cloudflare's
	 * `XX` (no data) / `T1` (Tor). NULL when not behind Cloudflare. */
	country_code: string | null;
}

function tokenUrlsafe(bytes: number): string {
	return randomBytes(bytes).toString("base64url");
}

function nowIso(): string {
	return new Date().toISOString();
}

/** HMAC-SHA256 signed cookie: "<sid>.<sig>". Not itsdangerous-compatible
 * (fresh cutover, no need to read old Python-issued cookies) but the same
 * shape: cookie only carries an opaque signed id, the session row (incl.
 * csrf_token) lives server-side. */
function sign(secretKey: string, sid: string): string {
	const sig = createHmac("sha256", secretKey).update(sid).digest("base64url");
	return `${sid}.${sig}`;
}

function unsign(secretKey: string, cookieValue: string): string | null {
	const dot = cookieValue.lastIndexOf(".");
	if (dot === -1) return null;
	const sid = cookieValue.slice(0, dot);
	const sig = cookieValue.slice(dot + 1);
	const expected = createHmac("sha256", secretKey)
		.update(sid)
		.digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return sid;
}

export class SessionManager {
	constructor(
		private readonly secretKey: string,
		private readonly secure: boolean,
	) {}

	create(
		db: Db,
		userId: number,
		opts: {
			ip?: string | null;
			userAgent?: string | null;
			countryCode?: string | null;
		} = {},
	): { cookieValue: string; csrfToken: string } {
		const sid = tokenUrlsafe(32);
		const csrfToken = tokenUrlsafe(32);
		const now = nowIso();
		const expiresAt = new Date(
			Date.now() + SESSION_TTL_SECONDS * 1000,
		).toISOString();
		db.run(
			`INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip_address, user_agent, country_code)
       VALUES ($id, $userId, $csrfToken, $createdAt, $lastSeenAt, $expiresAt, $ip, $ua, $country)`,
			{
				$id: sid,
				$userId: userId,
				$csrfToken: csrfToken,
				$createdAt: now,
				$lastSeenAt: now,
				$expiresAt: expiresAt,
				$ip: opts.ip ?? null,
				$ua: opts.userAgent ?? null,
				$country: opts.countryCode ?? null,
			},
		);
		return { cookieValue: sign(this.secretKey, sid), csrfToken };
	}

	resolve(db: Db, cookieValue: string | undefined): SessionRow | null {
		if (!cookieValue) return null;
		const sid = unsign(this.secretKey, cookieValue);
		if (!sid) return null;
		const row = db.get<SessionRow>("SELECT * FROM sessions WHERE id = $id", {
			$id: sid,
		});
		if (!row) return null;
		if (new Date(row.expires_at).getTime() < Date.now()) return null;

		// Throttled so an active session doesn't issue a write per request.
		const lastSeenMs = new Date(row.last_seen_at).getTime();
		if (Date.now() - lastSeenMs > 60_000) {
			const now = nowIso();
			db.run("UPDATE sessions SET last_seen_at = $now WHERE id = $id", {
				$now: now,
				$id: sid,
			});
			row.last_seen_at = now;
		}
		return row;
	}

	/** Drops rows past `expires_at`. `resolve` already refuses them, so this
	 * changes nothing a client can see -- it just stops the table growing by
	 * one row per login forever. Returns the number removed. */
	pruneExpired(db: Db): number {
		const now = nowIso();
		const before = db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM sessions WHERE expires_at < $now",
			{ $now: now },
		)?.n;
		db.run("DELETE FROM sessions WHERE expires_at < $now", { $now: now });
		return before ?? 0;
	}

	destroy(db: Db, cookieValue: string | undefined): void {
		if (!cookieValue) return;
		const sid = unsign(this.secretKey, cookieValue);
		if (!sid) return;
		db.run("DELETE FROM sessions WHERE id = $id", { $id: sid });
	}

	cookieParams(): {
		httpOnly: true;
		sameSite: "strict";
		secure: boolean;
		maxAge: number;
		path: string;
	} {
		return {
			httpOnly: true,
			sameSite: "strict",
			secure: this.secure,
			maxAge: SESSION_TTL_SECONDS * 1000,
			path: "/",
		};
	}
}
