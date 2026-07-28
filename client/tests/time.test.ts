import { describe, expect, test } from "bun:test";
import { formatDate, formatDateTime, parseDuration } from "../src/lib/time";

describe("parseDuration", () => {
	test("parses units", () => {
		expect(parseDuration("90s")).toBe(90);
		expect(parseDuration("30m")).toBe(1800);
		expect(parseDuration("24h")).toBe(86400);
		expect(parseDuration("7d")).toBe(604800);
		expect(parseDuration("1w")).toBe(604800);
	});
	test("bare number defaults to seconds", () => {
		expect(parseDuration("45")).toBe(45);
	});
	test("accepts decimals and whitespace", () => {
		expect(parseDuration(" 1.5h ")).toBe(5400);
	});
	test("rejects junk", () => {
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("abc")).toBeNull();
		expect(parseDuration("10x")).toBeNull();
	});
});

describe("date formatters", () => {
	test("null/invalid render as dash", () => {
		expect(formatDate(null)).toBe("—");
		expect(formatDateTime(undefined)).toBe("—");
		expect(formatDate("not-a-date")).toBe("—");
	});
	test("valid ISO renders something", () => {
		expect(formatDate("2026-06-27T12:00:00Z")).not.toBe("—");
	});
});
