import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppState } from "../src/appState.ts";
import { getMasterKey, type Settings } from "../src/config.ts";
import { decryptStream } from "../src/crypto/aead.ts";
import { openBox, seal } from "../src/crypto/secretbox.ts";
import type { DirectoryRow, FileRow, UserRow } from "../src/db/rows.ts";
import { createSqliteDb } from "../src/db/sqlite.ts";
import type { Db } from "../src/db/types.ts";
import {
	blobsEqual,
	canAccessTree,
	cascadeEncryptDirectory,
	descendantIds,
	getDirectory,
	isEncLocked,
} from "../src/routes/directories.ts";
import { attachBlob, hashFile } from "../src/storage/blobs.ts";
import { newInternalRelPath, safeJoin, storageRoot } from "../src/storage/paths.ts";

function fakeSettings(): Settings {
	return {
		appEnv: "dev",
		databaseUrl: "sqlite:///:memory:",
		secretKey: "test-secret",
		masterKeyB64: Buffer.from(randomBytes(32)).toString("base64"),
		configPath: "",
		trustProxy: false,
		trustProxyMode: "off",
		allowedHosts: "",
		clusterToken: "",
		nodeId: "test-node",
		nodeName: "test-node",
		nodeRole: "master",
		nodeUrl: "",
		masterUrl: "",
		masterToken: "",
		archiveEnabled: false,
		replicationMode: "full",
		cacheMaxBytes: 0,
		qbittorrentUrl: "",
		qbittorrentUsername: "",
		qbittorrentPassword: "",
		qbittorrentSavePath: "",
		torrentContentPath: "",
		realDebridApiKey: "",
		realDebridEnabled: false,
	};
}

function setup() {
	const db = createSqliteDb(":memory:");
	const state = createAppState(fakeSettings(), db);
	db.run(
		"INSERT INTO users (username, password_hash, role, created_at) VALUES ('alice', 'x', 'user', '2024-01-01T00:00:00Z')",
	);
	db.run(
		"INSERT INTO users (username, password_hash, role, created_at) VALUES ('bob', 'x', 'user', '2024-01-01T00:00:00Z')",
	);
	const alice = db.get<UserRow>("SELECT * FROM users WHERE username = 'alice'")!;
	const bob = db.get<UserRow>("SELECT * FROM users WHERE username = 'bob'")!;
	return { db, state, alice, bob };
}

let dirCounter = 0;
function makeDir(
	db: Db,
	overrides: Partial<
		Pick<
			DirectoryRow,
			| "owner_id"
			| "title"
			| "parent_directory_id"
			| "encryption_mode"
			| "enc_key_blob"
			| "enc_access_blob"
			| "key_check_blob"
		>
	> & { ownerId: number },
): DirectoryRow {
	dirCounter += 1;
	db.run(
		`INSERT INTO directories (
       owner_id, slug, title, parent_directory_id, encryption_mode,
       enc_key_blob, enc_access_blob, key_check_blob, created_at
     ) VALUES ($owner, $slug, $title, $parent, $enc, $encKey, $encAccess, $keyCheck, '2024-01-01T00:00:00Z')`,
		{
			$owner: overrides.ownerId,
			$slug: `dir-${dirCounter}`,
			$title: overrides.title ?? "Folder",
			$parent: overrides.parent_directory_id ?? null,
			$enc: overrides.encryption_mode ?? "none",
			$encKey: overrides.enc_key_blob ? Buffer.from(overrides.enc_key_blob) : null,
			$encAccess: overrides.enc_access_blob
				? Buffer.from(overrides.enc_access_blob)
				: null,
			$keyCheck: overrides.key_check_blob ?? null,
		},
	);
	return db.get<DirectoryRow>(
		"SELECT * FROM directories WHERE id = last_insert_rowid()",
	)!;
}

describe("descendantIds", () => {
	test("collects the whole subtree, not siblings or the root itself", () => {
		const { db, alice } = setup();
		const root = makeDir(db, { ownerId: alice.id, title: "root" });
		const child = makeDir(db, {
			ownerId: alice.id,
			title: "child",
			parent_directory_id: root.id,
		});
		const grandchild = makeDir(db, {
			ownerId: alice.id,
			title: "grandchild",
			parent_directory_id: child.id,
		});
		const sibling = makeDir(db, { ownerId: alice.id, title: "sibling" });

		const ids = descendantIds(db, root.id);
		expect(ids.sort()).toEqual([child.id, grandchild.id].sort());
		expect(ids).not.toContain(root.id);
		expect(ids).not.toContain(sibling.id);
	});

	test("is what the move cycle-guard relies on: a folder can't be moved into its own descendant", () => {
		const { db, alice } = setup();
		const root = makeDir(db, { ownerId: alice.id, title: "root" });
		const child = makeDir(db, {
			ownerId: alice.id,
			title: "child",
			parent_directory_id: root.id,
		});
		// "move root under child" -- the route rejects this iff child is a
		// descendant of root, i.e. descendantIds(root).includes(child.id).
		expect(descendantIds(db, root.id).includes(child.id)).toBe(true);
		// the reverse (move child under root, its actual parent) is fine.
		expect(descendantIds(db, child.id).includes(root.id)).toBe(false);
	});
});

describe("canAccessTree", () => {
	test("owner always has access", () => {
		const { db, alice } = setup();
		const root = makeDir(db, { ownerId: alice.id });
		expect(canAccessTree(db, root, alice)).toBe(true);
	});

	test("editor access inherits down from an ancestor collaboration", () => {
		const { db, alice, bob } = setup();
		const root = makeDir(db, { ownerId: alice.id, title: "root" });
		const child = makeDir(db, {
			ownerId: alice.id,
			title: "child",
			parent_directory_id: root.id,
		});
		expect(canAccessTree(db, child, bob)).toBe(false);

		db.run(
			`INSERT INTO directory_collaborators (directory_id, user_id, role, created_at)
       VALUES ($dir, $user, 'editor', '2024-01-01T00:00:00Z')`,
			{ $dir: root.id, $user: bob.id },
		);
		// bob was only added on the root, but should reach the child too.
		expect(canAccessTree(db, child, bob)).toBe(true);
	});

	test("an unrelated user has no access at any depth", () => {
		const { db, alice, bob } = setup();
		const root = makeDir(db, { ownerId: alice.id });
		const child = makeDir(db, {
			ownerId: alice.id,
			parent_directory_id: root.id,
		});
		expect(canAccessTree(db, root, bob)).toBe(false);
		expect(canAccessTree(db, child, bob)).toBe(false);
	});
});

describe("isEncLocked", () => {
	const keyA = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaa");
	const keyB = Buffer.from("bbbbbbbbbbbbbbbbbbbbbbbb");

	test("an unencrypted child is never locked", () => {
		expect(
			isEncLocked(
				{ encryption_mode: "none", enc_access_blob: null, key_check_blob: null },
				{ encryption_mode: "server", enc_access_blob: keyA, key_check_blob: null },
			),
		).toBe(false);
	});

	test("encrypted child under an unencrypted (or absent) parent is locked", () => {
		const child = {
			encryption_mode: "server" as const,
			enc_access_blob: keyA,
			key_check_blob: null,
		};
		expect(
			isEncLocked(child, {
				encryption_mode: "none",
				enc_access_blob: null,
				key_check_blob: null,
			}),
		).toBe(true);
		expect(isEncLocked(child, null)).toBe(true);
	});

	test("server mode: same access-key bytes as the parent -> not locked", () => {
		const parent = {
			encryption_mode: "server" as const,
			enc_access_blob: keyA,
			key_check_blob: null,
		};
		const sameKeyChild = { ...parent };
		expect(isEncLocked(sameKeyChild, parent)).toBe(false);
	});

	test("server mode: different access-key bytes than the parent -> locked (nested encryption)", () => {
		const parent = {
			encryption_mode: "server" as const,
			enc_access_blob: keyA,
			key_check_blob: null,
		};
		const differentKeyChild = {
			encryption_mode: "server" as const,
			enc_access_blob: keyB,
			key_check_blob: null,
		};
		expect(isEncLocked(differentKeyChild, parent)).toBe(true);
	});

	test("client mode compares key_check_blob the same way", () => {
		const parent = {
			encryption_mode: "client" as const,
			enc_access_blob: null,
			key_check_blob: "check-a",
		};
		expect(isEncLocked({ ...parent }, parent)).toBe(false);
		expect(
			isEncLocked(
				{ encryption_mode: "client", enc_access_blob: null, key_check_blob: "check-b" },
				parent,
			),
		).toBe(true);
	});
});

describe("cascadeEncryptDirectory", () => {
	let tmpRoot: string;
	let prevStorage: string | undefined;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "fu-cascade-test-"));
		prevStorage = process.env.FILEUPLOAD_STORAGE;
		process.env.FILEUPLOAD_STORAGE = tmpRoot;
	});

	afterEach(() => {
		if (prevStorage === undefined) delete process.env.FILEUPLOAD_STORAGE;
		else process.env.FILEUPLOAD_STORAGE = prevStorage;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	test("encrypts plaintext descendants in place and skips ones with their own key (nested encryption)", async () => {
		const { db, state, alice } = setup();
		const masterKey = getMasterKey(state.settings);

		const root = makeDir(db, { ownerId: alice.id, title: "root" });
		const plainChild = makeDir(db, {
			ownerId: alice.id,
			title: "plain-child",
			parent_directory_id: root.id,
		});

		// A subfolder that was already independently encrypted with its own key
		// *before* the cascade runs on its parent -- this is what should end up
		// "nested": still visible, still its own key, untouched by the cascade.
		const ownKey = randomBytes(32);
		const ownAccessKey = "own-access-key";
		const nested = makeDir(db, {
			ownerId: alice.id,
			title: "already-encrypted",
			parent_directory_id: root.id,
			encryption_mode: "server",
			enc_key_blob: seal(masterKey, ownKey),
			enc_access_blob: seal(masterKey, Buffer.from(ownAccessKey)),
		});
		// A file inside the nested subfolder, using its own key too -- should
		// also be left completely alone (cascade never even visits it, since it
		// only recurses into still-plaintext subfolders).
		const nestedFileRelPath = newInternalRelPath();
		const nestedFileFull = safeJoin(storageRoot(), nestedFileRelPath);
		mkdirSync(join(nestedFileFull, ".."), { recursive: true });
		writeFileSync(nestedFileFull, "nested plaintext, not touched");
		db.run(
			`INSERT INTO files (owner_id, directory_id, storage_path, original_filename, size_bytes,
         stored_size_bytes, content_type, encryption_mode, created_at)
       VALUES ($owner, $dir, $path, 'nested.txt', 0, 0, 'text/plain', 'none', '2024-01-01T00:00:00Z')`,
			{ $owner: alice.id, $dir: nested.id, $path: nestedFileRelPath },
		);

		// A plaintext file directly in the root folder -- this one SHOULD get
		// swept up by the cascade.
		const relPath = newInternalRelPath();
		const fullPath = safeJoin(storageRoot(), relPath);
		mkdirSync(join(fullPath, ".."), { recursive: true });
		const content = "hello world, this is plaintext";
		writeFileSync(fullPath, content);
		const hashes = await hashFile(fullPath);
		const blob = attachBlob(db, {
			finalPath: fullPath,
			relPath,
			logicalSize: content.length,
			contentType: "text/plain",
			hashes,
			transformKey: "none:compressed=0",
		});
		db.run(
			`INSERT INTO files (owner_id, directory_id, blob_id, storage_path, original_filename, size_bytes,
         stored_size_bytes, content_type, encryption_mode, created_at)
       VALUES ($owner, $dir, $blob, $path, 'hello.txt', $size, $size, 'text/plain', 'none', '2024-01-01T00:00:00Z')`,
			{
				$owner: alice.id,
				$dir: root.id,
				$blob: blob.id,
				$path: blob.storage_path,
				$size: content.length,
			},
		);

		await cascadeEncryptDirectory(state, root);

		const updatedRoot = getDirectory(db, root.id)!;
		expect(updatedRoot.encryption_mode).toBe("server");
		expect(updatedRoot.enc_key_blob).not.toBeNull();

		// The plaintext subfolder inherited the root's exact key...
		const updatedPlainChild = getDirectory(db, plainChild.id)!;
		expect(updatedPlainChild.encryption_mode).toBe("server");
		expect(
			blobsEqual(updatedPlainChild.enc_access_blob, updatedRoot.enc_access_blob),
		).toBe(true);
		expect(isEncLocked(updatedPlainChild, updatedRoot)).toBe(false);

		// ...but the already-encrypted subfolder kept its own, untouched.
		const updatedNested = getDirectory(db, nested.id)!;
		expect(updatedNested.encryption_mode).toBe("server");
		expect(
			blobsEqual(updatedNested.enc_access_blob, updatedRoot.enc_access_blob),
		).toBe(false);
		expect(isEncLocked(updatedNested, updatedRoot)).toBe(true);

		// The nested file was never visited -- still plaintext on disk, byte for byte.
		const nestedFileRow = db.get<FileRow>(
			"SELECT * FROM files WHERE directory_id = $id",
			{ $id: nested.id },
		)!;
		expect(nestedFileRow.encryption_mode).toBe("none");
		expect(nestedFileRow.storage_path).toBe(nestedFileRelPath);

		// The root-level file was re-encrypted with the root's new key, and
		// decrypts back to the exact original bytes.
		const updatedFile = db.get<FileRow>(
			"SELECT * FROM files WHERE directory_id = $id",
			{ $id: root.id },
		)!;
		expect(updatedFile.encryption_mode).toBe("server");
		expect(updatedFile.storage_path).not.toBe(relPath);
		const fileKey = openBox(masterKey, Buffer.from(updatedFile.enc_key_blob!));
		const decryptedPath = safeJoin(storageRoot(), updatedFile.storage_path);
		let decrypted = Buffer.alloc(0);
		for await (const chunk of decryptStream(fileKey, decryptedPath)) {
			decrypted = Buffer.concat([decrypted, chunk]);
		}
		expect(decrypted.toString("utf-8")).toBe(content);
	});
});
