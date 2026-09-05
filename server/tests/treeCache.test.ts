/**
 * The per-request resolver must give exactly the answers the per-row
 * functions give -- it exists to stop re-walking the tree per row, not to
 * change what the walk finds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	createEncryptionResolver,
	resolveDirectoryEncryption,
	resolveFileEncryption,
} from "../src/crypto/effectiveEncryption.ts";
import { type DirectoryRow, type FileRow, nowIso } from "../src/db/rows.ts";
import { createTreeCache, directoryRole } from "../src/directoryTree.ts";
import {
	type Harness,
	makeDirectory,
	makeFile,
	makeHarness,
	makeUser,
} from "./harness.ts";

let h: Harness;

beforeAll(async () => {
	h = await makeHarness();
});
afterAll(() => h.close());

function dir(id: number): DirectoryRow {
	return h.db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", {
		$id: id,
	})!;
}

describe("tree cache and encryption resolver", () => {
	test("match the per-row walkers on a tree with a mid-level break point", async () => {
		const owner = await makeUser(h.db, "tree-owner");
		const editor = await makeUser(h.db, "tree-editor");
		const root = makeDirectory(h.db, { ownerId: owner.id, title: "root" });
		const mid = makeDirectory(h.db, {
			ownerId: owner.id,
			title: "mid",
			parentId: root,
		});
		const leaf = makeDirectory(h.db, {
			ownerId: owner.id,
			title: "leaf",
			parentId: mid,
		});
		// `mid` becomes its own break point with a server key.
		h.db.run(
			`UPDATE directories SET encryption_mode = 'server', encryption_overridden = 1,
       enc_key_blob = $k WHERE id = $id`,
			{ $k: randomBytes(16), $id: mid },
		);
		h.db.run(
			`INSERT INTO directory_collaborators (directory_id, user_id, role, invited_by_id, created_at)
       VALUES ($dir, $user, 'editor', $by, $now)`,
			{ $dir: mid, $user: editor.id, $by: owner.id, $now: nowIso() },
		);
		const fileId = makeFile(h.db, {
			ownerId: owner.id,
			name: "in-leaf.txt",
			directoryId: leaf,
		});
		const file = h.db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
			$id: fileId,
		})!;

		const enc = createEncryptionResolver(h.db);
		for (const id of [root, mid, leaf]) {
			expect(enc.directory(dir(id))).toEqual(
				resolveDirectoryEncryption(h.db, dir(id)),
			);
		}
		expect(enc.file(file)).toEqual(resolveFileEncryption(h.db, file));
		expect(enc.file(file).ownerDirectoryId).toBe(mid);
		expect(enc.directory(dir(leaf)).sourceDirectoryId).toBe(mid);

		for (const u of [owner, editor]) {
			for (const id of [root, mid, leaf]) {
				expect(enc.tree.role(dir(id), u)).toBe(directoryRole(h.db, dir(id), u));
			}
		}
		expect(enc.tree.role(dir(leaf), editor)).toBe("editor");
		expect(enc.tree.role(dir(root), editor)).toBeNull();
	});

	test("a preloaded cache answers misses as absences without querying", () => {
		const tree = createTreeCache(h.db);
		tree.preloadAll();
		expect(tree.row(999999)).toBeNull();
	});
});
