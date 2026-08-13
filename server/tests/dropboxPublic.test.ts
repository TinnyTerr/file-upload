import { describe, expect, test } from "bun:test";
import { makeHarness, makeUser } from "./harness.ts";

describe("dropbox receive links are anonymous", () => {
	test("info + upload need no session", async () => {
		const h = await makeHarness();
		const owner = await makeUser(h.db, "owner");
		const { cookie, csrf } = h.signIn(owner);

		const created = await h.request("/api/dropbox-links", {
			method: "POST",
			cookie,
			csrf,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expires_in_seconds: 3600 }),
		});
		expect(created.status).toBe(200);
		const link = (await created.json()) as { token: string; url: string };
		console.log("url:", link.url);

		// anonymous: no cookie, no csrf
		const info = await h.request(`/api/dropbox/${link.token}`);
		console.log("info", info.status, await info.text());
		expect(info.status).toBe(200);

		const fd = new FormData();
		fd.append("file", new Blob(["hello world"]), "hello.txt");
		fd.append("original_filename", "hello.txt");
		const up = await h.request(`/api/dropbox/${link.token}/upload`, {
			method: "POST",
			body: fd,
		});
		console.log("upload", up.status, await up.text());
		expect(up.status).toBe(200);

		h.close();
	});
});
