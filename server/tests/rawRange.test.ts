/**
 * `GET /api/file/:slug/raw` under Range.
 *
 * A chunked download is many requests for one download, so the accounting has
 * to survive that: only the request covering byte zero spends a link use. And
 * because a limited-use link enforces its budget per request, it doesn't serve
 * ranges at all — the alternative is either spending the budget N ways or
 * handing out the whole file for `bytes=1-` for free.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nowIso, type UserRow } from "../src/db/rows.ts";
import type { Db } from "../src/db/types.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

const storageDir = mkdtempSync(join(tmpdir(), "fu-range-"));

beforeAll(() => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
});

afterAll(() => {
	delete process.env.FILEUPLOAD_STORAGE;
	rmSync(storageDir, { recursive: true, force: true });
});

/** Non-uniform bytes: a range served from the wrong offset must not compare equal. */
function payload(size: number): Buffer {
	const buf = Buffer.alloc(size);
	for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 8)) & 0xff;
	return buf;
}

/** An unencrypted, uncompressed file on disk plus a link pointing at it. */
function makeSharedFile(
	db: Db,
	owner: UserRow,
	body: Buffer,
	opts: { maxUses?: number | null } = {},
): { slug: string; fileId: number } {
	const rel = `ab/cd/${randomBytes(8).toString("hex")}`;
	const full = join(storageDir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
	db.run(
		`INSERT INTO files (owner_id, storage_path, original_filename, source_type,
       size_bytes, stored_size_bytes, content_type, encryption_mode,
       encryption_overridden, created_at)
     VALUES ($owner, $path, 'range.bin', 'upload', $size, $size,
       'application/octet-stream', 'none', 1, $now)`,
		{ $owner: owner.id, $path: rel, $size: body.length, $now: nowIso() },
	);
	const fileId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
	const slug = randomBytes(8).toString("base64url");
	db.run(
		`INSERT INTO links (file_id, slug, max_uses, use_count, active, created_at)
     VALUES ($file, $slug, $max, 0, 1, $now)`,
		{
			$file: fileId,
			$slug: slug,
			$max: opts.maxUses ?? null,
			$now: nowIso(),
		},
	);
	return { slug, fileId };
}

function useCount(db: Db, slug: string): number {
	return db.get<{ use_count: number }>(
		"SELECT use_count FROM links WHERE slug = $slug",
		{ $slug: slug },
	)!.use_count;
}

describe("ranged raw download", () => {
	let h: Harness;
	let owner: UserRow;
	const body = payload(4096);

	beforeAll(async () => {
		h = await makeHarness();
		owner = await makeUser(h.db, "ranger");
	});

	afterAll(() => h.close());

	test("advertises ranges and serves the requested slice", async () => {
		const { slug } = makeSharedFile(h.db, owner, body);
		const res = await h.request(`/api/file/${slug}/raw`, {
			headers: { range: "bytes=1024-2047" },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(res.headers.get("content-range")).toBe("bytes 1024-2047/4096");
		const got = Buffer.from(await res.arrayBuffer());
		expect(got.equals(body.subarray(1024, 2048))).toBe(true);
	});

	test("only the range covering byte zero spends a use", async () => {
		const { slug } = makeSharedFile(h.db, owner, body);
		await h.request(`/api/file/${slug}/raw`, {
			headers: { range: "bytes=0-1023" },
		});
		expect(useCount(h.db, slug)).toBe(1);

		// The other three chunks of the same download.
		for (const range of ["bytes=1024-2047", "bytes=2048-3071", "bytes=3072-"]) {
			const res = await h.request(`/api/file/${slug}/raw`, {
				headers: { range },
			});
			expect(res.status).toBe(206);
		}
		expect(useCount(h.db, slug)).toBe(1);
	});

	test("an un-ranged download still spends a use", async () => {
		const { slug } = makeSharedFile(h.db, owner, body);
		const res = await h.request(`/api/file/${slug}/raw`);
		expect(res.status).toBe(200);
		expect(useCount(h.db, slug)).toBe(1);
	});

	test("the parallel chunks reassemble into the original file", async () => {
		const { slug } = makeSharedFile(h.db, owner, body);
		const chunk = 1024;
		const parts = await Promise.all(
			[0, 1, 2, 3].map(async (i) => {
				const res = await h.request(`/api/file/${slug}/raw`, {
					headers: {
						range: `bytes=${i * chunk}-${(i + 1) * chunk - 1}`,
					},
				});
				expect(res.status).toBe(206);
				return Buffer.from(await res.arrayBuffer());
			}),
		);
		expect(Buffer.concat(parts).equals(body)).toBe(true);
		expect(useCount(h.db, slug)).toBe(1);
	});

	test("a limited-use link ignores Range and answers the whole body", async () => {
		const { slug } = makeSharedFile(h.db, owner, body, { maxUses: 3 });
		const res = await h.request(`/api/file/${slug}/raw`, {
			headers: { range: "bytes=1024-2047" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("accept-ranges")).toBeNull();
		const got = Buffer.from(await res.arrayBuffer());
		expect(got.equals(body)).toBe(true);
		// Budget is still enforced per request — a continuation cannot be free
		// here, because it would be a free copy of the whole file.
		expect(useCount(h.db, slug)).toBe(1);
	});

	test("an exhausted link serves nothing, ranged or not", async () => {
		const { slug } = makeSharedFile(h.db, owner, body, { maxUses: 1 });
		expect((await h.request(`/api/file/${slug}/raw`)).status).toBe(200);
		const after = await h.request(`/api/file/${slug}/raw`, {
			headers: { range: "bytes=1024-2047" },
		});
		expect(after.status).toBe(404);
	});

	test("an unsatisfiable range is a 416 with the file's size", async () => {
		const { slug } = makeSharedFile(h.db, owner, body);
		const res = await h.request(`/api/file/${slug}/raw`, {
			headers: { range: "bytes=99999-" },
		});
		expect(res.status).toBe(416);
		expect(res.headers.get("content-range")).toBe("bytes */4096");
	});

	test("one download writes one audit row however many chunks it took", async () => {
		const { slug, fileId } = makeSharedFile(h.db, owner, body);
		for (const range of ["bytes=0-1023", "bytes=1024-2047", "bytes=2048-"]) {
			await h.request(`/api/file/${slug}/raw`, { headers: { range } });
		}
		const rows = h.db.all<{ n: number }>(
			`SELECT COUNT(*) AS n FROM audit_log
       WHERE action = 'file.downloaded' AND target = $target`,
			{ $target: `file:${fileId}` },
		);
		expect(rows[0]!.n).toBe(1);
	});
});
