/**
 * The ranged download pool. These drive `rangedDownload` against a fake fetch,
 * so what is under test is the chunk plan, the reassembly order, the retry and
 * the 200 fallback — not the network.
 */

import { describe, expect, test } from "bun:test";
import {
	downloadErrorMessage,
	parseContentRange,
	rangedDownload,
} from "../src/features/download/lib/downloadCore";

const CHUNK = 16;

/** Non-uniform bytes: a chunk stitched at the wrong offset must not compare equal. */
function payload(size: number): Uint8Array {
	const b = new Uint8Array(size);
	for (let i = 0; i < size; i++) b[i] = (i * 31 + (i >> 8)) & 0xff;
	return b;
}

function parseRequestRange(init?: RequestInit): [number, number] | null {
	const header = new Headers(init?.headers).get("Range");
	if (!header) return null;
	const m = /^bytes=(\d+)-(\d*)$/.exec(header);
	if (!m) return null;
	return [Number(m[1]), m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER];
}

interface FakeServer {
	fetchImpl: typeof fetch;
	requests: string[];
}

/** A server that honours Range, optionally failing chosen attempts. */
function rangeServer(
	body: Uint8Array,
	opts: {
		failAttempts?: Set<number>;
		totalOverride?: (n: number) => number;
	} = {},
): FakeServer {
	const requests: string[] = [];
	let attempt = 0;
	const fetchImpl = (async (_url: string, init?: RequestInit) => {
		const range = parseRequestRange(init);
		const n = attempt++;
		requests.push(range ? `${range[0]}-${range[1]}` : "full");
		if (opts.failAttempts?.has(n)) throw new Error("connection reset");
		if (!range) return new Response(body, { status: 200 });
		const start = range[0];
		const end = Math.min(range[1], body.length - 1);
		const total = opts.totalOverride?.(n) ?? body.length;
		return new Response(body.slice(start, end + 1), {
			status: 206,
			headers: { "Content-Range": `bytes ${start}-${end}/${total}` },
		});
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

describe("parseContentRange", () => {
	test("reads start, end and total", () => {
		expect(parseContentRange("bytes 0-99/1000")).toEqual({
			start: 0,
			end: 99,
			total: 1000,
		});
	});

	test("rejects a header with no usable total", () => {
		expect(parseContentRange("bytes 0-99/*")).toBeNull();
		expect(parseContentRange(null)).toBeNull();
		expect(parseContentRange("nonsense")).toBeNull();
	});
});

describe("rangedDownload", () => {
	test("reassembles the chunks in order", async () => {
		const body = payload(CHUNK * 5 + 3);
		const server = rangeServer(body);
		const out = await rangedDownload("/raw", {
			chunkBytes: CHUNK,
			fetchImpl: server.fetchImpl,
		});
		expect(await bytesOf(out)).toEqual(body);
		// One request per chunk, the first of them the probe that learned the size.
		expect(server.requests.length).toBe(6);
		expect(server.requests[0]).toBe(`0-${CHUNK - 1}`);
	});

	test("a file smaller than one chunk takes a single request", async () => {
		const body = payload(CHUNK - 1);
		const server = rangeServer(body);
		const out = await rangedDownload("/raw", {
			chunkBytes: CHUNK,
			fetchImpl: server.fetchImpl,
		});
		expect(await bytesOf(out)).toEqual(body);
		expect(server.requests.length).toBe(1);
	});

	test("progress ends at exactly 100% of the real total", async () => {
		const body = payload(CHUNK * 4);
		const server = rangeServer(body);
		const seen: number[] = [];
		await rangedDownload("/raw", {
			chunkBytes: CHUNK,
			fetchImpl: server.fetchImpl,
			onProgress: (p) => seen.push(p.percent),
		});
		expect(seen.at(-1)).toBe(100);
		expect(Math.max(...seen)).toBe(100);
		expect(seen.every((p) => p >= 0 && p <= 100)).toBe(true);
	});

	test("a 200 answer is taken as the whole file, with no second request", async () => {
		const body = payload(CHUNK * 4);
		const requests: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			requests.push(new Headers(init?.headers).get("Range") ?? "none");
			// The server declined the range: a transformed blob, or a limited-use
			// link. What comes back is everything.
			return new Response(body, {
				status: 200,
				headers: { "Content-Length": String(body.length) },
			});
		}) as unknown as typeof fetch;
		const out = await rangedDownload("/raw", { chunkBytes: CHUNK, fetchImpl });
		expect(await bytesOf(out)).toEqual(body);
		expect(requests.length).toBe(1);
	});

	test("retries a failed chunk rather than the whole file", async () => {
		const body = payload(CHUNK * 4);
		// Attempt 0 is the probe; fail one of the pool's requests.
		const server = rangeServer(body, { failAttempts: new Set([2]) });
		const out = await rangedDownload("/raw", {
			chunkBytes: CHUNK,
			fetchImpl: server.fetchImpl,
		});
		expect(await bytesOf(out)).toEqual(body);
		expect(server.requests.length).toBe(5); // 4 chunks + 1 retry
	});

	test("gives up once a chunk has failed its retries", async () => {
		const body = payload(CHUNK * 3);
		const server = rangeServer(body, {
			failAttempts: new Set([1, 2, 3, 4, 5, 6]),
		});
		await expect(
			rangedDownload("/raw", {
				chunkBytes: CHUNK,
				fetchImpl: server.fetchImpl,
			}),
		).rejects.toThrow("connection reset");
	});

	test("refuses to stitch chunks from a file that changed size", async () => {
		const body = payload(CHUNK * 4);
		const server = rangeServer(body, {
			// Every request after the probe reports a different total.
			totalOverride: (n) => (n === 0 ? body.length : body.length + 1),
		});
		await expect(
			rangedDownload("/raw", {
				chunkBytes: CHUNK,
				fetchImpl: server.fetchImpl,
			}),
		).rejects.toThrow("changed while it was downloading");
	});

	test("surfaces a dead link as its status message", async () => {
		const fetchImpl = (async () =>
			new Response("", { status: 404 })) as unknown as typeof fetch;
		await expect(rangedDownload("/raw", { fetchImpl })).rejects.toThrow(
			"Link not found, expired, or exhausted.",
		);
	});

	test("names the failure by status", () => {
		expect(downloadErrorMessage(404)).toContain("not found");
		expect(downloadErrorMessage(429)).toContain("Too many");
		expect(downloadErrorMessage(500)).toBe("Download failed (500)");
	});
});
