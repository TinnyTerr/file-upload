import { bytesToBase64Url, randomKey } from "@/lib/base64url";
import { pollFinalize } from "@/lib/finalizePoll";
import { encryptBlob } from "@/workers/aeadClient";
import { filesService } from "../services/filesService";
import type { UploadOptions, UploadResult } from "../types";

/** Switch to the resumable chunked endpoint above this ciphertext size. */
const CHUNKED_THRESHOLD = 80 * 1024 * 1024; // 80 MiB
const MIN_CONCURRENT_CHUNKS = 1;
const MAX_CONCURRENT_CHUNKS = 6;
const INITIAL_CONCURRENT_CHUNKS = 2;
/** Re-measure throughput and adjust concurrency every N completed chunks. */
const SPEED_SAMPLE_CHUNKS = 3;
/** Throughput must move by more than this fraction between samples to trigger a step. */
const SPEED_STEP_THRESHOLD = 0.1;
const CHUNK_RETRIES = 3;

export type UploadPhase = "encrypting" | "uploading" | "finalizing";
export interface UploadProgress {
	phase: UploadPhase;
	percent: number;
}

export interface UploadOutcome {
	result: UploadResult;
	/** base64url client key (client mode only) for building the #ek= share URL. */
	clientKeyB64: string | null;
}

interface PerformArgs {
	file: File;
	options: UploadOptions;
	onProgress?: (p: UploadProgress) => void;
	signal?: AbortSignal;
	/** Reuse a fixed client key (e.g. one key for a whole folder bundle). */
	presetKey?: Uint8Array;
}

/**
 * End-to-end upload of a single file: optional client-side encryption, then a
 * single-shot or resumable chunked transfer depending on size.
 */
export async function performUpload({
	file,
	options,
	onProgress,
	signal,
	presetKey,
}: PerformArgs): Promise<UploadOutcome> {
	let payload: Blob = file;
	let clientKeyB64: string | null = null;

	if (options.encryption_mode === "client") {
		const key = presetKey ?? randomKey();
		payload = await encryptBlob(file, key, (percent) =>
			onProgress?.({ phase: "encrypting", percent }),
		);
		clientKeyB64 = bytesToBase64Url(key);
	}

	const result =
		payload.size >= CHUNKED_THRESHOLD
			? await chunkedUpload(payload, file, options, onProgress, signal)
			: await filesService.uploadSingle(
					payload,
					file.name,
					options,
					(percent) => onProgress?.({ phase: "uploading", percent }),
					signal,
				);

	return { result, clientKeyB64 };
}

async function chunkedUpload(
	payload: Blob,
	file: File,
	options: UploadOptions,
	onProgress?: (p: UploadProgress) => void,
	signal?: AbortSignal,
): Promise<UploadResult> {
	const init = await filesService.chunkedInit(
		file.name,
		payload.size,
		file.type || undefined,
		options,
	);
	const { upload_id, chunk_size, num_chunks } = init;
	const done = new Set<number>(init.received ?? []);

	const report = () =>
		onProgress?.({
			phase: "uploading",
			percent: Math.round((done.size / num_chunks) * 100),
		});
	report();

	const pending = Array.from({ length: num_chunks }, (_, i) => i).filter(
		(i) => !done.has(i),
	);
	let cursor = 0;

	// Adaptive concurrency: start conservative, then step the number of
	// simultaneously-in-flight chunks up or down based on measured throughput
	// (AIMD-style -- additive step up, halve on a transient failure).
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

	// Fixed pool of MAX_CONCURRENT_CHUNKS worker slots; a slot only pulls work
	// while its index is under the current (adjustable) concurrency target, so
	// raising/lowering `concurrency` takes effect immediately without having to
	// spawn or cancel promises.
	async function worker(slot: number) {
		while (cursor < pending.length) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			if (slot >= concurrency) {
				await delay(150);
				continue;
			}
			const index = pending[cursor++];
			if (index === undefined) break;
			const start = index * chunk_size;
			const chunk = payload.slice(
				start,
				Math.min(start + chunk_size, payload.size),
			);
			let attempt = 0;
			for (;;) {
				try {
					await filesService.chunkedSend(upload_id, index, chunk, signal);
					break;
				} catch (err) {
					if (signal?.aborted) throw err;
					backOff();
					if (++attempt >= CHUNK_RETRIES) throw err;
					await delay(300 * attempt);
				}
			}
			sampleThroughput(chunk.size);
			done.add(index);
			report();
		}
	}

	try {
		await Promise.all(
			Array.from(
				{ length: Math.min(MAX_CONCURRENT_CHUNKS, pending.length) },
				(_, i) => worker(i),
			),
		);
	} catch (err) {
		// Best-effort cleanup of the partial session unless we were cancelled.
		// Only the *transfer* is cleaned up this way: once finalize has been
		// asked for, the server may be minutes into assembling a multi-GB file
		// and an abort would be aimed at an upload that is about to succeed.
		if (!signal?.aborted) filesService.chunkedAbort(upload_id).catch(() => {});
		throw err;
	}

	onProgress?.({ phase: "finalizing", percent: 100 });
	// Polled, not awaited once: finalizing a large upload outlives any proxy's
	// request timeout, so the first response is usually a dead connection rather
	// than a verdict. See lib/finalizePoll.ts.
	return await pollFinalize(() => filesService.chunkedFinalize(upload_id), {
		signal,
	});
}

function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
