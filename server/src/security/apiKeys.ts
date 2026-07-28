import { createHash, randomBytes } from "node:crypto";
import { type ApiKeyRow, nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";

/** Mirrors app/security/api_keys.py. */

/** A fresh API key, shown to the user exactly once. */
export function generateKey(): string {
	return randomBytes(32).toString("base64url");
}

export function hashKey(plain: string): string {
	return createHash("sha256").update(plain, "utf-8").digest("hex");
}

/** Bind the key to its first IP, allow the bound IP, reject others.
 * Persists the binding / last_used_at immediately (no ORM flush step). */
export function bindOrReject(db: Db, apiKey: ApiKeyRow, ip: string): boolean {
	const now = nowIso();
	if (apiKey.bound_ip === null) {
		db.run(
			"UPDATE api_keys SET bound_ip = $ip, last_used_at = $now WHERE id = $id",
			{
				$ip: ip,
				$now: now,
				$id: apiKey.id,
			},
		);
		apiKey.bound_ip = ip;
		apiKey.last_used_at = now;
		return true;
	}
	if (apiKey.bound_ip === ip) {
		db.run("UPDATE api_keys SET last_used_at = $now WHERE id = $id", {
			$now: now,
			$id: apiKey.id,
		});
		apiKey.last_used_at = now;
		return true;
	}
	return false;
}
