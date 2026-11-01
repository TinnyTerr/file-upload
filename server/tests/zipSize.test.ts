import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipArchive } from "archiver";
import { storedZipSize } from "../src/storage/zip.ts";

async function realSize(entries: { name: string; size: number }[]) {
	const dir = mkdtempSync(join(tmpdir(), "zipsize-"));
	const a = new ZipArchive({ store: true });
	let n = 0;
	a.on("data", (b: Buffer) => {
		n += b.length;
	});
	const ended = new Promise((r) => a.on("end", r));
	entries.forEach((e, i) => {
		const p = join(dir, String(i));
		writeFileSync(p, Buffer.alloc(e.size, 1));
		a.file(p, { name: e.name });
	});
	await a.finalize();
	await ended;
	return n;
}

test("storedZipSize matches archiver's real output", async () => {
	const cases = [
		[],
		[{ name: "a.txt", size: 0 }],
		[
			{ name: "d/é日本.bin", size: 1000 },
			{ name: "x", size: 5 },
		],
		[
			{ name: "a", size: 0 },
			{ name: "b", size: 300000 },
		],
	];
	for (const c of cases) expect(storedZipSize(c)).toBe(await realSize(c));
});

test("storedZipSize declines where zip64 would appear", () => {
	expect(storedZipSize([{ name: "big", size: 0xffffffff }])).toBeNull();
	expect(
		storedZipSize(
			Array.from({ length: 0xffff }, () => ({ name: "a", size: 0 })),
		),
	).toBeNull();
});

import { afterAll, beforeAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "../src/db/rows.ts";
import { present } from "../src/present.ts";
import { makeHarness, makeUser } from "./harness.ts";

const storageDir = mkdtempSync(join(tmpdir(), "fu-zipsize-"));
beforeAll(() => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
});
afterAll(() => {
	delete process.env.FILEUPLOAD_STORAGE;
	rmSync(storageDir, { recursive: true, force: true });
});

test("batch-zip declares a Content-Length equal to the body it sends", async () => {
	const h = await makeHarness();
	try {
		const user = await makeUser(h.db, "zipper");
		const ids: number[] = [];
		for (const [name, size] of [
			["same.txt", 123],
			["same.txt", 70000],
			["ünï.bin", 0],
		] as const) {
			const rel = `ab/cd/${randomBytes(8).toString("hex")}`;
			const full = join(storageDir, rel);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, Buffer.alloc(size, 7));
			h.db.run(
				`INSERT INTO files (owner_id, storage_path, original_filename, source_type,
           size_bytes, stored_size_bytes, content_type, encryption_mode,
           encryption_overridden, created_at)
         VALUES ($o, $p, $n, 'upload', $s, $s, 'application/octet-stream', 'none', 1, $now)`,
				{ $o: user.id, $p: rel, $n: name, $s: size, $now: nowIso() },
			);
			ids.push(
				present(h.db.get<{ id: number }>("SELECT last_insert_rowid() AS id"))
					.id,
			);
		}
		const { cookie } = h.signIn(user);
		const res = await h.request(`/api/files/batch-zip?ids=${ids.join(",")}`, {
			cookie,
		});
		expect(res.status).toBe(200);
		const declared = Number(res.headers.get("content-length"));
		const body = await res.arrayBuffer();
		expect(declared).toBeGreaterThan(0);
		expect(body.byteLength).toBe(declared);
	} finally {
		h.close();
	}
});
