import { describe, expect, test } from "bun:test";
import {
	CHUNK_INITIAL,
	CHUNK_MAX,
	CHUNK_MIN,
	coveredBytes,
	foldRate,
	LIMIT_PRECISION,
	mergeRanges,
	nextChunkLength,
	penalizeRate,
	RATE_SMOOTHING,
	RangeQueue,
	retryLength,
	SizeLimit,
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

describe("failure handling", () => {
	test("penalizeRate halves an existing rate that is under the failed chunk's", () => {
		expect(penalizeRate(MIB / 10, 10 * MIB)).toBe(MIB / 20);
	});

	test("penalizeRate seeds from the failed chunk when there is no rate", () => {
		const r = penalizeRate(null, CHUNK_INITIAL);
		expect(r).toBe(CHUNK_INITIAL / TARGET_CHUNK_SECONDS / 2);
		expect(nextChunkLength(r)).toBeLessThan(CHUNK_INITIAL);
	});

	test("retryLength shrinks to the penalized size", () => {
		const r = penalizeRate(null, 60 * MIB);
		expect(retryLength(60 * MIB, r)).toBe(nextChunkLength(r));
	});

	test("retryLength keeps the chunk when the remainder would be under CHUNK_MIN", () => {
		expect(retryLength(CHUNK_MIN + 10, 1)).toBe(CHUNK_MIN + 10);
	});

	test("giveBack returns a range that is handed out again", () => {
		const q = new RangeQueue(10 * MIB, []);
		const a = q.take(4 * MIB);
		expect(a).toEqual({ offset: 0, length: 4 * MIB });
		q.giveBack(2 * MIB, 2 * MIB);
		expect(q.take(2 * MIB)).toEqual({ offset: 2 * MIB, length: 2 * MIB });
		expect(q.take(MIB)).toEqual({ offset: 4 * MIB, length: MIB });
	});
});

describe("oversized chunks", () => {
	// The reported case: rate climbed until chunks clamped at CHUNK_MAX, then a
	// proxy answered 413 and every retry went out at CHUNK_MAX again.
	const fastRate = 50 * MIB; // wants 750 MiB per chunk, clamped to 70

	test("penalizeRate always halves the failed chunk, even when the rate asks for far more", () => {
		const r = penalizeRate(fastRate, CHUNK_MAX);
		expect(nextChunkLength(r)).toBe(clampHalf(CHUNK_MAX));
	});

	test("a 413 caps the next chunk however fast the link is", () => {
		const limit = new SizeLimit();
		expect(limit.ceiling).toBeNull();
		limit.tooLarge(CHUNK_MAX);
		const ceiling = limit.ceiling as number;
		expect(ceiling).toBeLessThan(CHUNK_MAX);
		expect(nextChunkLength(fastRate, undefined, ceiling)).toBe(ceiling);
		expect(retryLength(CHUNK_MAX, fastRate, ceiling)).toBe(ceiling);
	});

	test("the cap probes halfway between what landed and what got a 413", () => {
		const limit = new SizeLimit();
		limit.landed(20 * MIB);
		limit.tooLarge(60 * MIB);
		expect(limit.ceiling).toBe(40 * MIB);
		limit.landed(40 * MIB);
		expect(limit.ceiling).toBe(50 * MIB);
		limit.tooLarge(50 * MIB);
		expect(limit.ceiling).toBe(45 * MIB);
	});

	test("converges on the real limit and then holds at the known-good size", () => {
		const real = 47 * MIB; // proxy rejects anything above this
		const limit = new SizeLimit();
		limit.tooLarge(CHUNK_MAX);
		for (let i = 0; i < 20 && !limit.settled; i++) {
			const c = limit.ceiling as number;
			if (c <= real) limit.landed(c);
			else limit.tooLarge(c);
		}
		expect(limit.settled).toBe(true);
		const held = limit.ceiling as number;
		expect(held).toBeLessThanOrEqual(real);
		expect(real - held).toBeLessThanOrEqual(LIMIT_PRECISION);
		limit.landed(held);
		expect(limit.ceiling).toBe(held);
	});

	test("a 413 under a size that landed restarts the search below it", () => {
		const limit = new SizeLimit();
		limit.landed(40 * MIB);
		limit.tooLarge(30 * MIB);
		expect(limit.good).toBeLessThan(30 * MIB);
		expect(limit.ceiling as number).toBeLessThan(30 * MIB);
	});

	test("the ceiling applies before any rate exists", () => {
		expect(nextChunkLength(null, undefined, 512 * KIB)).toBe(512 * KIB);
	});
});

function clampHalf(n: number) {
	return Math.round(n / 2);
}
