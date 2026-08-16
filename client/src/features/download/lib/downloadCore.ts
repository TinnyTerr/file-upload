/**
 * Parallel ranged download — the read-side mirror of `files/lib/uploadCore.ts`.
 *
 * A single `fetch` of a multi-GB share link is one TCP connection doing one
 * thing: it can't use more bandwidth than that connection gets, and a stall
 * anywhere in it loses the whole transfer. `/file/:slug/raw` serves
 * `Accept-Ranges: bytes` for any blob it doesn't have to transform, so the same
 * chunk pool the uploader uses works here — a fixed set of worker slots pulling
 * byte ranges, AIMD concurrency off measured throughput, and per-chunk retry so
 * a dropped connection costs one chunk instead of the file.
 *
 * The client never decides *whether* ranges are available. It asks for the
 * first chunk with a `Range` header and reads the answer: a 206 means chunk
 * away, a 200 means the server declined (a transformed blob it must reproduce
 * from byte zero, a limited-use link, or any proxy in between) and that
 * response *is* the whole file, so the fallback costs no extra request.
 */

/** Bytes per ranged request. */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** Below this, one connection is fine and the extra round trips aren't worth it. */
export const CHUNKED_DOWNLOAD_THRESHOLD = 16 * 1024 * 1024;
const MIN_CONCURRENT_CHUNKS = 1;
const MAX_CONCURRENT_CHUNKS = 6;
const INITIAL_CONCURRENT_CHUNKS = 2;
/** Re-measure throughput and adjust concurrency every N completed chunks. */
const SPEED_SAMPLE_CHUNKS = 3;
/** Throughput must move by more than this fraction between samples to trigger a step. */
const SPEED_STEP_THRESHOLD = 0.1;
const CHUNK_RETRIES = 3;

export interface DownloadProgress {
	loaded: number;
	/** 0 when the server sent no length — percent is 0 then too. */
	total: number;
	percent: number;
}

export interface RangedDownloadOptions {
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
	/** Test seam; production always uses the constant above. */
	chunkBytes?: number;
	fetchImpl?: typeof fetch;
}

/** The message a failed raw fetch should carry, from its status alone. */
export function downloadErrorMessage(status: number): string {
	if (status === 404) return "Link not found, expired, or exhausted.";
	if (status === 401 || status === 403)
		return "This link needs a key you haven't presented.";
	if (status === 429) return "Too many attempts; try again later.";
	return `Download failed (${status})`;
}

/** `bytes 0-8388607/104857600` → `{ start, end, total }`; null if unusable. */
export function parseContentRange(
	header: string | null,
): { start: number; end: number; total: number } | null {
	if (!header) return null;
	const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
	if (!m) return null;
	const [, start, end, total] = m;
	return { start: Number(start), end: Number(end), total: Number(total) };
}

/**
 * Download `url` as a Blob, in parallel byte ranges when the server allows it.
 *
 * Chunks are collected by index and joined in order at the end, so the pool can
 * finish them out of order without reordering bytes.
 */
export async function rangedDownload(
	url: string,
	opts: RangedDownloadOptions = {},
): Promise<Blob> {
	const {
		onProgress,
		signal,
		chunkBytes = CHUNK_BYTES,
		fetchImpl = fetch,
	} = opts;

	let loaded = 0;
	let total = 0;
	const report = () =>
		onProgress?.({
			loaded,
			total,
			percent: total ? Math.round((loaded / total) * 100) : 0,
		});

	const get = async (range?: string) => {
		const res = await fetchImpl(url, {
			credentials: "same-origin",
			signal,
			headers: range ? { Range: range } : undefined,
		});
		if (!res.ok) throw new Error(downloadErrorMessage(res.status));
		return res;
	};

	const first = await get(`bytes=0-${chunkBytes - 1}`);
	const contentRange = parseContentRange(first.headers.get("Content-Range"));

	// Not a ranged answer (or one we can't plan from): this response is the whole
	// file. Drain it and we're done — no second request, nothing wasted.
	if (first.status !== 206 || !contentRange) {
		total = Number(first.headers.get("Content-Length") ?? 0);
		report();
		return await readBody(first, (n) => {
			loaded += n;
			report();
		});
	}

	total = contentRange.total;
	report();
	const parts: (Blob | undefined)[] = [];
	parts[0] = await readBody(first, (n) => {
		loaded += n;
		report();
	});

	const numChunks = Math.max(1, Math.ceil(total / chunkBytes));
	const pending = Array.from({ length: numChunks }, (_, i) => i).slice(1);
	let cursor = 0;

	// Adaptive concurrency, identical in shape to the uploader's: start
	// conservative, step up while throughput improves, halve on a failure.
	let concurrency = Math.min(INITIAL_CONCURRENT_CHUNKS, pending.length || 1);
	let windowBytes = 0;
	let windowChunks = 0;
	let windowStart = performance.now();
	let lastThroughput = 0;

	function sampleThroughput(bytes: number) {
		windowBytes += bytes;
		windowChunks++;
		if (windowChunks < SPEED_SAMPLE_CHUNKS) return;
		const elapsedSec = (performance.now() - windowStart) / 1000;
		const throughput = elapsedSec > 0 ? windowBytes / elapsedSec : 0;
		if (lastThroughput > 0) {
			const change = (throughput - lastThroughput) / lastThroughput;
			if (change > SPEED_STEP_THRESHOLD) {
				concurrency = Math.min(MAX_CONCURRENT_CHUNKS, concurrency + 1);
			} else if (change < -SPEED_STEP_THRESHOLD) {
				concurrency = Math.max(MIN_CONCURRENT_CHUNKS, concurrency - 1);
			}
		}
		lastThroughput = throughput;
		windowBytes = 0;
		windowChunks = 0;
		windowStart = performance.now();
	}

	function backOff() {
		concurrency = Math.max(MIN_CONCURRENT_CHUNKS, Math.floor(concurrency / 2));
	}

	async function fetchChunk(index: number): Promise<Blob> {
		const start = index * chunkBytes;
		const end = Math.min(start + chunkBytes, total) - 1;
		// Bytes counted for this attempt, so a retry rewinds the progress bar
		// instead of carrying the abandoned attempt's bytes into the total.
		let got = 0;
		try {
			const res = await get(`bytes=${start}-${end}`);
			const cr = parseContentRange(res.headers.get("Content-Range"));
			// A 200 here, or a different total, means the bytes under us are not
			// the bytes chunk 0 came from. Stitching them would produce a file that
			// is corrupt in a way nothing downstream could detect.
			if (res.status !== 206 || !cr || cr.total !== total) {
				throw new Error("The file changed while it was downloading.");
			}
			const blob = await readBody(res, (n) => {
				got += n;
				loaded += n;
				report();
			});
			// A short chunk would silently shift every later chunk in the join.
			if (blob.size !== end - start + 1) throw new Error("Truncated chunk");
			return blob;
		} catch (err) {
			loaded -= got;
			report();
			throw err;
		}
	}

	// Fixed pool of MAX_CONCURRENT_CHUNKS slots; a slot only takes work while its
	// index is under the current concurrency target, so raising or lowering that
	// target takes effect without spawning or cancelling promises.
	async function worker(slot: number) {
		while (cursor < pending.length) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			if (slot >= concurrency) {
				await delay(150);
				continue;
			}
			const index = pending[cursor++];
			if (index === undefined) break;
			let attempt = 0;
			for (;;) {
				try {
					parts[index] = await fetchChunk(index);
					break;
				} catch (err) {
					if (signal?.aborted) throw err;
					backOff();
					if (++attempt >= CHUNK_RETRIES) throw err;
					await delay(300 * attempt);
				}
			}
			sampleThroughput(parts[index]?.size ?? 0);
		}
	}

	await Promise.all(
		Array.from(
			{ length: Math.min(MAX_CONCURRENT_CHUNKS, pending.length) },
			(_, i) => worker(i),
		),
	);

	const ordered = parts.slice(0, numChunks);
	if (ordered.some((p) => p === undefined)) {
		throw new Error("Download incomplete");
	}
	return new Blob(ordered as Blob[]);
}

/** Read a response body, reporting bytes as they land. */
async function readBody(
	res: Response,
	onBytes: (n: number) => void,
): Promise<Blob> {
	if (!res.body) return res.blob();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		onBytes(value.length);
	}
	return new Blob(chunks as BlobPart[]);
}

function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
