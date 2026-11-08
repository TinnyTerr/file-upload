import { describe, expect, test } from "bun:test";
import {
	CHUNK_INITIAL,
	CHUNK_MAX,
	CHUNK_MIN,
	coveredBytes,
	foldRate,
	mergeRanges,
	nextChunkLength,
	RATE_SMOOTHING,
	RangeQueue,
	TARGET_CHUNK_SECONDS,
	uncoveredRanges,
} from "../src/features/files/lib/chunkPlanner";

const KIB = 1024;
const MIB = 1024 * 1024;

describe("nextChunkLength", () => {
	test("uses the initial size until a rate exists", () => {
		expect(nextChunkLength(null)).toBe(CHUNK_INITIAL);
		expect(nextChunkLength(0)).toBe(CHUNK_INITIAL);
	});

	test("sizes a chunk to the target seconds at the measured rate", () => {
		// 200 KiB/s × 15 s = 3000 KiB, inside the bounds.
		expect(nextChunkLength(200 * KIB)).toBe(200 * KIB * TARGET_CHUNK_SECONDS);
	});

	test("clamps to the 50 KiB floor on a very slow link", () => {
		expect(nextChunkLength(1 * KIB)).toBe(CHUNK_MIN);
	});

	test("clamps to the 70 MiB ceiling on a very fast link", () => {
		expect(nextChunkLength(100 * MIB)).toBe(CHUNK_MAX);
	});
});

describe("foldRate", () => {
	test("takes the first observation as-is", () => {
		expect(foldRate(null, { bytes: 1000, seconds: 2 })).toBe(500);
	});

	test("weights the newest chunk by RATE_SMOOTHING", () => {
		const prev = 100;
		const next = foldRate(prev, { bytes: 300, seconds: 1 }); // observed 300
		expect(next).toBeCloseTo(RATE_SMOOTHING * 300 + (1 - RATE_SMOOTHING) * 100);
	});

	test("a zero-duration sample reads as zero, not infinity", () => {
		expect(foldRate(null, { bytes: 1000, seconds: 0 })).toBe(0);
	});
});

describe("range helpers", () => {
	test("mergeRanges joins overlapping and touching ranges", () => {
		expect(
			mergeRanges([
				[50, 100],
				[0, 60],
				[100, 150],
				[200, 210],
			]),
		).toEqual([
			[0, 150],
			[200, 210],
		]);
	});

	test("uncoveredRanges returns the holes in [0, total)", () => {
		expect(
			uncoveredRanges(
				[
					[10, 20],
					[30, 40],
				],
				50,
			),
		).toEqual([
			[0, 10],
			[20, 30],
			[40, 50],
		]);
		expect(uncoveredRanges([[0, 50]], 50)).toEqual([]);
	});

	test("coveredBytes counts overlaps once", () => {
		expect(
			coveredBytes([
				[0, 100],
				[50, 120],
			]),
		).toBe(120);
	});
});

describe("RangeQueue", () => {
	test("hands out the whole file exactly once with no overlap", () => {
		const total = 300 * KIB;
		const q = new RangeQueue(total, []);
		const seen: Array<[number, number]> = [];
		let want = 60 * KIB;
		for (let next = q.take(want); next; next = q.take(want)) {
			seen.push([next.offset, next.offset + next.length]);
			want += 10 * KIB; // a growing size, as a speeding-up link would give
		}
		expect(mergeRanges(seen)).toEqual([[0, total]]);
		// No two handed-out ranges overlap.
		const sorted = [...seen].sort((a, b) => a[0] - b[0]);
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i]?.[0]).toBeGreaterThanOrEqual(sorted[i - 1]?.[1] ?? 0);
		}
		expect(q.exhausted).toBe(true);
	});

	test("skips bytes already covered on resume", () => {
		const total = 200 * KIB;
		const q = new RangeQueue(total, [[0, 100 * KIB]]);
		const first = q.take(MIB);
		expect(first?.offset).toBe(100 * KIB);
	});

	test("widens a short gap remainder over held bytes, unless it is the tail", () => {
		const total = 200 * KIB;
		// Only 10 KiB missing in the middle: the chunk widens to the minimum.
		const mid = new RangeQueue(total, [
			[0, 50 * KIB],
			[60 * KIB, total],
		]);
		const widened = mid.take(MIB);
		expect(widened).toEqual({ offset: 50 * KIB, length: CHUNK_MIN });

		// The same short remainder at the file's end stays short: the tail is the
		// one chunk the server accepts below the minimum.
		const tail = new RangeQueue(total, [[0, total - 10 * KIB]]);
		expect(tail.take(MIB)).toEqual({
			offset: total - 10 * KIB,
			length: 10 * KIB,
		});
	});
});
