/**
 * SPA serving: which requests get the built shell, which get an HTML error
 * page, and which get JSON. The distinction matters because the fallback used
 * to answer *every* non-/api path with index.html and a 200 -- a missing chunk
 * then arrived at the browser as a page of HTML with a script content type.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spaAvailable } from "../src/spa.ts";
import { type Harness, makeHarness } from "./harness.ts";

const HTML = { accept: "text/html,application/xhtml+xml" };
const JSON_ONLY = { accept: "application/json" };

let h: Harness;

beforeAll(async () => {
	h = await makeHarness();
});
afterAll(() => h.close());

describe("SPA serving", () => {
	test("a client-side route gets HTML, not JSON", async () => {
		const res = await h.request("/files/12", { headers: HTML });
		expect(res.headers.get("content-type")).toStartWith("text/html");
		// 503 (with the "not built" page) when the client hasn't been built,
		// which is how CI runs the server suite.
		expect(res.status).toBe(spaAvailable() ? 200 : 503);
		if (spaAvailable()) {
			expect(res.headers.get("cache-control")).toBe("no-cache");
			expect(await res.text()).toContain('id="root"');
		}
	});

	test("a missing asset 404s instead of being handed the shell", async () => {
		const res = await h.request("/assets/index-deadbeef.js", { headers: HTML });
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toStartWith("text/html");
	});

	test("a non-browser client gets JSON for an unknown page path", async () => {
		const res = await h.request("/files", { headers: JSON_ONLY });
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toStartWith("application/json");
		expect(await res.json()).toHaveProperty("detail");
	});

	test("an unknown /api path is a JSON 404, never a page", async () => {
		const res = await h.request("/api/nope/not/a/route", { headers: HTML });
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toStartWith("application/json");
		expect(await res.json()).toEqual({ detail: "not found" });
	});

	test("a non-GET request to a page path is a 404, not the shell", async () => {
		const res = await h.request("/files", { method: "POST", headers: HTML });
		expect(res.status).toBe(404);
	});

	test("the health check still answers", async () => {
		const res = await h.request("/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});
