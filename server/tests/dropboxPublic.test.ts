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

describe("persistent password-guarded dropboxes", () => {
	test("reusable, password gated, tracked, many at once", async () => {
		const h = await makeHarness();
		const owner = await makeUser(h.db, "owner");
		const { cookie, csrf } = h.signIn(owner);
		const json = { "content-type": "application/json" };
		const create = (body: unknown) =>
			h.request("/api/dropbox-links", {
				method: "POST",
				cookie,
				csrf,
				headers: json,
				body: JSON.stringify(body),
			});

		// refuses a persistent box with no password
		expect((await create({ unlimited: true })).status).toBe(400);
		expect((await create({ unlimited: true, password: "short" })).status).toBe(
			400,
		);

		const a = (await (
			await create({ unlimited: true, name: "A", password: "hunter2hunter2" })
		).json()) as { token: string; id: number };
		const b = (await (
			await create({ unlimited: true, name: "B", password: "hunter2hunter2" })
		).json()) as { token: string; id: number };

		const info = (await (
			await h.request(`/api/dropbox/${a.token}`)
		).json()) as {
			password_required: boolean;
			expires_at: string | null;
		};
		expect(info.password_required).toBe(true);
		expect(info.expires_at).toBeNull();

		const send = (token: string, pw?: string) => {
			const fd = new FormData();
			fd.append("file", new Blob(["hello"]), "hi.txt");
			fd.append("original_filename", "hi.txt");
			return h.request(`/api/dropbox/${token}/upload`, {
				method: "POST",
				body: fd,
				headers: pw ? { "x-dropbox-password": pw } : {},
			});
		};
		expect((await send(a.token)).status).toBe(403);
		expect((await send(a.token, "wrong-password")).status).toBe(403);
		expect((await send(a.token, "hunter2hunter2")).status).toBe(200);
		// not spent by the first upload, and a second box is independent
		expect((await send(a.token, "hunter2hunter2")).status).toBe(200);
		expect((await send(b.token, "hunter2hunter2")).status).toBe(200);

		const list = (await (
			await h.request("/api/dropbox-links", { cookie })
		).json()) as {
			id: number;
			upload_count: number;
			bytes_received: number;
			url: string | null;
		}[];
		expect(list.find((l) => l.id === a.id)?.upload_count).toBe(2);
		expect(list.find((l) => l.id === b.id)?.upload_count).toBe(1);
		expect(list.find((l) => l.id === a.id)?.url).toContain(a.token);

		const log = (await (
			await h.request(`/api/dropbox-links/${a.id}/uploads`, { cookie })
		).json()) as unknown[];
		expect(log.length).toBe(2);

		// pausing closes it; resuming reopens it
		const patch = (body: unknown) =>
			h.request(`/api/dropbox-links/${a.id}`, {
				method: "PATCH",
				cookie,
				csrf,
				headers: json,
				body: JSON.stringify(body),
			});
		await patch({ active: false });
		expect((await send(a.token, "hunter2hunter2")).status).toBe(410);
		await patch({ active: true });
		expect((await send(a.token, "hunter2hunter2")).status).toBe(200);
		expect((await patch({ password: null })).status).toBe(400);

		const del = await h.request(`/api/dropbox-links/by-id/${a.id}`, {
			method: "DELETE",
			cookie,
			csrf,
		});
		expect(del.status).toBe(200);
		expect((await h.request(`/api/dropbox/${a.token}`)).status).toBe(404);
		h.close();
	});
});
