/**
 * Small guards that are easy to lose: expired rows get pruned without ever
 * changing what a client sees, a CSRF mismatch is a 403, and a zip member can't
 * be named `..`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UserRow } from "../src/db/rows.ts";
import { safeArcname } from "../src/storage/zip.ts";
import { type Harness, makeHarness, makeUser } from "./harness.ts";

let h: Harness;
let user: UserRow;

beforeAll(async () => {
	h = await makeHarness();
	user = await makeUser(h.db, "hygiene");
});
afterAll(() => h.close());

describe("session prune", () => {
	test("removes only expired rows and leaves live sessions untouched", async () => {
		const live = h.signIn(user);
		const dead = h.signIn(user);
		const deadSid = dead.cookie.slice("fu_session=".length).split(".")[0]!;
		h.db.run(
			"UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $id",
			{
				$id: deadSid,
			},
		);
		expect(h.state.sessionManager.pruneExpired(h.db)).toBe(1);
		const me = await h.request("/api/account/me", { cookie: live.cookie });
		expect(me.status).toBe(200);
		const gone = await h.request("/api/account/me", { cookie: dead.cookie });
		expect(gone.status).toBe(401);
	});

	test("stale lockout counters are dropped, active locks kept", () => {
		h.state.lockout.recordFailure(h.db, "old-user", "username");
		h.db.run(
			"UPDATE login_attempts SET updated_at = '2000-01-01T00:00:00.000Z' WHERE identifier = 'old-user'",
		);
		for (let i = 0; i < 5; i++) {
			h.state.lockout.recordFailure(h.db, "locked-user", "username");
		}
		expect(h.state.lockout.pruneStale(h.db)).toBe(1);
		expect(
			h.state.lockout.isIdentifierLocked(h.db, "locked-user", "username"),
		).toBe(true);
	});
});

describe("CSRF", () => {
	test("a wrong token is refused, a missing one too", async () => {
		const { cookie, csrf } = h.signIn(user);
		const attempt = (token?: string) =>
			h.request("/api/auth/logout", { method: "POST", cookie, csrf: token });
		expect((await attempt()).status).toBe(403);
		expect((await attempt(`${csrf.slice(0, -1)}x`)).status).toBe(403);
		expect((await attempt(csrf)).status).toBe(200);
	});
});

describe("safeArcname", () => {
	test("never emits a traversal segment", () => {
		const seen = new Set<string>();
		expect(safeArcname("..", seen)).toBe("file");
		expect(safeArcname(".", seen)).toBe("file (1)");
		expect(safeArcname("../../etc/passwd", seen)).toBe("passwd");
	});
});
