/**
 * Dropbox upload paths.
 *
 * Every backend route lives under /api/*, and the SPA fallback in app.ts is
 * GET-only — so a POST to a bare path doesn't reach the SPA *or* a route, it
 * falls through to Express's default 404 ("Cannot POST /dropbox/…/upload").
 * That is exactly the bug this pins: the single-shot upload uses XHR rather
 * than the shared api client, so it has to apply the prefix itself.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	},
});

const { apiPath } = await import("../src/config/api");
const { dropboxService } = await import(
	"../src/features/dropbox/services/dropboxService"
);

interface OpenCall {
	method: string;
	url: string;
}
let opened: OpenCall[] = [];
const realXHR = globalThis.XMLHttpRequest;

class FakeXHR {
	status = 200;
	responseText = '{"file_id":1,"slug":"abc"}';
	upload = { onprogress: null as unknown };
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	open(method: string, url: string) {
		opened.push({ method, url });
	}
	send() {
		this.onload?.();
	}
}

beforeEach(() => {
	opened = [];
	globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
	globalThis.XMLHttpRequest = realXHR;
});

test("the single-shot upload posts under /api, not a bare path", async () => {
	const file = new File(["hello"], "hello.txt", { type: "text/plain" });
	await dropboxService.upload("tok123", file, "hello.txt");

	expect(opened).toHaveLength(1);
	expect(opened[0]?.method).toBe("POST");
	expect(opened[0]?.url).toBe("/api/dropbox/tok123/upload");
	// The precise regression: a bare path 404s, because the SPA fallback only
	// catches GET.
	expect(opened[0]?.url.startsWith("/api/")).toBe(true);
});

test("the token is URL-encoded into the path", async () => {
	const file = new File(["hi"], "a.txt");
	await dropboxService.upload("tok/../evil", file, "a.txt");
	expect(opened[0]?.url).toBe("/api/dropbox/tok%2F..%2Fevil/upload");
});

test("apiPath is idempotent, so double-prefixing is impossible", () => {
	expect(apiPath("/dropbox/x/upload")).toBe("/api/dropbox/x/upload");
	expect(apiPath("/api/dropbox/x/upload")).toBe("/api/dropbox/x/upload");
});

test("no request in the client bypasses the /api prefix", () => {
	// A cheap guard against the same mistake reappearing anywhere else: any
	// hand-rolled XHR/fetch must route its path through apiPath.
	for (const path of [
		"src/features/dropbox/services/dropboxService.ts",
		"src/features/files/services/filesService.ts",
	]) {
		// Resolved against this file: a bare `bun test` from the repo root runs
		// these with the wrong cwd.
		const source = readFileSync(resolve(import.meta.dir, "..", path), "utf8");
		for (const [, url] of source.matchAll(
			/\.open\(\s*"[A-Z]+"\s*,\s*([^)]+)\)/g,
		)) {
			expect(url).toContain("apiPath");
		}
	}
});
