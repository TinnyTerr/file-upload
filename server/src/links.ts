import { randomBytes } from "node:crypto";
import type { LinkRow } from "./db/rows.ts";
import type { Db } from "./db/types.ts";

/** Mirrors app/links/slugs.py + app/links/consume.py. */

export function newSlug(): string {
	return randomBytes(16).toString("base64url");
}

export function resolveActiveLink(db: Db, slug: string): LinkRow | null {
	const link = db.get<LinkRow>("SELECT * FROM links WHERE slug = $slug", {
		$slug: slug,
	});
	if (!link?.active) return null;
	const now = new Date().toISOString();
	if (link.expires_at !== null && link.expires_at <= now) return null;
	if (link.max_uses !== null && link.use_count >= link.max_uses) return null;
	return link;
}

/** Atomically claims one use via a single UPDATE with the active/expiry/max_uses
 * gate in the WHERE clause, avoiding a read-modify-write race. */
export function consumeUse(db: Db, slug: string): boolean {
	const now = new Date().toISOString();
	const claimed = db.get<{ id: number }>(
		`UPDATE links SET use_count = use_count + 1
     WHERE slug = $slug AND active = 1
       AND (expires_at IS NULL OR expires_at > $now)
       AND (max_uses IS NULL OR use_count < max_uses)
     RETURNING id`,
		{ $slug: slug, $now: now },
	);
	return !!claimed;
}
