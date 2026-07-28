import { describe, expect, test } from "bun:test";
import { formatBytes, percent } from "../src/lib/bytes";

describe("formatBytes", () => {
	test("handles zero / negative / non-finite", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-5)).toBe("0 B");
		expect(formatBytes(NaN)).toBe("0 B");
	});
	test("scales units", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
	});
	test("bytes have no decimals", () => {
		expect(formatBytes(900)).toBe("900 B");
	});
});

describe("percent", () => {
	test("clamps to [0,100]", () => {
		expect(percent(0, 100)).toBe(0);
		expect(percent(50, 100)).toBe(50);
		expect(percent(150, 100)).toBe(100);
	});
	test("guards zero/invalid totals", () => {
		expect(percent(5, 0)).toBe(0);
		expect(percent(5, -1)).toBe(0);
	});
});
