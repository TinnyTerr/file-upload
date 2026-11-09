import { ApiError } from "@/config/api";
import { bytesToBase64Url, randomKey } from "@/lib/base64url";
import { pollFinalize } from "@/lib/finalizePoll";
import { encryptBlob } from "@/workers/aeadClient";
import type { ByteRange } from "../services/filesService";
import { filesService } from "../services/filesService";
import type { UploadOptions, UploadResult } from "../types";
import {
	coveredBytes,
	foldRate,
	mergeRanges,
	nextChunkLength,
	RangeQueue,
} from "./chunkPlanner";
import {
	forgetSession,
	isResumable,
	loadSession,
	resumeKey,
	saveSession,
} from "./uploadResume";

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

/**
 * Protocol 2: every chunk is an arbitrary `[offset, offset + length)` range,
 * sized per request from the rate the link has actually delivered (see
 * chunkPlanner.ts). Resume asks the server which ranges it holds and only sends
 * the gaps.
 */
async function chunkedUpload(
	payload: Blob,
	file: File,
	options: UploadOptions,
	onProgress?: (p: UploadProgress) => void,
	signal?: AbortSignal,
): Promise<UploadResult> {
	const total = payload.size;
	const resumeId = isResumable(options)
		? resumeKey(file, total, options)
		: null;
	const session = await openSession(file, total, options, resumeId);
	const { upload_id } = session;
	let covered: ByteRange[] = mergeRanges(session.ranges);
	const queue = new RangeQueue(total, covered);

	const report = () =>
		onProgress?.({
			phase: "uploading",
			percent: Math.round((coveredBytes(covered) / total) * 100),
		});
	report();

	// Adaptive concurrency: start conservative, then step the number of
	// simultaneously-in-flight chunks up or down based on measured throughput
	// (AIMD-style -- additive step up, halve on a transient failure).
	let concurrency = INITIAL_CONCURRENT_CHUNKS;
	let windowBytes = 0;
	let windowChunks = 0;
	let windowStart = performance.now();
	let lastThroughput = 0;
	// Per-chunk rate (bytes/s) the next chunk length is sized from. Each chunk
	// is measured on its own, so the rate already reflects how many slots share
	// the link: sizing to it keeps every chunk near TARGET_CHUNK_SECONDS.
	let rate: number | null = null;

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
		// A failure is read as the link being slower than measured, so the next
		// chunks shrink too: a timeout is most often a chunk that took too long.
		if (rate !== null) rate /= 2;
	}

	// Fixed pool of MAX_CONCURRENT_CHUNKS worker slots; a slot only pulls work
	// while its index is under the current (adjustable) concurrency target, so
	// raising/lowering `concurrency` takes effect immediately without having to
	// spawn or cancel promises.
	async function worker(slot: number) {
		for (;;) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			if (slot >= concurrency) {
				if (queue.exhausted) return;
				await delay(150);
				continue;
			}
			const next = queue.take(nextChunkLength(rate));
			if (!next) return;
			const { offset, length } = next;
			const body = payload.slice(offset, offset + length);

			let attempt = 0;
			for (;;) {
				const started = performance.now();
				try {
					await filesService.chunkedSend(
						upload_id,
						offset,
						length,
						body,
						signal,
					);
					// Only the attempt that landed is timed; a retry's backoff is not.
					rate = foldRate(rate, {
						bytes: length,
						seconds: (performance.now() - started) / 1000,
					});
					break;
				} catch (err) {
					if (signal?.aborted) throw err;
					logChunkFailure(err, {
						offset,
						length,
						attempt: attempt + 1,
						elapsedMs: Math.round(performance.now() - started),
						concurrency,
						rate,
					});
					backOff();
					if (++attempt >= CHUNK_RETRIES) throw err;
					await delay(300 * attempt);
				}
			}
			sampleThroughput(length);
			covered = mergeRanges([...covered, [offset, offset + length]]);
			report();
		}
	}

	try {
		await Promise.all(
			Array.from({ length: MAX_CONCURRENT_CHUNKS }, (_, i) => worker(i)),
		);
	} catch (err) {
		// A cancel throws the session away. Any other failure (a dropped
		// connection, a reload mid-transfer) keeps it: the ranges that landed are
		// what a re-picked file resumes from, and the server sweeps abandoned
		// sessions after 12 h. Only the *transfer* is cleaned up here: once
		// finalize has been asked for, the server may be minutes into assembling a
		// multi-GB file and an abort would be aimed at an upload about to succeed.
		if (signal?.aborted) {
			if (resumeId) forgetSession(resumeId);
			filesService.chunkedAbort(upload_id).catch(() => {});
		}
		throw err;
	}

	onProgress?.({ phase: "finalizing", percent: 100 });
	// Polled, not awaited once: finalizing a large upload outlives any proxy's
	// request timeout, so the first response is usually a dead connection rather
	// than a verdict. See lib/finalizePoll.ts.
	const result = await pollFinalize(
		() => filesService.chunkedFinalize(upload_id),
		{ signal },
	);
	if (resumeId) forgetSession(resumeId);
	return result;
}

/** Continues a remembered session if the server still holds it and it still
 * describes this exact payload; otherwise starts a fresh one. */
async function openSession(
	file: File,
	payloadSize: number,
	options: UploadOptions,
	resumeId: string | null,
): Promise<{ upload_id: string; ranges: ByteRange[] }> {
	if (resumeId) {
		const remembered = loadSession(resumeId);
		if (remembered) {
			try {
				const status = await filesService.chunkedStatus(remembered);
				// A session from the index protocol (older tab) has no ranges to
				// resume from, so it starts over like any other mismatch.
				if (status.total === payloadSize && status.ranges) {
					return { upload_id: remembered, ranges: status.ranges };
				}
			} catch {
				// 410 gone, 403 other user, token expired: all mean start over.
			}
			forgetSession(resumeId);
		}
	}
	const init = await filesService.chunkedInit(
		file.name,
		payloadSize,
		file.type || undefined,
		options,
	);
	if (resumeId) saveSession(resumeId, init.upload_id);
	return { upload_id: init.upload_id, ranges: [] };
}

function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** A failed chunk attempt, with what's needed to tell Cloudflare from the app:
 * a proxy-generated error carries a cf-ray and a non-app `server` header, a
 * dropped connection has no status at all (a bare TypeError). */
function logChunkFailure(
	err: unknown,
	ctx: {
		offset: number;
		length: number;
		attempt: number;
		elapsedMs: number;
		concurrency: number;
		rate: number | null;
	},
) {
	const h = err instanceof ApiError ? err.headers : undefined;
	const conn = (
		navigator as Navigator & {
			connection?: { effectiveType?: string; rtt?: number; downlink?: number };
		}
	).connection;
	console.warn("[upload] chunk failed", {
		...ctx,
		kind: err instanceof ApiError ? "http" : "network",
		status: err instanceof ApiError ? err.status : null,
		error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		cfRay: h?.get("cf-ray") ?? null,
		server: h?.get("server") ?? null,
		online: navigator.onLine,
		link: conn
			? { type: conn.effectiveType, rtt: conn.rtt, downlink: conn.downlink }
			: null,
	});
}
