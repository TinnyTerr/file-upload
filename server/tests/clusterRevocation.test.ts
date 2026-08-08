/**
 * The synchronous revocation path (redesign Phase 6, §5.9 — D-13).
 *
 * Permissions are read locally, so a revoked flag is only really revoked once
 * every node has the new row. Grants can wait for the pull; a revocation
 * cannot, because the gap is a window in which a peer still honours something
 * an admin has taken away. These tests assert the asymmetry actually holds
 * over real nodes: the flag is gone on the peer *before the admin call
 * returns*, and a node that could not be reached is named rather than assumed.
 */

import { describe, expect, test } from "bun:test";
import { logHead } from "../src/cluster/changelog.ts";
import { replicationPullJob } from "../src/cluster/replication.ts";
import { pushRevocation } from "../src/cluster/revocation.ts";
import type { PermissionRow } from "../src/db/rows.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeDirectory, makeFile, makeUser } from "./harness.ts";

interface RevocationReport {
	pushed: number;
	acknowledged: string[];
	lagging: Array<{ node_id: string; name: string; reason: string }>;
}

const canUploadOn = (db: Parameters<typeof logHead>[0], username: string) =>
	db.get<PermissionRow>(
		`SELECT p.* FROM permissions p JOIN users u ON u.id = p.user_id
      WHERE u.username = $username`,
		{ $username: username },
	)?.can_upload;

describe("revocations are pushed, not awaited", () => {
	test("a revoked flag is gone on the peer before the admin call returns", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const user = await makeUser(master!.db, "member");
			master!.db.run(
				"UPDATE permissions SET can_upload = 1 WHERE user_id = $id",
				{ $id: user.id },
			);
			await replicationPullJob(follower!.state);
			expect(canUploadOn(follower!.db, "member")).toBe(1);

			const admin = await makeUser(master!.db, "admin", "master");
			const session = master!.signIn(admin);
			const res = await master!.request(`/api/users/${user.id}/permissions`, {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ can_upload: false }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { revocation: RevocationReport };

			// Nothing was pulled in between -- this is the push, and it is what
			// closes the window §5.9 is about.
			expect(canUploadOn(follower!.db, "member")).toBe(0);
			expect(body.revocation.acknowledged).toContain("node-b");
			expect(body.revocation.lagging).toHaveLength(0);
			expect(body.revocation.pushed).toBeGreaterThan(0);
		} finally {
			c.close();
		}
	});

	test("an unreachable node is named, and catches up from the log instead", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const user = await makeUser(master!.db, "member");
			await replicationPullJob(follower!.state);

			master!.db.run(
				"UPDATE cluster_nodes SET base_url = 'http://127.0.0.1:1' WHERE node_id = 'node-b'",
			);
			const mark = logHead(master!.db);
			master!.db.run(
				"UPDATE permissions SET can_upload = 0 WHERE user_id = $id",
				{ $id: user.id },
			);
			const report = await pushRevocation(master!.state, mark);

			expect(report.acknowledged).toHaveLength(0);
			expect(report.lagging.map((n) => n.node_id)).toEqual(["node-b"]);
			expect(report.lagging[0]!.reason).toBeTruthy();

			// The push failing is a latency problem, not a correctness one: the
			// entry is in the log, so the ordinary pull still converges.
			master!.db.run(
				"UPDATE cluster_nodes SET base_url = $url WHERE node_id = 'node-b'",
				{ $url: follower!.baseUrl },
			);
			await replicationPullJob(follower!.state);
			expect(canUploadOn(follower!.db, "member")).toBe(0);
		} finally {
			c.close();
		}
	});

	test("pushing what the pull will carry anyway is idempotent", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const user = await makeUser(master!.db, "member");
			// The user row first: a permissions entry whose parent has not arrived
			// cannot apply, and that halt is a different behaviour from this test's.
			await replicationPullJob(follower!.state);
			const mark = logHead(master!.db);
			master!.db.run(
				"UPDATE permissions SET can_upload = 0 WHERE user_id = $id",
				{ $id: user.id },
			);
			await pushRevocation(master!.state, mark);
			const entriesAfterPush = follower!.db.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM replication_log",
			)!.n;

			// The pull re-delivers every one of those entries; UNIQUE(origin_node,
			// origin_seq) is what makes that a no-op rather than a duplicate.
			await replicationPullJob(follower!.state);
			expect(
				follower!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM replication_log",
				)!.n,
			).toBe(entriesAfterPush);
			expect(canUploadOn(follower!.db, "member")).toBe(0);
		} finally {
			c.close();
		}
	});

	test("a single node with no peers pays nothing for the push", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const solo = c.master;
			const user = await makeUser(solo.db, "member");
			const mark = logHead(solo.db);
			solo.db.run("UPDATE permissions SET can_upload = 0 WHERE user_id = $id", {
				$id: user.id,
			});
			const report = await pushRevocation(solo.state, mark);
			expect(report.acknowledged).toHaveLength(0);
			expect(report.lagging).toHaveLength(0);
		} finally {
			c.close();
		}
	});

	test("deleting a share link revokes it everywhere, synchronously", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const owner = await makeUser(master!.db, "owner", "master");
			const session = master!.signIn(owner);

			const dirId = makeDirectory(master!.db, {
				ownerId: owner.id,
				title: "shared",
			});
			const fileId = makeFile(master!.db, {
				ownerId: owner.id,
				directoryId: dirId,
				name: "note.txt",
			});
			master!.db.run(
				`INSERT INTO links (file_id, slug, use_count, active, hide_uploader, created_at)
         VALUES ($file, 'revoke-me', 0, 1, 0, $now)`,
				{ $file: fileId, $now: new Date().toISOString() },
			);
			const link = master!.db.get<{ id: number }>(
				"SELECT id FROM links WHERE file_id = $id",
				{ $id: fileId },
			)!;
			await replicationPullJob(follower!.state);
			expect(
				follower!.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM links")!.n,
			).toBe(1);

			const res = await master!.request(`/api/links/${link.id}`, {
				method: "DELETE",
				cookie: session.cookie,
				csrf: session.csrf,
			});
			expect(res.status).toBe(200);
			expect(
				follower!.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM links")!.n,
			).toBe(0);
		} finally {
			c.close();
		}
	});
});
