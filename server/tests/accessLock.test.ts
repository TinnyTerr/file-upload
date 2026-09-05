/**
 * The password-guess counter for a locked share must be keyed on the secret
 * being guessed (the key scope), never on the link slug presenting it. A
 * folder's `/d/:slug/info` publishes every member file's slug, so a per-slug
 * counter would hand out one fresh guess budget per member against the same
 * password.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { getMasterKey } from "../src/config.ts";
import { seal } from "../src/crypto/secretbox.ts";
import { nowIso, type UserRow } from "../src/db/rows.ts";
import type { Db } from "../src/db/types.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

/** A server-encrypted, password-locked root folder. */
function makeLockedFolder(
	h: Harness,
	owner: UserRow,
	password: string,
): number {
	const masterKey = getMasterKey(h.state.settings);
	const keyBlob = seal(masterKey, randomBytes(32));
	const accessBlob = seal(masterKey, Buffer.from(password, "utf-8"));
	h.db.run(
		`INSERT INTO directories (owner_id, title, slug, parent_directory_id, encryption_mode,
       encryption_overridden, enc_key_blob, enc_access_blob, access_is_password, created_at)
     VALUES ($owner, 'locked', $slug, NULL, 'server', 1, $key, $access, 1, $now)`,
		{
			$owner: owner.id,
			$slug: randomBytes(4).toString("hex"),
			$key: keyBlob,
			$access: accessBlob,
			$now: nowIso(),
		},
	);
	return h.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}

/** A previewable member file inheriting the folder's key, plus its own link. */
function makeMember(db: Db, owner: UserRow, directoryId: number): string {
	db.run(
		`INSERT INTO files (owner_id, directory_id, storage_path, original_filename,
       source_type, size_bytes, stored_size_bytes, content_type, encryption_mode,
       encryption_overridden, created_at)
     VALUES ($owner, $dir, $path, 'note.txt', 'upload', 4, 4, 'text/plain', 'server', 0, $now)`,
		{
			$owner: owner.id,
			$dir: directoryId,
			$path: `ab/cd/${randomBytes(8).toString("hex")}`,
			$now: nowIso(),
		},
	);
	const fileId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
	const slug = randomBytes(8).toString("base64url");
	db.run(
		`INSERT INTO links (file_id, slug, max_uses, use_count, active, created_at)
     VALUES ($file, $slug, NULL, 0, 1, $now)`,
		{ $file: fileId, $slug: slug, $now: nowIso() },
	);
	return slug;
}

describe("password-locked link throttle", () => {
	let h: Harness;
	let owner: UserRow;

	beforeAll(async () => {
		h = await makeHarness();
		owner = await makeUser(h.db, "locker");
	});

	afterAll(() => h.close());

	test("guesses against one member's /preview lock every member of the folder", async () => {
		const dir = makeLockedFolder(h, owner, "hunter2hunter2");
		const a = makeMember(h.db, owner, dir);
		const b = makeMember(h.db, owner, dir);

		for (let i = 0; i < 4; i++) {
			const res = await h.request(`/api/file/${a}/preview?ek=wrong${i}`);
			expect(res.status).toBe(401);
		}
		// Fifth failure trips the lock on the *folder's* scope ...
		expect((await h.request(`/api/file/${a}/preview?ek=wrong4`)).status).toBe(
			429,
		);
		// ... so a sibling's slug does not start a fresh budget.
		expect((await h.request(`/api/file/${b}/preview?ek=another`)).status).toBe(
			429,
		);
		// And the right password is refused too while locked, which is the
		// behaviour a lockout is supposed to have.
		expect(
			(await h.request(`/api/file/${b}/preview?ek=hunter2hunter2`)).status,
		).toBe(429);
	});

	test("/raw shares the same counter", async () => {
		const dir = makeLockedFolder(h, owner, "hunter2hunter2");
		const a = makeMember(h.db, owner, dir);
		const b = makeMember(h.db, owner, dir);
		for (let i = 0; i < 5; i++) {
			await h.request(`/api/file/${a}/preview?ek=wrong${i}`);
		}
		expect((await h.request(`/api/file/${b}/raw?ek=another`)).status).toBe(429);
	});
});
