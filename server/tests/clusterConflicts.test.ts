/**
 * Conflict arbitration (redesign Phase 6, §5.8 — D2, D-8).
 *
 * Two nodes can both accept an edit to the same row: nothing but quota is
 * gated on the write path, and a rename costs no quota. What Phase 6 adds is
 * that the master decides which edit stands, by a rule that is evaluated once
 * and is total, and that the edit which lost is *recorded* rather than
 * silently dropped — which is the whole difference from the "whoever pushed
 * last wins" this replaces.
 */

import { describe, expect, test } from "bun:test";
import { readChanges } from "../src/cluster/changelog.ts";
import {
	CLOCK_SKEW_MS,
	comparableTs,
	listConflicts,
	winnerOf,
} from "../src/cluster/conflicts.ts";
import { replicationPullJob } from "../src/cluster/replication.ts";
import type { ReplicationConflictRow } from "../src/db/rows.ts";
import { type ClusterHarness, makeCluster } from "./clusterHarness.ts";
import { makeDirectory, makeUser } from "./harness.ts";

const OLD_TS = "2020-01-01T00:00:00.000Z";

/** Rewrite the timestamp of a node's newest log entry, so a test can say which
 * edit came first without racing a millisecond clock. */
function backdateLatestEntry(db: ClusterHarness["nodes"][number]["db"]): void {
	db.run(
		"UPDATE replication_log SET ts = $ts WHERE seq = (SELECT MAX(seq) FROM replication_log)",
		{ $ts: OLD_TS },
	);
}

/** A directory replicated to both nodes, with both holding the master's
 * ordering for it — the precondition for a conflict to be possible at all. */
async function sharedDirectory(c: ClusterHarness): Promise<{ uid: string }> {
	const [master, follower] = c.nodes;
	const owner = await makeUser(master!.db, "owner");
	makeDirectory(master!.db, { ownerId: owner.id, title: "original" });
	await replicationPullJob(follower!.state);
	const uid = follower!.db.get<{ uid: string }>(
		"SELECT uid FROM directories",
	)!.uid;
	return { uid };
}

const renameOn = (
	node: ClusterHarness["nodes"][number],
	uid: string,
	title: string,
) =>
	node.db.run("UPDATE directories SET title = $title WHERE uid = $uid", {
		$title: title,
		$uid: uid,
	});

const titleOn = (node: ClusterHarness["nodes"][number]) =>
	node.db.get<{ title: string }>("SELECT title FROM directories")?.title;

describe("the arbitration rule", () => {
	test("later timestamp wins", () => {
		expect(
			winnerOf(
				{ ts: "2026-01-01T00:00:00.000Z", origin_node: "z" },
				{ ts: "2026-01-01T00:00:01.000Z", origin_node: "a" },
			),
		).toBe("incoming");
		expect(
			winnerOf(
				{ ts: "2026-01-01T00:00:01.000Z", origin_node: "a" },
				{ ts: "2026-01-01T00:00:00.000Z", origin_node: "z" },
			),
		).toBe("committed");
	});

	test("a tie is broken by node id, and is never undefined", () => {
		const ts = "2026-01-01T00:00:00.000Z";
		expect(winnerOf({ ts, origin_node: "a" }, { ts, origin_node: "b" })).toBe(
			"incoming",
		);
		expect(winnerOf({ ts, origin_node: "b" }, { ts, origin_node: "a" })).toBe(
			"committed",
		);
		// Same node, same instant: the rule still answers rather than throwing.
		expect(winnerOf({ ts, origin_node: "a" }, { ts, origin_node: "a" })).toBe(
			"committed",
		);
	});

	test("a clock running fast is clamped to receipt time", () => {
		const now = "2026-01-01T00:00:00.000Z";
		const ahead = new Date(Date.parse(now) + CLOCK_SKEW_MS * 10).toISOString();
		expect(comparableTs(ahead, now)).toBe(now);
		// Inside the allowance the entry is taken at its word.
		const slightly = new Date(Date.parse(now) + 1000).toISOString();
		expect(comparableTs(slightly, now)).toBe(slightly);
		// A clock running *slow* is not clamped: it only ever loses by it.
		expect(comparableTs(OLD_TS, now)).toBe(OLD_TS);
	});
});

describe("arbitration on the master", () => {
	test("an edit based on the current version is not a conflict", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);

			renameOn(follower!, uid, "renamed-on-follower");
			await replicationPullJob(master!.state);

			expect(titleOn(master!)).toBe("renamed-on-follower");
			expect(listConflicts(master!.db)).toHaveLength(0);
		} finally {
			c.close();
		}
	});

	test("a stale edit loses, and the master restates the winner so the loser converges", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);

			// Concurrent: both edit the version they hold. The follower's is older,
			// so the master's committed edit stands.
			renameOn(follower!, uid, "from-follower");
			backdateLatestEntry(follower!.db);
			renameOn(master!, uid, "from-master");

			await replicationPullJob(master!.state);

			expect(titleOn(master!)).toBe("from-master");
			const conflicts = listConflicts(master!.db);
			expect(conflicts).toHaveLength(1);
			const conflict = conflicts[0] as ReplicationConflictRow;
			expect(conflict.table_name).toBe("directories");
			expect(conflict.row_uid).toBe(uid);
			expect(conflict.origin_node).toBe("node-b");
			expect(conflict.winner_node).toBe("node-a");
			expect(JSON.parse(conflict.losing_payload).title).toBe("from-follower");

			// The losing entry never entered the master's log, so it cannot ship
			// down and overwrite the winner...
			expect(
				readChanges(master!.db, { limit: 500 }).some(
					(e) =>
						e.origin_node === "node-b" && e.payload?.title === "from-follower",
				),
			).toBe(false);
			// ...and the restatement is what carries the winner back to the node
			// that lost.
			await replicationPullJob(follower!.state);
			expect(titleOn(follower!)).toBe("from-master");
		} finally {
			c.close();
		}
	});

	test("the later edit wins, and the edit it displaced is recorded", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);

			// This time the master's own edit is the older one.
			renameOn(master!, uid, "from-master");
			backdateLatestEntry(master!.db);
			renameOn(follower!, uid, "from-follower");

			await replicationPullJob(master!.state);

			expect(titleOn(master!)).toBe("from-follower");
			const conflicts = listConflicts(master!.db);
			expect(conflicts).toHaveLength(1);
			const conflict = conflicts[0] as ReplicationConflictRow;
			expect(conflict.origin_node).toBe("node-a");
			expect(conflict.winner_node).toBe("node-b");
			expect(JSON.parse(conflict.losing_payload).title).toBe("from-master");
			expect(conflict.winning_master_seq).toBeGreaterThan(0);
		} finally {
			c.close();
		}
	});

	test("a re-delivered loser is not recorded twice, and never overwrites the winner", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);

			renameOn(follower!, uid, "from-follower");
			backdateLatestEntry(follower!.db);
			renameOn(master!, uid, "from-master");
			await replicationPullJob(master!.state);
			expect(listConflicts(master!.db)).toHaveLength(1);
			const restatements = readChanges(master!.db, { limit: 500 }).length;

			// A cursor that slipped backwards re-delivers everything the follower
			// ever wrote.
			master!.db.run(
				"UPDATE replication_cursors SET seq = 0 WHERE peer_node_id = 'node-b'",
			);
			await replicationPullJob(master!.state);

			expect(titleOn(master!)).toBe("from-master");
			expect(listConflicts(master!.db)).toHaveLength(1);
			// No second restatement either -- the dedup is what stops the master
			// re-announcing the same winner on every redelivery.
			expect(readChanges(master!.db, { limit: 500 })).toHaveLength(
				restatements,
			);
		} finally {
			c.close();
		}
	});

	test("the panel lists them, dismisses them, and re-applies as a fresh edit", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);
			renameOn(follower!, uid, "from-follower");
			backdateLatestEntry(follower!.db);
			renameOn(master!, uid, "from-master");
			await replicationPullJob(master!.state);

			const admin = await makeUser(master!.db, "admin", "master");
			const session = master!.signIn(admin);
			const listed = await master!.request("/api/cluster/conflicts", {
				cookie: session.cookie,
			});
			expect(listed.status).toBe(200);
			const body = (await listed.json()) as {
				conflicts: ReplicationConflictRow[];
				open: number;
			};
			expect(body.open).toBe(1);
			const id = body.conflicts[0]!.id;

			// Re-apply is a *fresh edit on top of the winner*: the losing title is
			// written now, so it wins on its own merits rather than by replaying an
			// entry that already lost.
			const reapplied = await master!.request(
				`/api/cluster/conflicts/${id}/reapply`,
				{ method: "POST", cookie: session.cookie, csrf: session.csrf },
			);
			expect(reapplied.status).toBe(200);
			expect(titleOn(master!)).toBe("from-follower");
			await replicationPullJob(follower!.state);
			expect(titleOn(follower!)).toBe("from-follower");

			// Re-applying resolves it, so it drops off the open list...
			const after = (await (
				await master!.request("/api/cluster/conflicts", {
					cookie: session.cookie,
				})
			).json()) as { open: number };
			expect(after.open).toBe(0);
			// ...and dismissing an already-resolved one is a 404, not a silent ok.
			const dismissed = await master!.request(
				`/api/cluster/conflicts/${id}/dismiss`,
				{ method: "POST", cookie: session.cookie, csrf: session.csrf },
			);
			expect(dismissed.status).toBe(404);
		} finally {
			c.close();
		}
	});

	test("a follower's Conflicts view reads through to the master", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);
			renameOn(follower!, uid, "from-follower");
			backdateLatestEntry(follower!.db);
			renameOn(master!, uid, "from-master");
			await replicationPullJob(master!.state);

			const admin = await makeUser(follower!.db, "admin", "master");
			const session = follower!.signIn(admin);
			const res = await follower!.request("/api/cluster/conflicts", {
				cookie: session.cookie,
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				conflicts: ReplicationConflictRow[];
				node_id: string;
			};
			// The record came from the master, and says so.
			expect(body.node_id).toBe("node-a");
			expect(body.conflicts).toHaveLength(1);
			expect(body.conflicts[0]!.origin_node).toBe("node-b");
		} finally {
			c.close();
		}
	});

	test("a follower arbitrates nothing — it applies what the master ordered", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { uid } = await sharedDirectory(c);

			renameOn(follower!, uid, "from-follower");
			renameOn(master!, uid, "from-master");
			await replicationPullJob(master!.state);
			await replicationPullJob(follower!.state);

			// Whatever the master decided, both nodes hold it and only the master
			// holds a record of the decision.
			expect(titleOn(follower!)).toBe(titleOn(master!));
			expect(listConflicts(follower!.db)).toHaveLength(0);
		} finally {
			c.close();
		}
	});
});
