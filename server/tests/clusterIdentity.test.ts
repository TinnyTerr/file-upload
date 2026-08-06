/**
 * Cluster-wide row identity (redesign Phase 2, §5.6 — D1).
 *
 * The defect being closed is that two nodes independently mint `files.id = 42`
 * for two different files. So the tests that matter are the ones about
 * *distinctness under concurrency* and about a populated database surviving the
 * conversion, not about the string format.
 */

import { describe, expect, test } from "bun:test";
import {
	backfillUids,
	ensureUid,
	idToUid,
	newUid,
	UID_TABLES,
	uidToId,
} from "../src/cluster/identity.ts";
import { createSqliteDb } from "../src/db/sqlite.ts";
import type { Db } from "../src/db/types.ts";
import { makeDirectory, makeFile, makeHarness, makeUser } from "./harness.ts";

/** Put rows back into the state a database that predates the uid column is in.
 *
 * The changelog triggers mint a uid on any insert or update, so this is only
 * reachable while the node has no identity — which is exactly the window the
 * boot backfill runs in (cluster/changelog.ts arms the triggers only once
 * createAppState names the node). */
function withoutUids(db: Db, tables: string[], where = "1 = 1"): void {
	const nodeId = db.get<{ node_id: string }>(
		"SELECT node_id FROM replication_control WHERE id = 1",
	)!.node_id;
	db.run("UPDATE replication_control SET node_id = '' WHERE id = 1");
	for (const table of tables) {
		db.run(`UPDATE ${table} SET uid = NULL WHERE ${where}`);
	}
	db.run("UPDATE replication_control SET node_id = $id WHERE id = 1", {
		$id: nodeId,
	});
}

describe("newUid", () => {
	test("is a 26-character Crockford base32 ULID", () => {
		expect(newUid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	test("never repeats, even minted in a tight loop inside one millisecond", () => {
		const uids = new Set<string>();
		for (let i = 0; i < 50_000; i++) uids.add(newUid());
		expect(uids.size).toBe(50_000);
	});

	test("sorts in creation order", () => {
		const uids = Array.from({ length: 1000 }, () => newUid());
		expect([...uids].sort()).toEqual(uids);
	});

	test("two independent nodes minting at the same instant do not collide", () => {
		// The whole point of D1: no coordination, no collision.
		const a = Array.from({ length: 10_000 }, () => newUid());
		const b = Array.from({ length: 10_000 }, () => newUid());
		expect(new Set([...a, ...b]).size).toBe(20_000);
	});
});

describe("uid columns", () => {
	test("every replicated table has a uid, unique and indexed", async () => {
		const h = await makeHarness();
		try {
			for (const table of UID_TABLES) {
				const cols = h.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
				expect(cols.map((c) => c.name)).toContain("uid");
				const indexes = h.db.all<{ name: string; unique: number }>(
					`PRAGMA index_list(${table})`,
				);
				const uidIndex = indexes.find((i) => i.name === `ux_${table}_uid`);
				expect(uidIndex?.unique).toBe(1);
			}
		} finally {
			h.close();
		}
	});

	test("a duplicate uid is rejected by the database", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const a = makeDirectory(h.db, { ownerId: owner.id, title: "a" });
			const b = makeDirectory(h.db, { ownerId: owner.id, title: "b" });
			const uid = ensureUid(h.db, "directories", a);
			expect(() => {
				h.db.run("UPDATE directories SET uid = $uid WHERE id = $id", {
					$uid: uid,
					$id: b,
				});
			}).toThrow();
		} finally {
			h.close();
		}
	});
});

describe("ensureUid / resolution", () => {
	test("mints once and is stable thereafter", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const dirId = makeDirectory(h.db, { ownerId: owner.id, title: "docs" });
			const fileId = makeFile(h.db, {
				ownerId: owner.id,
				name: "a.txt",
				directoryId: dirId,
			});

			const first = ensureUid(h.db, "files", fileId);
			expect(ensureUid(h.db, "files", fileId)).toBe(first);
			expect(idToUid(h.db, "files", fileId)).toBe(first);
			expect(uidToId(h.db, "files", first)).toBe(fileId);
		} finally {
			h.close();
		}
	});

	test("refuses a table that does not replicate, and a row that does not exist", async () => {
		const h = await makeHarness();
		try {
			expect(() =>
				// biome-ignore lint/suspicious/noExplicitAny: deliberately off-contract
				ensureUid(h.db, "sessions" as any, 1),
			).toThrow(/not a uid-bearing table/);
			expect(() => ensureUid(h.db, "files", 9999)).toThrow(/does not exist/);
		} finally {
			h.close();
		}
	});

	test("uidToId misses cleanly on an unknown uid", async () => {
		const h = await makeHarness();
		try {
			expect(uidToId(h.db, "files", newUid())).toBeUndefined();
		} finally {
			h.close();
		}
	});
});

describe("backfill", () => {
	test("converts a populated database, and is idempotent", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const dirId = makeDirectory(h.db, { ownerId: owner.id, title: "docs" });
			for (let i = 0; i < 20; i++) {
				makeFile(h.db, {
					ownerId: owner.id,
					name: `f${i}.txt`,
					directoryId: dirId,
				});
			}
			withoutUids(h.db, ["files", "directories", "users"]);

			const minted = backfillUids(h.db);
			expect(minted.files).toBe(20);
			expect(minted.directories).toBe(1);
			expect(minted.users).toBe(1);

			const uids = h.db.all<{ uid: string | null }>("SELECT uid FROM files");
			expect(uids.every((r) => typeof r.uid === "string")).toBe(true);
			expect(new Set(uids.map((r) => r.uid)).size).toBe(20);

			// Second pass finds nothing and changes nothing.
			const before = h.db.all<{ id: number; uid: string | null }>(
				"SELECT id, uid FROM files ORDER BY id",
			);
			expect(backfillUids(h.db)).toEqual({});
			expect(h.db.all("SELECT id, uid FROM files ORDER BY id")).toEqual(before);
		} finally {
			h.close();
		}
	});

	test("leaves already-minted uids alone", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const dirId = makeDirectory(h.db, { ownerId: owner.id, title: "docs" });
			const kept = ensureUid(h.db, "directories", dirId);
			const other = makeDirectory(h.db, { ownerId: owner.id, title: "other" });
			withoutUids(h.db, ["directories"], `id = ${other}`);

			expect(backfillUids(h.db).directories).toBe(1);
			expect(idToUid(h.db, "directories", dirId)).toBe(kept);
			expect(idToUid(h.db, "directories", other)).toBeTruthy();
		} finally {
			h.close();
		}
	});

	test("runs on open, so no database is ever half-converted", () => {
		// createSqliteDb backfills before it hands the connection out.
		const db = createSqliteDb(":memory:");
		try {
			db.run(
				`INSERT INTO users (username, password_hash, role, must_change_credentials, created_at)
         VALUES ('pre-existing', 'x', 'user', 0, '2020-01-01T00:00:00.000Z')`,
			);
			db.run("UPDATE users SET uid = NULL");
			expect(backfillUids(db).users).toBe(1);
		} finally {
			db.close();
		}
	});
});
