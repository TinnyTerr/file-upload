/** Share-link analytics: hits are recorded where a link is used, the stats
 * endpoint is owner-scoped, and the window is zero-filled. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nowIso, type UserRow } from "../src/db/rows.ts";
import { pruneLinkHits } from "../src/linkStats.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

const storageDir = mkdtempSync(join(tmpdir(), "fu-linkstats-"));
beforeAll(() => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
});
afterAll(() => {
	delete process.env.FILEUPLOAD_STORAGE;
	rmSync(storageDir, { recursive: true, force: true });
});

describe("link stats", () => {
	let h: Harness;
	let owner: UserRow;
	let other: UserRow;
	let linkId: number;
	let slug: string;

	beforeAll(async () => {
		h = await makeHarness();
		owner = await makeUser(h.db, "statowner");
		other = await makeUser(h.db, "statother");
		const rel = `ab/cd/${randomBytes(8).toString("hex")}`;
		mkdirSync(dirname(join(storageDir, rel)), { recursive: true });
		writeFileSync(join(storageDir, rel), "hello");
		h.db.run(
			`INSERT INTO files (owner_id, storage_path, original_filename, source_type,
         size_bytes, stored_size_bytes, content_type, encryption_mode,
         encryption_overridden, created_at)
       VALUES ($o, $p, 'a.txt', 'upload', 5, 5, 'application/octet-stream', 'none', 1, $now)`,
			{ $o: owner.id, $p: rel, $now: nowIso() },
		);
		const fileId = h.db.get<{ id: number }>(
			"SELECT last_insert_rowid() AS id",
		)!.id;
		slug = randomBytes(8).toString("base64url");
		h.db.run(
			`INSERT INTO links (file_id, slug, use_count, active, created_at)
       VALUES ($f, $s, 0, 1, $now)`,
			{ $f: fileId, $s: slug, $now: nowIso() },
		);
		linkId = h.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
	});
	afterAll(() => h.close());

	test("a view and a download are counted, zero-filled over the window", async () => {
		await h.request(`/api/file/${slug}/info`);
		await h.request(`/api/file/${slug}/raw`);
		const { cookie } = h.signIn(owner);
		const res = await h.request(`/api/link-stats/file/${linkId}?days=7`, {
			cookie,
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totals).toEqual({ view: 1, download: 1, save: 0 });
		expect(body.series).toHaveLength(7);
		expect(body.series.at(-1).download).toBe(1);
		expect(body.last_event_at).not.toBeNull();
	});

	test("only the owner (or a master) may read them", async () => {
		const { cookie } = h.signIn(other);
		const res = await h.request(`/api/link-stats/file/${linkId}`, { cookie });
		expect(res.status).toBe(403);
		const anon = await h.request(`/api/link-stats/file/${linkId}`);
		expect(anon.status).toBeGreaterThanOrEqual(401);
	});

	test("prune drops rows past retention and keeps recent ones", () => {
		h.db.run(
			`INSERT INTO link_hits (link_kind, link_id, event, created_at)
       VALUES ('file', $id, 'view', '2000-01-01T00:00:00.000Z')`,
			{ $id: linkId },
		);
		expect(pruneLinkHits(h.db)).toBe(1);
		expect(
			h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM link_hits")!.n,
		).toBe(2);
	});
});
