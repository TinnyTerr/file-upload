import { describe, expect, test } from "bun:test";
import { pageCsp } from "../src/middleware/securityHeaders.ts";
import { isTraced, scrubPath } from "../src/sentry.ts";

describe("sentry scrubbing", () => {
	test("share slugs, dropbox tokens and secret params never survive", () => {
		expect(scrubPath("/api/file/AbC123/raw?ek=hunter2&x=1")).toBe(
			"/api/file/:slug/raw?ek=[redacted]&x=1",
		);
		expect(scrubPath("https://h/d/Zz9#ek=secret")).toBe("https://h/d/:slug");
		expect(scrubPath("/api/dropbox/tok_en/upload")).toBe(
			"/api/dropbox/:token/upload",
		);
		expect(scrubPath("/?receive=abc")).toBe("/?receive=[redacted]");
	});

	test("noisy polling endpoints are not traced", () => {
		expect(isTraced("/api/health")).toBe(false);
		expect(isTraced("/assets/index-x.js")).toBe(false);
		expect(isTraced("/api/files/")).toBe(true);
	});
});

describe("page CSP", () => {
	test("admits the browser DSN origin only when one is given", () => {
		expect(pageCsp("")).toContain("connect-src 'self';");
		expect(pageCsp("https://o1.ingest.sentry.io")).toContain(
			"connect-src 'self' https://o1.ingest.sentry.io;",
		);
	});
});
