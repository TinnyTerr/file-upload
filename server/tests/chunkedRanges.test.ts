/**
 * Protocol 2 chunked uploads: each chunk is an arbitrary `[offset, offset+length)`
 * range the client picked from the link it measured. These pin the bounds the
 * server enforces, that arrival order and overlaps don't matter, and that
 * finalize names the exact gaps when something is still missing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { present } from "../src/present.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

const KIB = 1024;
const MIB = 1024 * 1024;
const MIN = 50 * KIB;
const MAX = 70 * MIB;

const storageDir = mkdtempSync(join(tmpdir(), "fu-ranges-"));

beforeAll(() => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
});

afterAll(() => {
	delete process.env.FILEUPLOAD_STORAGE;
	rmSync(storageDir, { recursive: true, force: true });
});

function payload(size: number): Buffer {
	const buf = Buffer.alloc(size);
	for (let i = 0; i < size; i++) buf[i] = (i * 17 + (i >> 9)) & 0xff;
	return buf;
}

type Auth = { cookie: string; csrf: string };

async function initV2(h: Harness, auth: Auth, total: number) {
	const res = await h.request("/api/files/upload/init", {
		method: "POST",
		...auth,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			original_filename: "ranged.bin",
			total_size: total,
			content_type: "application/octet-stream",
			chunk_protocol: 2,
		}),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as {
		upload_id: string;
		protocol: number;
		chunk_min: number;
		chunk_max: number;
	};
}

async function sendRange(
	h: Harness,
	auth: Auth,
	uploadId: string,
	offset: number,
	length: number,
	body: Buffer,
) {
	return h.request(
		`/api/files/upload/chunk?upload_id=${encodeURIComponent(uploadId)}&offset=${offset}&length=${length}`,
		{
			method: "POST",
			...auth,
			headers: { "content-type": "application/octet-stream" },
			body: new Uint8Array(body.subarray(offset, offset + length)),
		},
	);
}

async function status(h: Harness, auth: Auth, uploadId: string) {
	const res = await h.request(
		`/api/files/upload/status?upload_id=${encodeURIComponent(uploadId)}`,
		{ method: "GET", ...auth },
	);
	expect(res.status).toBe(200);
	return (await res.json()) as {
		ranges: Array<[number, number]>;
		protocol: number;
	};
}

async function finalize(h: Harness, auth: Auth, uploadId: string) {
	return h.request("/api/files/upload/finalize", {
		method: "POST",
		...auth,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ upload_id: uploadId }),
	});
}

describe("chunked upload protocol 2", () => {
	test("init advertises the chunk bounds and the protocol", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "bounds");
		const auth = h.signIn(user);

		const init = await initV2(h, auth, 3 * MIB);
		expect(init.protocol).toBe(2);
		expect(init.chunk_min).toBe(MIN);
		expect(init.chunk_max).toBe(MAX);

		h.close();
	});

	test("arbitrary-length ranges sent out of order assemble the exact bytes", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "ranger");
		const auth = h.signIn(user);
		const body = payload(200 * KIB + 17); // tail is the one short chunk allowed

		const { upload_id } = await initV2(h, auth, body.length);
		// Three different lengths, sent back to front.
		const plan: Array<[number, number]> = [
			[0, 51200],
			[51200, 102400],
			[153600, body.length - 153600],
		];
		for (const [offset, length] of [...plan].reverse()) {
			const sent = await sendRange(h, auth, upload_id, offset, length, body);
			expect(sent.status).toBe(200);
		}

		const settled = await finalize(h, auth, upload_id);
		expect(settled.status).toBe(202);
		let final = settled;
		for (let i = 0; i < 200 && final.status === 202; i++) {
			await new Promise((r) => setTimeout(r, 25));
			final = await finalize(h, auth, upload_id);
		}
		expect(final.status).toBe(200);
		const { file_id } = (await final.json()) as { file_id: number };

		const row = present(
			h.db.get<{ sha256: string; size_bytes: number }>(
				`SELECT b.sha256 AS sha256, f.size_bytes AS size_bytes
         FROM files f JOIN content_blobs b ON b.id = f.blob_id WHERE f.id = $id`,
				{ $id: file_id },
			),
		);
		expect(row.size_bytes).toBe(body.length);
		expect(row.sha256).toBe(createHash("sha256").update(body).digest("hex"));

		h.close();
	});

	test("overlapping retries merge in status and do not double count", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "overlapper");
		const auth = h.signIn(user);
		const body = payload(200 * KIB);

		const { upload_id } = await initV2(h, auth, body.length);
		expect(
			(await sendRange(h, auth, upload_id, 0, 100 * KIB, body)).status,
		).toBe(200);
		// A retry that picked a different length and starts inside the first.
		expect(
			(await sendRange(h, auth, upload_id, 80 * KIB, 120 * KIB, body)).status,
		).toBe(200);

		const st = await status(h, auth, upload_id);
		expect(st.protocol).toBe(2);
		expect(st.ranges).toEqual([[0, 200 * KIB]]);

		h.close();
	});

	test("out-of-bounds, undersized and oversized ranges are refused", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "bounded");
		const auth = h.signIn(user);
		const body = payload(200 * KIB);
		const { upload_id } = await initV2(h, auth, body.length);

		// Runs past the end of the file.
		expect(
			(await sendRange(h, auth, upload_id, 150 * KIB, 100 * KIB, body)).status,
		).toBe(400);
		// Shorter than the minimum, and not the tail.
		expect(
			(await sendRange(h, auth, upload_id, 0, 10 * KIB, body)).status,
		).toBe(400);
		// Over the maximum: refused before the body is read.
		const huge = await h.request(
			`/api/files/upload/chunk?upload_id=${encodeURIComponent(upload_id)}&offset=0&length=${MAX + 1}`,
			{
				method: "POST",
				...auth,
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(0),
			},
		);
		expect(huge.status).toBe(400);
		// Negative offset.
		expect(
			(
				await h.request(
					`/api/files/upload/chunk?upload_id=${encodeURIComponent(upload_id)}&offset=-1&length=${MIN}`,
					{
						method: "POST",
						...auth,
						headers: { "content-type": "application/octet-stream" },
						body: new Uint8Array(MIN),
					},
				)
			).status,
		).toBe(400);

		h.close();
	});

	test("finalize before completion names the missing byte ranges", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "gapped");
		const auth = h.signIn(user);
		const body = payload(200 * KIB);
		const { upload_id } = await initV2(h, auth, body.length);

		expect(
			(await sendRange(h, auth, upload_id, 0, 60 * KIB, body)).status,
		).toBe(200);
		expect(
			(await sendRange(h, auth, upload_id, 120 * KIB, 80 * KIB, body)).status,
		).toBe(200);

		const res = await finalize(h, auth, upload_id);
		expect(res.status).toBe(409);
		const detail = (
			(await res.json()) as { detail: { missing_ranges: unknown } }
		).detail;
		expect(detail.missing_ranges).toEqual([[60 * KIB, 120 * KIB]]);

		h.close();
	});
});
