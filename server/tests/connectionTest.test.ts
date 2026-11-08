/**
 * Admin "Connection" debug endpoints: they move real bytes over the proxy path
 * and must stay master-only, and the upload sink must refuse a body that
 * doesn't match its declared length.
 */

import { describe, expect, test } from "bun:test";
import { makeHarness, makeUser } from "./harness.ts";

describe("admin connection-test endpoints", () => {
	test("download streams exactly the requested bytes to the master", async () => {
		const h = await makeHarness();
		const master = await makeUser(h.db, "boss", "master");
		const auth = h.signIn(master);

		const res = await h.request(
			"/api/admin/connection-test/download?bytes=100000",
			{
				method: "GET",
				...auth,
			},
		);
		expect(res.status).toBe(200);
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body.byteLength).toBe(100000);
		expect(res.headers.get("cache-control")).toBe("no-store");

		h.close();
	});

	test("download and upload are refused to a non-master user", async () => {
		const h = await makeHarness();
		const user = await makeUser(h.db, "plain", "user");
		const auth = h.signIn(user);

		const dl = await h.request(
			"/api/admin/connection-test/download?bytes=1000",
			{
				method: "GET",
				...auth,
			},
		);
		expect(dl.status).toBe(403);

		const up = await h.request("/api/admin/connection-test/chunk?length=4", {
			method: "POST",
			...auth,
			headers: { "content-type": "application/octet-stream" },
			body: new Uint8Array(4),
		});
		expect(up.status).toBe(403);

		h.close();
	});

	test("upload sink reports the bytes it received and checks the declared length", async () => {
		const h = await makeHarness();
		const master = await makeUser(h.db, "boss2", "master");
		const auth = h.signIn(master);

		const ok = await h.request("/api/admin/connection-test/chunk?length=5000", {
			method: "POST",
			...auth,
			headers: { "content-type": "application/octet-stream" },
			body: new Uint8Array(5000),
		});
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ received: 5000 });

		const bad = await h.request("/api/admin/connection-test/chunk?length=0", {
			method: "POST",
			...auth,
			headers: { "content-type": "application/octet-stream" },
			body: new Uint8Array(0),
		});
		expect(bad.status).toBe(400);

		const short = await h.request(
			"/api/admin/connection-test/chunk?length=5000",
			{
				method: "POST",
				...auth,
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(4000),
			},
		);
		expect(short.status).toBe(400);

		h.close();
	});
});
