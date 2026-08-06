/**
 * Change-log replication between real nodes (redesign Phase 3, §5.7).
 *
 * Unlike clusterChangelog.test.ts, which hands entries from one database to
 * another in-process, everything here goes over HTTP through the actual
 * `/api/cluster/changes` endpoint with real cluster-token auth — so a pass
 * means the protocol works, not just the SQL under it.
 */

import { describe, expect, test } from "bun:test";
import { getCursor, logHead, readChanges } from "../src/cluster/changelog.ts";
import { pullTargets, replicationPullJob } from "../src/cluster/replication.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeDirectory, makeFile, makeUser } from "./harness.ts";

describe("GET /api/cluster/changes", () => {
	test("serves this node's log, ascending, and refuses an unauthenticated caller", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			const owner = await makeUser(c.master.db, "owner");
			makeDirectory(c.master.db, { ownerId: owner.id, title: "docs" });

			const res = await c.master.asPeer(
				"/api/cluster/changes?after=0&limit=10",
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				entries: Array<{ seq: number; table_name: string }>;
				last_seq: number;
				head: number;
			};
			expect(body.entries.map((e) => e.seq)).toEqual(
				[...body.entries.map((e) => e.seq)].sort((a, b) => a - b),
			);
			expect(body.last_seq).toBe(body.entries.at(-1)!.seq);
			expect(body.head).toBe(logHead(c.master.db));

			expect((await c.master.request("/api/cluster/changes")).status).toBe(401);
		} finally {
			c.close();
		}
	});

	test("pages from a cursor without stranding older entries", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const owner = await makeUser(c.master.db, "owner");
			for (let i = 0; i < 12; i++) {
				makeDirectory(c.master.db, { ownerId: owner.id, title: `d${i}` });
			}
			const seen: number[] = [];
			let cursor = 0;
			for (;;) {
				const res = await c.master.asPeer(
					`/api/cluster/changes?after=${cursor}&limit=5`,
				);
				const body = (await res.json()) as { entries: Array<{ seq: number }> };
				if (body.entries.length === 0) break;
				for (const e of body.entries) seen.push(e.seq);
				cursor = body.entries.at(-1)!.seq;
			}
			expect(seen).toEqual(
				readChanges(c.master.db, { limit: 1000 }).map((e) => e.seq),
			);
		} finally {
			c.close();
		}
	});
});

describe("pull topology", () => {
	test("the master pulls up from every peer; a follower pulls down from the master alone", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const [master, b, d] = c.nodes;

			const up = pullTargets(master!.state);
			expect(up.map((t) => t.direction)).toEqual(["up", "up"]);
			expect(up.map((t) => t.peer.nodeId).sort()).toEqual(["node-b", "node-c"]);

			// A follower does not pull from its sibling: b's writes reach d by
			// going up to the master and back down, which is what keeps the
			// master's log the canonical order.
			const down = pullTargets(b!.state);
			expect(down).toHaveLength(1);
			expect(down[0]!.direction).toBe("down");
			expect(down[0]!.peer.nodeId).toBe("node-a");
			expect(pullTargets(d!.state)[0]!.peer.nodeId).toBe("node-a");
		} finally {
			c.close();
		}
	});

	test("a follower that cannot resolve a master pulls from nobody", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			c.nodes[1]!.db.run(
				"UPDATE cluster_self_state SET current_master_id = NULL WHERE id = 1",
			);
			// Improvising a peer to sync from is how two halves of a partition
			// converge on different answers (D-2).
			expect(pullTargets(c.nodes[1]!.state)).toEqual([]);
		} finally {
			c.close();
		}
	});
});

describe("propagation", () => {
	test("a folder and file created on the master reach a follower", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const owner = await makeUser(master!.db, "owner");
			const dir = makeDirectory(master!.db, {
				ownerId: owner.id,
				title: "docs",
			});
			makeFile(master!.db, {
				ownerId: owner.id,
				name: "x.txt",
				directoryId: dir,
			});

			const outcomes = await replicationPullJob(follower!.state);
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]!.halted).toBeUndefined();
			expect(outcomes[0]!.applied).toBe(4); // user, permissions, folder, file

			expect(
				follower!.db.get<{ title: string }>("SELECT title FROM directories")!
					.title,
			).toBe("docs");
			expect(
				follower!.db.get<{ original_filename: string }>(
					"SELECT original_filename FROM files",
				)!.original_filename,
			).toBe("x.txt");
			expect(getCursor(follower!.db, "node-a", "down")).toBe(
				logHead(master!.db),
			);
		} finally {
			c.close();
		}
	});

	test("a rename and a delete propagate too, with no route handler involved", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const owner = await makeUser(master!.db, "owner");
			const dir = makeDirectory(master!.db, {
				ownerId: owner.id,
				title: "docs",
			});
			const file = makeFile(master!.db, {
				ownerId: owner.id,
				name: "x.txt",
				directoryId: dir,
			});
			await replicationPullJob(follower!.state);

			master!.db.run(
				"UPDATE directories SET title = 'renamed' WHERE id = $id",
				{ $id: dir },
			);
			master!.db.run("DELETE FROM files WHERE id = $id", { $id: file });
			await replicationPullJob(follower!.state);

			expect(
				follower!.db.get<{ title: string }>("SELECT title FROM directories")!
					.title,
			).toBe("renamed");
			expect(
				follower!.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM files")!.n,
			).toBe(0);
		} finally {
			c.close();
		}
	});

	test("a follower's write goes up, and comes back committed", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const owner = await makeUser(follower!.db, "owner");
			makeDirectory(follower!.db, {
				ownerId: owner.id,
				title: "from-follower",
			});

			// Provisional: written locally, not yet ordered by the master.
			const before = readChanges(follower!.db).at(-1)!;
			expect(before.master_seq).toBeNull();

			await replicationPullJob(master!.state);
			expect(
				master!.db.get<{ title: string }>("SELECT title FROM directories")!
					.title,
			).toBe("from-follower");
			// The master preserved who made the change across the hop.
			expect(
				readChanges(master!.db).every((e) => e.origin_node === "node-b"),
			).toBe(true);

			await replicationPullJob(follower!.state);
			const after = readChanges(follower!.db).find(
				(e) => e.origin_seq === before.origin_seq,
			)!;
			expect(after.master_seq).not.toBeNull();
		} finally {
			c.close();
		}
	});

	test("one follower's write reaches another through the master", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const [master, b, d] = c.nodes;
			const owner = await makeUser(b!.db, "owner");
			makeDirectory(b!.db, { ownerId: owner.id, title: "shared" });

			// d never talks to b. Two hops, one pull interval each (§5.7).
			await replicationPullJob(master!.state);
			await replicationPullJob(d!.state);

			expect(
				d!.db.get<{ title: string }>("SELECT title FROM directories")!.title,
			).toBe("shared");
			expect(
				d!.db.get<{ username: string }>("SELECT username FROM users")!.username,
			).toBe("owner");
		} finally {
			c.close();
		}
	});

	test("an unreachable peer leaves the cursor where it was", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const owner = await makeUser(master!.db, "owner");
			makeDirectory(master!.db, { ownerId: owner.id, title: "docs" });
			await replicationPullJob(follower!.state);
			const cursor = getCursor(follower!.db, "node-a", "down");
			expect(cursor).toBeGreaterThan(0);

			follower!.db.run(
				"UPDATE cluster_nodes SET base_url = 'http://127.0.0.1:1' WHERE node_id = 'node-a'",
			);
			const outcomes = await replicationPullJob(follower!.state);
			expect(outcomes[0]!.unreachable).toBe(true);
			expect(getCursor(follower!.db, "node-a", "down")).toBe(cursor);
		} finally {
			c.close();
		}
	});

	test("pulling repeatedly is idempotent", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const owner = await makeUser(master!.db, "owner");
			makeDirectory(master!.db, { ownerId: owner.id, title: "docs" });

			await replicationPullJob(follower!.state);
			const applied = (await replicationPullJob(follower!.state))[0]!.applied;
			expect(applied).toBe(0);
			expect(
				follower!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM directories",
				)!.n,
			).toBe(1);
		} finally {
			c.close();
		}
	});
});
