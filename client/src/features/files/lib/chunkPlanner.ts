/**
 * Adaptive chunk sizing for chunked uploads (protocol 2).
 *
 * Each chunk is sized to take about TARGET_CHUNK_SECONDS on the link it is
 * measured against: slow links get small chunks so no single request sits long
 * enough to hit a proxy timeout, fast links get large ones so they aren't cut
 * into needless round trips. Everything here is pure, so the upload core and the
 * admin connection test run the same arithmetic and the debug page shows the
 * numbers a real upload would use.
 */
import type { ByteRange } from "../services/filesService";

/** Mirrors the server's CHUNK_MIN_SIZE / CHUNK_MAX_SIZE. */
export const CHUNK_MIN = 50 * 1024;
export const CHUNK_MAX = 70 * 1024 * 1024;
/** Length of the first chunks, before there is any rate to size from. */
export const CHUNK_INITIAL = 1024 * 1024;
export const TARGET_CHUNK_SECONDS = 15;
/** Weight of the newest chunk in the rate average. */
export const RATE_SMOOTHING = 0.3;

export interface ChunkSample {
	bytes: number;
	seconds: number;
}

export function clampLength(bytes: number): number {
	return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.round(bytes)));
}

/** Folds one completed chunk into the running rate (bytes/s). `null` means no
 * rate yet, in which case the first observation is taken as-is. */
export function foldRate(rate: number | null, sample: ChunkSample): number {
	const observed = sample.seconds > 0 ? sample.bytes / sample.seconds : 0;
	if (rate === null) return observed;
	return RATE_SMOOTHING * observed + (1 - RATE_SMOOTHING) * rate;
}

/** Length for the next chunk. Before a rate exists, the initial size. */
export function nextChunkLength(
	rate: number | null,
	targetSeconds: number = TARGET_CHUNK_SECONDS,
): number {
	if (rate === null || rate <= 0) return CHUNK_INITIAL;
	return clampLength(rate * targetSeconds);
}

/** Merges `[start, end)` ranges, joining overlapping or touching ones. */
export function mergeRanges(ranges: ByteRange[]): ByteRange[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: ByteRange[] = [];
	for (const [s, e] of sorted) {
		const last = out[out.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	}
	return out;
}

/** The parts of `[0, total)` that `covered` does not reach. */
export function uncoveredRanges(
	covered: ByteRange[],
	total: number,
): ByteRange[] {
	const gaps: ByteRange[] = [];
	let cursor = 0;
	for (const [s, e] of mergeRanges(covered)) {
		if (s > cursor) gaps.push([cursor, Math.min(s, total)]);
		cursor = Math.max(cursor, e);
	}
	if (cursor < total) gaps.push([cursor, total]);
	return gaps;
}

export function coveredBytes(covered: ByteRange[]): number {
	return mergeRanges(covered).reduce((sum, [s, e]) => sum + (e - s), 0);
}

export interface PlannedChunk {
	offset: number;
	length: number;
}

/**
 * Hands out the byte ranges still missing from a file, each about `want` long.
 *
 * A gap's remainder shorter than the server's minimum is widened over bytes
 * already held (the bytes are identical, so the rewrite is harmless) unless it
 * is the file's tail, which is the one place the server accepts a short chunk.
 * Hand-outs advance a cursor, so two chunks never claim the same gap bytes.
 */
export class RangeQueue {
	private readonly gaps: ByteRange[];
	private readonly total: number;

	constructor(total: number, covered: ByteRange[]) {
		this.total = total;
		this.gaps = uncoveredRanges(covered, total);
	}

	/** True once every missing byte has been handed out (not yet necessarily sent). */
	get exhausted(): boolean {
		return this.gaps.every(([start, end]) => start >= end);
	}

	take(want: number): PlannedChunk | null {
		while (this.gaps.length) {
			const gap = this.gaps[0];
			if (!gap) break;
			const [start, end] = gap;
			if (start >= end) {
				this.gaps.shift();
				continue;
			}
			let length = Math.min(clampLength(want), end - start);
			if (length < CHUNK_MIN) length = Math.min(CHUNK_MIN, this.total - start);
			gap[0] = start + length;
			return { offset: start, length };
		}
		return null;
	}
}
