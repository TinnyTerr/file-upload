/**
 * Bulk admin actions are gated by a permission flag, but the flags they name
 * for archiving and link cleanup are ordinary default-on user capabilities.
 * A non-master holding just `can_view_admin` must not be able to reach other
 * users' rows through them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UserRow } from "../src/db/rows.ts";
import { type Harness, makeFile, makeHarness, makeUser } from "./harness.ts";

let h: Harness;
let viewer: UserRow;
let other: UserRow;
let auth: { cookie: string; csrf: string };

beforeAll(async () => {
	h = await makeHarness();
	viewer = await makeUser(h.db, "viewer");
	other = await makeUser(h.db, "other");
	h.db.run("UPDATE permissions SET can_view_admin = 1 WHERE user_id = $id", {
		$id: viewer.id,
	});
	makeFile(h.db, { ownerId: viewer.id, name: "mine.txt" });
	makeFile(h.db, { ownerId: other.id, name: "theirs-1.txt" });
	makeFile(h.db, { ownerId: other.id, name: "theirs-2.txt" });
	auth = h.signIn(viewer);
});
afterAll(() => h.close());

async function preview(body: unknown): Promise<Response> {
	return h.request("/api/admin/bulk/preview", {
		method: "POST",
		cookie: auth.cookie,
		csrf: auth.csrf,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("bulk action owner scoping", () => {
	test("a non-master without can_manage_storage only sees their own rows", async () => {
		const res = await preview({ action: "archive_files" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { affected_count: number };
		expect(body.affected_count).toBe(1);
	});

	test("naming another owner is refused", async () => {
		const res = await preview({ action: "archive_files", owner_id: other.id });
		expect(res.status).toBe(403);
	});

	test("system-wide cleanup jobs are refused", async () => {
		expect((await preview({ action: "run_cleanup_jobs" })).status).toBe(403);
	});

	test("can_manage_storage restores the system-wide reach", async () => {
		h.db.run(
			"UPDATE permissions SET can_manage_storage = 1 WHERE user_id = $id",
			{ $id: viewer.id },
		);
		const res = await preview({ action: "archive_files" });
		const body = (await res.json()) as { affected_count: number };
		expect(body.affected_count).toBe(3);
	});
});
