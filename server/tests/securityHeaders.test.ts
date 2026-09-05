/**
 * Two policies, never mixed up: the page CSP for the SPA and its API, and the
 * sandbox CSP for responses whose body is uploaded bytes. A `/preview` served
 * under the page policy is `script-src 'self'` on an attacker-supplied body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nowIso, type UserRow } from "../src/db/rows.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

const storageDir = mkdtempSync(join(tmpdir(), "fu-headers-"));
let h: Harness;
let owner: UserRow;

beforeAll(async () => {
	process.env.FILEUPLOAD_STORAGE = storageDir;
	h = await makeHarness();
	owner = await makeUser(h.db, "header");
});
afterAll(() => {
	h.close();
	delete process.env.FILEUPLOAD_STORAGE;
	rmSync(storageDir, { recursive: true, force: true });
});

/** A plaintext text file on disk plus an unlimited link, so /preview serves it. */
function makeSharedText(name: string): string {
	const rel = `ab/cd/${randomBytes(8).toString("hex")}`;
	const full = join(storageDir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, "hello");
	h.db.run(
		`INSERT INTO files (owner_id, storage_path, original_filename, source_type,
       size_bytes, stored_size_bytes, content_type, encryption_mode,
       encryption_overridden, created_at)
     VALUES ($owner, $path, $name, 'upload', 5, 5, 'text/plain', 'none', 1, $now)`,
		{ $owner: owner.id, $path: rel, $name: name, $now: nowIso() },
	);
	const fileId = h.db.get<{ id: number }>(
		"SELECT last_insert_rowid() AS id",
	)!.id;
	const slug = randomBytes(8).toString("base64url");
	h.db.run(
		`INSERT INTO links (file_id, slug, max_uses, use_count, active, created_at)
     VALUES ($file, $slug, NULL, 0, 1, $now)`,
		{ $file: fileId, $slug: slug, $now: nowIso() },
	);
	return slug;
}

describe("security headers", () => {
	test("API responses carry the page policy", async () => {
		const res = await h.request("/api/health");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain("sandbox");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("permissions-policy")).toContain("camera=()");
		expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
	});

	test("uploaded bytes go out sandboxed, inline, and frameable same-origin", async () => {
		const slug = makeSharedText('héllo "world".txt');
		const res = await h.request(`/api/file/${slug}/preview`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toBe(
			"default-src 'none'; sandbox; frame-ancestors 'self'",
		);
		// The download page's PDF preview is a same-origin iframe; DENY (the
		// page default) would refuse to render it.
		expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		const cd = res.headers.get("content-disposition") ?? "";
		expect(cd).toStartWith("inline; ");
		expect(cd).toContain(`filename*=UTF-8''h%C3%A9llo%20%22world%22.txt`);
		expect(await res.text()).toBe("hello");
	});

	test("raw downloads are attachments under the same sandbox", async () => {
		const slug = makeSharedText("plain.txt");
		const res = await h.request(`/api/file/${slug}/raw`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("content-disposition")).toStartWith("attachment; ");
	});
});
