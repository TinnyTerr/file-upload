import { describe, expect, test } from "bun:test";
import { isSecretRoute, scrubUrl } from "../src/lib/scrubUrl";

describe("scrubUrl", () => {
	test("redacts slugs, tokens, secret params and the fragment", () => {
		expect(scrubUrl("https://h/file/AbC123?ek=x#ek=key")).toBe(
			"https://h/file/:slug?ek=[redacted]",
		);
		expect(scrubUrl("/api/d/Zz9/info?dir=3&k=abc")).toBe(
			"/api/d/:slug/info?dir=3&k=[redacted]",
		);
		expect(scrubUrl("/api/dropbox/tok/upload")).toBe(
			"/api/dropbox/:token/upload",
		);
	});
	test("leaves ordinary routes alone", () => {
		expect(scrubUrl("/files/12?sort=name")).toBe("/files/12?sort=name");
	});
});

describe("isSecretRoute", () => {
	test("share pages and dropbox receive links", () => {
		expect(isSecretRoute("/file/abc", "")).toBe(true);
		expect(isSecretRoute("/d/abc", "")).toBe(true);
		expect(isSecretRoute("/", "?receive=tok")).toBe(true);
		expect(isSecretRoute("/files", "")).toBe(false);
	});
});
