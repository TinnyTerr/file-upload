import { describe, expect, test } from "bun:test";
import {
	base64UrlToBytes,
	bytesToBase64Url,
	randomKey,
} from "../src/lib/base64url";

describe("base64url", () => {
	test("round-trips arbitrary bytes", () => {
		for (const len of [0, 1, 2, 3, 16, 31, 32, 100]) {
			const bytes = new Uint8Array(len).map((_, i) => (i * 37) % 256);
			const encoded = bytesToBase64Url(bytes);
			expect(base64UrlToBytes(encoded)).toEqual(bytes);
		}
	});

	test("is URL-safe and unpadded", () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
		const encoded = bytesToBase64Url(bytes);
		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
		expect(encoded).not.toContain("=");
	});

	test("decodes a known vector", () => {
		// "hello" => base64 aGVsbG8= => base64url aGVsbG8
		expect(bytesToBase64Url(new TextEncoder().encode("hello"))).toBe("aGVsbG8");
		expect(new TextDecoder().decode(base64UrlToBytes("aGVsbG8"))).toBe("hello");
	});

	test("randomKey returns 32 distinct-ish bytes", () => {
		const a = randomKey();
		const b = randomKey();
		expect(a.length).toBe(32);
		expect(b.length).toBe(32);
		expect(a).not.toEqual(b);
	});
});
