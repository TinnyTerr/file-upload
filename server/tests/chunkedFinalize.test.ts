/**
 * Finalizing a chunked upload is a minute or more of hashing on a multi-GB
 * file — longer than any proxy holds a request open. So it doesn't run inside
 * the request: finalize validates, answers 202, and does the work detached
 * while the client polls. These tests pin that contract, and the idempotence
 * that makes a poll safe to repeat.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db/types.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

/** Small enough that a modest test payload is genuinely multi-chunk. */
const CHUNK = 1024;
const storageDir = mkdtempSync(join(tmpdir(), "fu-chunk-"));

beforeAll(() => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
	process.env.FILEUPLOAD_CHUNK_SIZE = String(CHUNK);
});

afterAll(() => {
	process.env.FILEUPLOAD_STORAGE = undefined;
	process.env.FILEUPLOAD_CHUNK_SIZE = undefined;
	rmSync(storageDir, { recursive: true, force: true });
});

/** Deterministic, non-uniform bytes — a payload of repeated zeros would let a
 * chunk written to the wrong offset still hash correctly. */
function payload(size: number): Buffer {
	const buf = Buffer.alloc(size);
	for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 8)) & 0xff;
	return buf;
}

interface Finalizable {
	post(): Promise<Response>;
}

/** Poll a finalize to its conclusion, the way the client does. */
async function settle(
	f: Finalizable,
): Promise<{ status: number; body: Record<string, unknown> }> {
	for (let i = 0; i < 200; i++) {
		const res = await f.post();
		const body = (await res.json()) as Record<string, unknown>;
		if (res.status !== 202) return { status: res.status, body };
		expect(body.status).toBe("finalizing");
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("finalize never settled");
}

/** Init + send every chunk, stopping short of finalize. */
async function uploadChunks(
	h: Harness,
	auth: { cookie: string; csrf: string },
	body: Buffer,
): Promise<string> {
	const init = await h.request("/api/files/upload/init", {
		method: "POST",
		...auth,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			original_filename: "big.bin",
			total_size: body.length,
			content_type: "application/octet-stream",
		}),
	});
	expect(init.status).toBe(200);
	const { upload_id, chunk_size, num_chunks } = (await init.json()) as {
		upload_id: string;
		chunk_size: number;
		num_chunks: number;
	};
	expect(chunk_size).toBe(CHUNK);

	// Deliberately back to front: chunks are written at their own offset now,
	// so arrival order must not affect the assembled bytes.
	for (let i = num_chunks - 1; i >= 0; i--) {
		const slice = body.subarray(i * chunk_size, (i + 1) * chunk_size);
		const sent = await h.request(
			`/api/files/upload/chunk?upload_id=${encodeURIComponent(upload_id)}&index=${i}`,
			{
				method: "POST",
				...auth,
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(slice),
			},
		);
		expect(sent.status).toBe(200);
	}
	return upload_id;
}

function finalizer(
	h: Harness,
	uploadId: string,
	auth?: { cookie: string; csrf: string },
): Finalizable {
	return {
		post: () =>
			h.request("/api/files/upload/finalize", {
				method: "POST",
				...(auth ?? {}),
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ upload_id: uploadId }),
			}),
	};
}

function fileCount(db: Db): number {
	return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n;
}

describe("chunked upload finalize", () => {
	test("returns 202 immediately rather than doing the work inline", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "deferrer");
		const auth = h.signIn(user);

		const uploadId = await uploadChunks(h, auth, payload(CHUNK * 4));
		const first = await finalizer(h, uploadId, auth).post();

		// The whole point: the request that asks for the finalize does not wait
		// for it. A 200 here would mean the per-byte work ran inline again and
		// the proxy timeout is back.
		expect(first.status).toBe(202);
		const body = (await first.json()) as Record<string, unknown>;
		expect(body.status).toBe("finalizing");
		expect(typeof body.retry_after_ms).toBe("number");

		const settled = await settle(finalizer(h, uploadId, auth));
		expect(settled.status).toBe(200);
		expect(typeof settled.body.file_id).toBe("number");

		h.close();
	});

	test("assembles the exact bytes that were sent", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "assembler");
		const auth = h.signIn(user);
		const body = payload(CHUNK * 4 + 17); // deliberately not chunk-aligned

		const uploadId = await uploadChunks(h, auth, body);
		const settled = await settle(finalizer(h, uploadId, auth));
		expect(settled.status).toBe(200);

		// Chunks are written straight to their offsets and arrived out of order,
		// so this is what proves the offsets are right — and that the digests,
		// which are no longer recomputed from a re-read, still describe the
		// bytes the client sent. Get either wrong and dedup matches wrong blobs.
		const row = h.db.get<{ sha256: string; size_bytes: number }>(
			`SELECT b.sha256 AS sha256, f.size_bytes AS size_bytes
         FROM files f JOIN content_blobs b ON b.id = f.blob_id WHERE f.id = $id`,
			{ $id: settled.body.file_id },
		)!;
		expect(row.size_bytes).toBe(body.length);
		expect(row.sha256).toBe(createHash("sha256").update(body).digest("hex"));

		h.close();
	});

	test("a repeated finalize replays the result instead of 410ing", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "retrier");
		const auth = h.signIn(user);

		const uploadId = await uploadChunks(h, auth, payload(CHUNK * 3));
		const f = finalizer(h, uploadId, auth);
		const original = await settle(f);
		expect(original.status).toBe(200);

		// A poll that arrives after the work is done. The successful run removed
		// the `.parts` dir, so without the replay this is a 410 for a file that
		// has in fact been stored.
		const again = await f.post();
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual(original.body);

		// Replayed, not re-run: one upload, one file.
		expect(fileCount(h.db)).toBe(1);

		h.close();
	});

	test("aborting an already-finalized upload is refused", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "aborter");
		const auth = h.signIn(user);

		const uploadId = await uploadChunks(h, auth, payload(CHUNK * 2));
		expect((await settle(finalizer(h, uploadId, auth))).status).toBe(200);

		// The old client fired this on any finalize failure, including a timeout
		// on a finalize that succeeded. Reporting "aborted" for a stored file
		// tells the caller the opposite of what happened.
		const abort = await h.request(
			`/api/files/upload?upload_id=${encodeURIComponent(uploadId)}`,
			{ method: "DELETE", ...auth },
		);
		expect(abort.status).toBe(409);
		expect(fileCount(h.db)).toBe(1);

		h.close();
	});

	test("an incomplete finalize still reports its missing chunks", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "impatient");
		const auth = h.signIn(user);

		const init = await h.request("/api/files/upload/init", {
			method: "POST",
			...auth,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				original_filename: "partial.bin",
				total_size: CHUNK * 3,
				content_type: "application/octet-stream",
			}),
		});
		const { upload_id } = (await init.json()) as { upload_id: string };

		// Nothing sent. This must stay a synchronous, actionable 409 rather than
		// a 202 — the client has to be told to send chunks, not to keep polling.
		const fin = await finalizer(h, upload_id, auth).post();
		expect(fin.status).toBe(409);
		const { detail } = (await fin.json()) as {
			detail: { error: string; missing: number[] };
		};
		expect(detail.error).toBe("upload incomplete");
		expect(detail.missing).toEqual([0, 1, 2]);
		expect(fileCount(h.db)).toBe(0);

		h.close();
	});

	test("the detached job still records the uploader's IP and URL", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "audited");
		const auth = h.signIn(user);

		const uploadId = await uploadChunks(h, auth, payload(CHUNK * 2));
		const settled = await settle(finalizer(h, uploadId, auth));
		expect(settled.status).toBe(200);

		// Both are request-derived, and the request is long finished by the time
		// the job writes them. `clientIp` reads `req.socket.remoteAddress` last,
		// which empties on a destroyed socket — so these come from values read
		// while the socket was still up, not from the stale `req`.
		const audit = h.db.get<{ ip: string }>(
			"SELECT ip FROM audit_log WHERE action = 'file.uploaded' ORDER BY id DESC LIMIT 1",
		)!;
		expect(audit.ip).toBeTruthy();
		expect(String(settled.body.url)).toContain("/file/");

		h.close();
	});

	test("a failure in the detached job is reported to the poller", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "overquota");
		const auth = h.signIn(user);
		const body = payload(CHUNK * 3);

		const uploadId = await uploadChunks(h, auth, body);
		// Drop the quota under the upload *after* the chunks are in, so the
		// rejection happens inside the detached job rather than at any of the
		// synchronous checks. Nothing is left listening on the original request,
		// so an uncaptured error would strand the client polling forever.
		h.db.run("UPDATE permissions SET quota_bytes = 1 WHERE user_id = $id", {
			$id: user.id,
		});

		const settled = await settle(finalizer(h, uploadId, auth));
		expect(settled.status).toBe(413);
		expect(String(settled.body.detail)).toContain("quota");
		expect(fileCount(h.db)).toBe(0);

		h.close();
	});
});

describe("dropbox chunked finalize", () => {
	test("replays after the receive link has been spent", async () => {
		const h = await makeHarness();
		const owner = await makeUser(h.db, "dropowner");
		const auth = h.signIn(owner);

		const created = await h.request("/api/dropbox-links", {
			method: "POST",
			...auth,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expires_in_seconds: 3600 }),
		});
		expect(created.status).toBe(200);
		const { token } = (await created.json()) as { token: string };
		const body = payload(CHUNK * 3);

		// Anonymous throughout — a receive link takes no session.
		const init = await h.request(`/api/dropbox/${token}/upload/init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				original_filename: "drop.bin",
				total_size: body.length,
				content_type: "application/octet-stream",
			}),
		});
		expect(init.status).toBe(200);
		const { upload_id, chunk_size, num_chunks } = (await init.json()) as {
			upload_id: string;
			chunk_size: number;
			num_chunks: number;
		};
		for (let i = 0; i < num_chunks; i++) {
			const sent = await h.request(
				`/api/dropbox/${token}/upload/chunk?upload_id=${encodeURIComponent(upload_id)}&index=${i}`,
				{
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: new Uint8Array(
						body.subarray(i * chunk_size, (i + 1) * chunk_size),
					),
				},
			);
			expect(sent.status).toBe(200);
		}

		const f: Finalizable = {
			post: () =>
				h.request(`/api/dropbox/${token}/upload/finalize`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ upload_id }),
				}),
		};

		const original = await settle(f);
		expect(original.status).toBe(200);

		// This is the case that bit hardest in production: a successful finalize
		// marks the link used, so a poll's *link lookup* 410'd before the replay
		// could ever be reached.
		const again = await f.post();
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual(original.body);
		expect(fileCount(h.db)).toBe(1);

		h.close();
	});
});
