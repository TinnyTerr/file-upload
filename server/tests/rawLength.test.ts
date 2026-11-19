/**
 * `GET /api/file/:slug/raw` for a file stored transformed (server-encrypted)
 * must still declare the plaintext `Content-Length`, or a browser navigating to
 * it has no total to show for the download.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMasterKey } from "../src/config.ts";
import { encryptFile } from "../src/crypto/aead.ts";
import { seal } from "../src/crypto/secretbox.ts";
import { nowIso } from "../src/db/rows.ts";
import { present } from "../src/present.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

const storageDir = mkdtempSync(join(tmpdir(), "fu-rawlen-"));
let h: Harness;

beforeAll(async () => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
	h = await makeHarness();
});

afterAll(() => {
	delete process.env.FILEUPLOAD_STORAGE;
	rmSync(storageDir, { recursive: true, force: true });
});

describe("raw download length", () => {
	test("server-encrypted file declares its plaintext Content-Length", async () => {
		const owner = await makeUser(h.db, "lenowner");
		const body = randomBytes(300_000);
		const plainPath = join(storageDir, "plain.tmp");
		writeFileSync(plainPath, body);
		const rel = `ef/01/${randomBytes(8).toString("hex")}`;
		const full = join(storageDir, rel);
		mkdirSync(dirname(full), { recursive: true });
		const key = randomBytes(32);
		await encryptFile(key, plainPath, full);
		const keyBlob = seal(getMasterKey(h.state.settings), key);

		h.db.run(
			`INSERT INTO files (owner_id, storage_path, original_filename, source_type,
         size_bytes, stored_size_bytes, content_type, encryption_mode,
         encryption_overridden, enc_key_blob, created_at)
       VALUES ($owner, $path, 'enc.bin', 'upload', $size, $size,
         'application/octet-stream', 'server', 1, $key, $now)`,
			{
				$owner: owner.id,
				$path: rel,
				$size: body.length,
				$key: keyBlob,
				$now: nowIso(),
			},
		);
		const fileId = present(
			h.db.get<{ id: number }>("SELECT last_insert_rowid() AS id"),
		).id;
		const slug = randomBytes(8).toString("base64url");
		h.db.run(
			`INSERT INTO links (file_id, slug, max_uses, use_count, active, created_at)
       VALUES ($file, $slug, NULL, 0, 1, $now)`,
			{ $file: fileId, $slug: slug, $now: nowIso() },
		);

		const res = await h.request(`/api/file/${slug}/raw`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-length")).toBe(String(body.length));
		expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
	});
});
