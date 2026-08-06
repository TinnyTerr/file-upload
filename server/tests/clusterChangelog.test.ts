/**
 * The replication change log (redesign Phase 3, §5.7 — B4, B5, D4, S1).
 *
 * The defect being closed is that replication was something route handlers had
 * to remember to do, and two of roughly forty did. So the tests that matter
 * are the ones asserting that an *ordinary* write — one nobody told about
 * replication — is logged anyway, and that the things the old push could not
 * express at all (deletes, renames, moves, permission edits) now are.
 */

import { describe, expect, test } from "bun:test";
import {
	applyChanges,
	BLOB_COLUMNS,
	CHANGELOG_TABLES,
	type ChangeEntry,
	getCursor,
	logHead,
	readChanges,
	seedChangeLog,
	setCursor,
	setNodeIdentity,
	TABLE_COLUMNS,
} from "../src/cluster/changelog.ts";
import { nowIso } from "../src/db/rows.ts";
import { createSqliteDb } from "../src/db/sqlite.ts";
import type { Db } from "../src/db/types.ts";
import { makeDirectory, makeFile, makeHarness, makeUser } from "./harness.ts";

function entriesFor(db: Db, table: string): ChangeEntry[] {
	return readChanges(db, { limit: 1000 }).filter((e) => e.table_name === table);
}

describe("triggers", () => {
	test("an ordinary insert is logged without anyone asking", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const entries = entriesFor(h.db, "users");
			expect(entries).toHaveLength(1);
			expect(entries[0]!.op).toBe("upsert");
			expect(entries[0]!.origin_node).toBe("test-node");
			expect(entries[0]!.payload?.username).toBe("owner");
			// The uid the trigger minted is the row's, not a fresh one.
			const uid = h.db.get<{ uid: string }>(
				"SELECT uid FROM users WHERE id = $id",
				{ $id: owner.id },
			)!.uid;
			expect(entries[0]!.row_uid).toBe(uid);
			expect(uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		} finally {
			h.close();
		}
	});

	test("mints exactly one uid, and does not log the mint as a second change", async () => {
		const h = await makeHarness();
		try {
			await makeUser(h.db, "owner");
			// A spurious update entry here would mean the mint's own UPDATE fired
			// the update trigger -- SQLite's recursive_triggers pragma does not
			// prevent that, the suppression flag does.
			expect(entriesFor(h.db, "users")).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test("logs the mutations the old push could not express at all", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const a = makeDirectory(h.db, { ownerId: owner.id, title: "a" });
			const b = makeDirectory(h.db, { ownerId: owner.id, title: "b" });
			const file = makeFile(h.db, {
				ownerId: owner.id,
				name: "x.txt",
				directoryId: a,
			});

			h.db.run("UPDATE files SET original_filename = 'y.txt' WHERE id = $id", {
				$id: file,
			});
			h.db.run("UPDATE files SET directory_id = $b WHERE id = $id", {
				$b: b,
				$id: file,
			});
			h.db.run("UPDATE permissions SET can_upload = 0 WHERE user_id = $u", {
				$u: owner.id,
			});
			h.db.run("DELETE FROM files WHERE id = $id", { $id: file });

			const files = entriesFor(h.db, "files");
			expect(files.map((e) => e.op)).toEqual([
				"upsert", // create
				"upsert", // rename
				"upsert", // move
				"delete",
			]);
			expect(files[1]!.payload?.original_filename).toBe("y.txt");
			expect(entriesFor(h.db, "permissions")).toHaveLength(2);
			// A delete carries identity and nothing else -- there is no row left.
			expect(files[3]!.payload).toBeNull();
		} finally {
			h.close();
		}
	});

	test("never puts a local id on the wire", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const dir = makeDirectory(h.db, { ownerId: owner.id, title: "docs" });
			makeFile(h.db, { ownerId: owner.id, name: "x.txt", directoryId: dir });

			const dirUid = h.db.get<{ uid: string }>(
				"SELECT uid FROM directories WHERE id = $id",
				{ $id: dir },
			)!.uid;
			const fileEntry = entriesFor(h.db, "files")[0]!;
			expect(fileEntry.payload).not.toHaveProperty("id");
			// Foreign keys travel as the parent's uid (D1: `id` means nothing on
			// another node).
			expect(fileEntry.payload?.directory_id).toBe(dirUid);
			expect(typeof fileEntry.payload?.owner_id).toBe("string");
		} finally {
			h.close();
		}
	});

	test("tracks base_master_seq per row, and assigns master_seq on the master", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			const dir = makeDirectory(h.db, { ownerId: owner.id, title: "a" });
			h.db.run("UPDATE directories SET title = 'b' WHERE id = $id", {
				$id: dir,
			});
			const entries = entriesFor(h.db, "directories");
			// This harness node boots NODE_ROLE=master, where the local log order
			// is the canonical order, so the two sequences coincide.
			expect(entries[0]!.master_seq).toBe(entries[0]!.seq);
			expect(entries[0]!.base_master_seq).toBeNull();
			expect(entries[1]!.base_master_seq).toBe(entries[0]!.master_seq);
		} finally {
			h.close();
		}
	});

	test("a follower leaves master_seq unassigned -- its writes are provisional", async () => {
		const h = await makeHarness({ nodeRole: "follower", nodeId: "node-b" });
		try {
			await makeUser(h.db, "owner");
			const entry = entriesFor(h.db, "users")[0]!;
			expect(entry.master_seq).toBeNull();
			expect(entry.origin_node).toBe("node-b");
			expect(entry.origin_seq).toBe(entry.seq);
		} finally {
			h.close();
		}
	});

	test("stays quiet until the node has an identity, so the uid backfill is not logged", () => {
		// createSqliteDb runs the backfill and installs the triggers but names
		// nobody; createAppState is what arms them.
		const db = createSqliteDb(":memory:");
		try {
			db.run(
				`INSERT INTO users (username, password_hash, role, must_change_credentials, created_at)
         VALUES ('pre-existing', 'x', 'user', 0, $now)`,
				{ $now: nowIso() },
			);
			expect(readChanges(db)).toHaveLength(0);

			setNodeIdentity(db, "node-a");
			db.run(
				"UPDATE users SET role = 'master' WHERE username = 'pre-existing'",
			);
			expect(readChanges(db)).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});

describe("column maps", () => {
	test("BLOB_COLUMNS matches what the schema actually declares", async () => {
		const h = await makeHarness();
		try {
			for (const table of CHANGELOG_TABLES) {
				const declared = new Set(
					h.db
						.all<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
						.filter(
							(c) =>
								c.type.toUpperCase() === "BLOB" &&
								TABLE_COLUMNS[table].includes(c.name),
						)
						.map((c) => c.name),
				);
				// A blob column missing from the map would be handed to
				// json_object(), which refuses to hold one.
				expect([...(BLOB_COLUMNS[table] ?? [])].sort()).toEqual(
					[...declared].sort(),
				);
			}
		} finally {
			h.close();
		}
	});

	test("no replicated column list ships the local id", () => {
		for (const table of CHANGELOG_TABLES) {
			expect(TABLE_COLUMNS[table]).not.toContain("id");
			expect(TABLE_COLUMNS[table]).toContain("uid");
		}
	});
});

describe("apply", () => {
	/** Two independent nodes, no HTTP -- just the log in and the log out. */
	async function twoNodes() {
		const a = await makeHarness({ nodeId: "node-a", nodeRole: "master" });
		const b = await makeHarness({ nodeId: "node-b", nodeRole: "follower" });
		return { a, b, close: () => (a.close(), b.close()) };
	}

	test("replays a whole subtree onto a peer that has none of it", async () => {
		const { a, b, close } = await twoNodes();
		try {
			const owner = await makeUser(a.db, "owner");
			const parent = makeDirectory(a.db, { ownerId: owner.id, title: "top" });
			const child = makeDirectory(a.db, {
				ownerId: owner.id,
				title: "nested",
				parentId: parent,
			});
			makeFile(a.db, { ownerId: owner.id, name: "x.txt", directoryId: child });

			const result = applyChanges(b.db, readChanges(a.db, { limit: 500 }), 0);
			expect(result.halted).toBeUndefined();
			expect(result.cursor).toBe(logHead(a.db));

			// The folder chain landed, with its shape intact but its own local ids.
			const rows = b.db.all<{ title: string; parent_directory_id: number }>(
				"SELECT title, parent_directory_id FROM directories ORDER BY id",
			);
			expect(rows.map((r) => r.title)).toEqual(["top", "nested"]);
			const parentIdOnB = b.db.get<{ id: number }>(
				"SELECT id FROM directories WHERE title = 'top'",
			)!.id;
			expect(rows[1]!.parent_directory_id).toBe(parentIdOnB);
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(1);
		} finally {
			close();
		}
	});

	test("round-trips blob columns through hex", async () => {
		const { a, b, close } = await twoNodes();
		try {
			const owner = await makeUser(a.db, "owner");
			const secret = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80]);
			a.db.run("UPDATE users SET avatar_data = $blob WHERE id = $id", {
				$blob: secret,
				$id: owner.id,
			});
			applyChanges(b.db, readChanges(a.db), 0);
			const landed = b.db.get<{ avatar_data: Uint8Array }>(
				"SELECT avatar_data FROM users WHERE username = 'owner'",
			)!;
			expect(Buffer.from(landed.avatar_data).equals(secret)).toBe(true);
		} finally {
			close();
		}
	});

	test("an applied change is not re-logged as this node's own", async () => {
		const { a, b, close } = await twoNodes();
		try {
			await makeUser(a.db, "owner");
			applyChanges(b.db, readChanges(a.db), 0);
			// Every entry b now holds still names a as its origin. Without the
			// suppression flag, applying would look like a local write and the two
			// nodes would push the same row at each other forever.
			expect(readChanges(b.db).every((e) => e.origin_node === "node-a")).toBe(
				true,
			);
		} finally {
			close();
		}
	});

	test("a delete propagates", async () => {
		const { a, b, close } = await twoNodes();
		try {
			const owner = await makeUser(a.db, "owner");
			const dir = makeDirectory(a.db, { ownerId: owner.id, title: "docs" });
			const file = makeFile(a.db, {
				ownerId: owner.id,
				name: "x.txt",
				directoryId: dir,
			});
			applyChanges(b.db, readChanges(a.db), 0);
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(1);

			a.db.run("DELETE FROM files WHERE id = $id", { $id: file });
			const cursor = applyChanges(
				b.db,
				readChanges(a.db, { after: 4 }),
				4,
			).cursor;
			expect(cursor).toBe(logHead(a.db));
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(0);
		} finally {
			close();
		}
	});

	test("re-delivering entries is harmless", async () => {
		const { a, b, close } = await twoNodes();
		try {
			await makeUser(a.db, "owner");
			const entries = readChanges(a.db);
			applyChanges(b.db, entries, 0);
			const after = readChanges(b.db).length;
			// A peer whose cursor slipped backwards must not double-apply or throw.
			expect(() => applyChanges(b.db, entries, 0)).not.toThrow();
			expect(readChanges(b.db)).toHaveLength(after);
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n,
			).toBe(1);
		} finally {
			close();
		}
	});

	test("halts on an unresolvable parent instead of skipping past it", async () => {
		const { a, b, close } = await twoNodes();
		try {
			const owner = await makeUser(a.db, "owner");
			const dir = makeDirectory(a.db, { ownerId: owner.id, title: "docs" });
			makeFile(a.db, { ownerId: owner.id, name: "x.txt", directoryId: dir });

			// Deliver the file's entry without the folder's -- the shape a lost or
			// reordered batch would have.
			const all = readChanges(a.db);
			const withoutFolder = all.filter((e) => e.table_name !== "directories");
			const result = applyChanges(b.db, withoutFolder, 0);
			expect(result.halted).toBeDefined();
			expect(result.halted!.reason).toMatch(/directory_id/);
			// Cursor stopped before the bad entry: it is retried, never dropped.
			expect(result.cursor).toBeLessThan(result.halted!.seq);
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(0);

			// Once the missing parent arrives, the same entry applies.
			expect(applyChanges(b.db, all, 0).halted).toBeUndefined();
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(1);
		} finally {
			close();
		}
	});

	test("keeps a row whose soft provenance pointer cannot be resolved", async () => {
		const { a, b, close } = await twoNodes();
		try {
			const owner = await makeUser(a.db, "owner");
			const dir = makeDirectory(a.db, { ownerId: owner.id, title: "docs" });
			makeFile(a.db, {
				ownerId: owner.id,
				name: "x.txt",
				directoryId: dir,
			});
			// saved_from_file_id naming a file this peer will never see: it is
			// provenance, not structure, so losing the pointer beats losing the row.
			const entries = readChanges(a.db).map((e) =>
				e.table_name === "files"
					? {
							...e,
							payload: {
								...e.payload,
								saved_from_file_id: "0000000000ZZZZZZZZZZZZZZZZ",
							},
						}
					: e,
			);
			expect(applyChanges(b.db, entries, 0).halted).toBeUndefined();
			expect(
				b.db.get<{ saved_from_file_id: number | null }>(
					"SELECT saved_from_file_id FROM files",
				)!.saved_from_file_id,
			).toBeNull();
		} finally {
			close();
		}
	});
});

describe("cursors", () => {
	test("default to zero and round-trip per peer and direction", async () => {
		const h = await makeHarness();
		try {
			expect(getCursor(h.db, "node-b", "up")).toBe(0);
			setCursor(h.db, "node-b", "up", 42);
			setCursor(h.db, "node-b", "down", 7);
			expect(getCursor(h.db, "node-b", "up")).toBe(42);
			expect(getCursor(h.db, "node-b", "down")).toBe(7);
			setCursor(h.db, "node-b", "up", 99);
			expect(getCursor(h.db, "node-b", "up")).toBe(99);
		} finally {
			h.close();
		}
	});
});

describe("readChanges", () => {
	test("is ascending and front-truncated, so paging loses nothing", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			for (let i = 0; i < 25; i++) {
				makeDirectory(h.db, { ownerId: owner.id, title: `d${i}` });
			}
			const seen: number[] = [];
			let cursor = 0;
			for (;;) {
				const page = readChanges(h.db, { after: cursor, limit: 10 });
				if (page.length === 0) break;
				for (const e of page) seen.push(e.seq);
				cursor = page[page.length - 1]!.seq;
			}
			expect(seen).toEqual([...seen].sort((x, y) => x - y));
			expect(seen).toHaveLength(logHead(h.db));
		} finally {
			h.close();
		}
	});
});

describe("seeding", () => {
	test("describes a database that predates the log, once", async () => {
		const h = await makeHarness();
		try {
			const owner = await makeUser(h.db, "owner");
			makeDirectory(h.db, { ownerId: owner.id, title: "docs" });
			// The shape of an upgraded deployment: rows exist, no log does.
			h.db.run("DELETE FROM replication_log");

			expect(seedChangeLog(h.db)).toBe(3); // user, permissions, directory
			const tables = readChanges(h.db).map((e) => e.table_name);
			// Parents first, so a peer applying from cursor 0 never meets a child
			// before its parent.
			expect(tables.indexOf("users")).toBeLessThan(
				tables.indexOf("directories"),
			);
			// A second call finds a non-empty log and does nothing.
			expect(seedChangeLog(h.db)).toBe(0);
			expect(readChanges(h.db)).toHaveLength(3);
		} finally {
			h.close();
		}
	});

	test("a seeded log carries a joining node the whole existing corpus", async () => {
		const a = await makeHarness({ nodeId: "node-a", nodeRole: "master" });
		const b = await makeHarness({ nodeId: "node-b", nodeRole: "follower" });
		try {
			const owner = await makeUser(a.db, "owner");
			const dir = makeDirectory(a.db, { ownerId: owner.id, title: "docs" });
			makeFile(a.db, { ownerId: owner.id, name: "x.txt", directoryId: dir });
			a.db.run("DELETE FROM replication_log");
			seedChangeLog(a.db);

			// No snapshot endpoint involved: catching up from nothing and keeping
			// up from now on are the same code path.
			expect(applyChanges(b.db, readChanges(a.db), 0).halted).toBeUndefined();
			expect(
				b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(1);
			expect(
				b.db.get<{ title: string }>("SELECT title FROM directories")!.title,
			).toBe("docs");
		} finally {
			a.close();
			b.close();
		}
	});
});
