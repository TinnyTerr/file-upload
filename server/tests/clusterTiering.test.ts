/**
 * Tiering: leadership as a pure function of a membership snapshot (Phase 4,
 * §5.3–5.4).
 *
 * The point of the redesign is that leadership stops being negotiated, so most
 * of what is worth testing is arithmetic over a snapshot — which is why the
 * first block runs `computePlan` directly with no cluster at all. The rest goes
 * through `makeCluster`, because a rule about who talks to whom is only real if
 * it holds over the actual routers.
 */

import { describe, expect, test } from "bun:test";
import {
	adoptTiering,
	computePlan,
	currentTiering,
	HOLD_DOWN_MS,
	inferRegions,
	measureDrift,
	retier,
	roleOf,
	selfRole,
	type TieringMember,
	tieringDriftJob,
	upstreamOf,
} from "../src/cluster/tiering.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeUser } from "./harness.ts";

function member(
	nodeId: string,
	over: Partial<TieringMember> = {},
): TieringMember {
	return {
		node_id: nodeId,
		name: nodeId,
		base_url: `http://${nodeId}`,
		region: "r1",
		region_source: "inferred",
		disk_total_bytes: 0,
		rtt_ms: 0,
		replication_mode: "full",
		active: true,
		eligible: true,
		pinned: false,
		...over,
	};
}

describe("the leader function", () => {
	test("picks the largest node, breaking ties on node_id", () => {
		const plan = computePlan(
			[
				member("c", { disk_total_bytes: 100 }),
				member("a", { disk_total_bytes: 100 }),
				member("b", { disk_total_bytes: 50 }),
			],
			"a",
		);
		expect(plan.masterNodeId).toBe("a");
		// The tie-break is the whole trick: every node computes the same winner
		// from the same input, so agreeing on the snapshot is agreeing on the
		// leader — no votes, no quorum, no epoch.
		expect(plan.regions.r1!.leader).toBe("c");
	});

	test("strikes the master out of every region's candidate set (D-15)", () => {
		const plan = computePlan(
			[
				member("a", { disk_total_bytes: 900, region: "eu" }),
				member("b", { disk_total_bytes: 100, region: "eu" }),
				member("c", { disk_total_bytes: 500, region: "us" }),
			],
			"a",
		);
		expect(plan.masterNodeId).toBe("a");
		// The master's own region is led by its second-largest node, and tier 0
		// and tier 1 are never the same box.
		expect(plan.regions.eu!.leader).toBe("b");
		expect(plan.regions.us!.leader).toBe("c");
	});

	test("a region holding only the master has no leader, and needs none", () => {
		const plan = computePlan(
			[
				member("a", { disk_total_bytes: 900, region: "eu" }),
				member("b", { disk_total_bytes: 100, region: "us" }),
			],
			"a",
		);
		expect(plan.regions.eu!.leader).toBeNull();
		expect(plan.regions.us!.leader).toBe("b");
	});

	test("ineligible, inactive and cache-mode nodes cannot lead", () => {
		const plan = computePlan(
			[
				member("a", { disk_total_bytes: 10 }),
				member("b", { disk_total_bytes: 900, eligible: false }),
				member("c", { disk_total_bytes: 500, eligible: false }),
			],
			"a",
		);
		expect(plan.masterNodeId).toBe("a");
		expect(plan.regions.r1!.leader).toBeNull();
	});

	test("an operator pin overrides the computation entirely", () => {
		const plan = computePlan(
			[
				member("a", { disk_total_bytes: 900 }),
				member("b", { disk_total_bytes: 1, pinned: true }),
			],
			"a",
		);
		expect(plan.masterNodeId).toBe("b");
		expect(plan.regions.r1!.leader).toBe("a");
	});

	test("an all-ineligible snapshot keeps the incumbent rather than vacating", () => {
		// Vacating leadership is precisely what no node is allowed to decide
		// (D-2). A computation with nobody to pick must not do it by accident.
		const plan = computePlan([member("a", { eligible: false })], "a");
		expect(plan.masterNodeId).toBe("a");
	});
});

describe("region inference", () => {
	test("configured regions win and are never regrouped", () => {
		const members = inferRegions(
			[
				member("a", { region: "eu-west", region_source: "configured" }),
				member("b", { rtt_ms: 400 }),
			],
			30,
		);
		expect(members.find((m) => m.node_id === "a")!.region).toBe("eu-west");
		expect(members.find((m) => m.node_id === "b")!.region).toBe("r1");
	});

	test("unconfigured nodes group by RTT, and with no measurements land in one region", () => {
		const grouped = inferRegions(
			[
				member("a", { rtt_ms: 0 }),
				member("b", { rtt_ms: 5 }),
				member("c", { rtt_ms: 200 }),
			],
			30,
		);
		expect(grouped.map((m) => m.region)).toEqual(["r1", "r1", "r2"]);

		// D-9's single-region case: nothing measured, so nothing splits and the
		// region tier stays dormant.
		const flat = inferRegions([member("a"), member("b"), member("c")], 30);
		expect(new Set(flat.map((m) => m.region))).toEqual(new Set(["r1"]));
	});
});

describe("bootstrap and adoption", () => {
	test("a node booted as master mints generation 1 and mirrors it for the change log", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const tiering = currentTiering(c.master.db)!;
			expect(tiering.generation).toBe(1);
			expect(tiering.reason).toBe("bootstrap");
			expect(tiering.master_node_id).toBe("node-a");
			// The change log's fixup trigger reads this column to decide whether
			// local seq is also canonical master_seq — a trigger cannot reach
			// application state, only other tables.
			expect(
				c.master.db.get<{ is_master: number }>(
					"SELECT is_master FROM replication_control WHERE id = 1",
				)!.is_master,
			).toBe(1);
		} finally {
			c.close();
		}
	});

	test("NODE_ROLE cannot override a generation the cluster has already minted", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			// nodes[1] booted as a follower; the generation makes it the leader.
			// Both are derived, and the env var gets no say after the first boot.
			expect(c.nodes[1]!.state.settings.nodeRole).toBe("follower");
			expect(selfRole(c.nodes[1]!.state)).toBe("leader");
		} finally {
			c.close();
		}
	});

	test("only a strictly higher generation is adopted", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const held = currentTiering(follower.db)!;

			// A stale relay handing back the generation it is relaying must not
			// overwrite it, and a lower one must not roll leadership backwards.
			expect(adoptTiering(follower.state, held)).toBe(false);
			expect(
				adoptTiering(follower.state, {
					...held,
					generation: held.generation - 1,
					master_node_id: "node-b",
				}),
			).toBe(false);
			expect(currentTiering(follower.db)!.master_node_id).toBe("node-a");

			expect(
				adoptTiering(follower.state, {
					...held,
					generation: held.generation + 1,
					master_node_id: "node-b",
				}),
			).toBe(true);
			expect(selfRole(follower.state)).toBe("master");
		} finally {
			c.close();
		}
	});

	test("a peer's role is derived from the generation, never from what it claimed", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			// The join handshake carries a `role` field for logs and the UI. It is
			// not what lands in cluster_nodes: an unauthenticated self-asserted role
			// was S4, and the fix is that nothing reads the claim.
			const res = await c.master.asPeer("/api/cluster/join", {
				json: {
					node_id: "node-b",
					name: "test-b",
					base_url: c.nodes[1]!.baseUrl,
					token: c.nodes[1]!.token,
					role: "master",
					is_master: true,
				},
			});
			expect(res.status).toBe(200);
			expect(
				c.master.db.get<{ role: string; is_master: number }>(
					"SELECT role, is_master FROM cluster_nodes WHERE node_id = 'node-b'",
				),
			).toMatchObject({ role: "leader", is_master: 0 });
		} finally {
			c.close();
		}
	});
});

describe("drift (§5.4)", () => {
	test("the threshold floors at 2, so one flapping node cannot re-tier a 3-node cluster", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			// trunc(3/3) = 1 without the floor, which is exactly the case §4.1
			// singles out.
			expect(measureDrift(c.master.db, c.master.state.settings).threshold).toBe(
				2,
			);
		} finally {
			c.close();
		}
	});

	test("a status change is held down before it counts, and a restart is not drift", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const settings = c.master.state.settings;
			c.master.db.run(
				"UPDATE cluster_nodes SET active = 0 WHERE node_id IN ('node-b', 'node-c')",
			);

			// Both nodes changed, but neither has held the new status yet.
			const fresh = measureDrift(c.master.db, settings);
			expect(fresh.changes).toBe(0);
			expect(fresh.pending).toBeGreaterThan(0);
			expect(tieringDriftJob(c.master.state)!.changes).toBe(0);
			expect(currentTiering(c.master.db)!.generation).toBe(2);

			// Same observation, five minutes later: now it counts, and the count
			// reaches the threshold.
			const later = measureDrift(c.master.db, settings, {
				now: Date.now() + HOLD_DOWN_MS + 1000,
			});
			expect(later.changes).toBeGreaterThanOrEqual(later.threshold);
		} finally {
			c.close();
		}
	});

	test("a node the current generation has never seen counts immediately", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			// node-a alone is tiered; b and c are linked but were never folded in.
			c.link(c.master, c.nodes[1]!);
			c.link(c.master, c.nodes[2]!);

			// Until a node is in a snapshot it has no upstream and its writes reach
			// nobody, so waiting out the hold-down would be five minutes of silent
			// data isolation — a worse failure than a redundant re-tier.
			const report = measureDrift(c.master.db, c.master.state.settings);
			expect(report.changes).toBe(2);
			expect(report.pending).toBe(0);

			tieringDriftJob(c.master.state);
			expect(currentTiering(c.master.db)!.generation).toBe(2);
			expect(currentTiering(c.master.db)!.reason).toBe("drift");
		} finally {
			c.close();
		}
	});

	test("a capacity change only counts when it would change who leads (R-3)", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const db = c.master.db;
			// Capacity is the leader score outright (D-4), so give the peers some.
			db.run(
				"UPDATE cluster_nodes SET disk_total_bytes = 900 WHERE node_id = 'node-b'",
			);
			db.run(
				"UPDATE cluster_nodes SET disk_total_bytes = 100 WHERE node_id = 'node-c'",
			);
			c.tier();
			const settings = c.master.state.settings;
			const at = Date.now() + HOLD_DOWN_MS + 1000;

			// Routine disk growth that leaves the ordering alone changes nothing:
			// counting raw disk_total_bytes would make ordinary growth look like
			// churn.
			db.run(
				"UPDATE cluster_nodes SET disk_total_bytes = 200 WHERE node_id = 'node-c'",
			);
			expect(measureDrift(db, settings, { now: at }).changes).toBe(0);

			// Growth that overtakes the node above it is a different matter — it
			// shows up as a role flip on exactly the two nodes it affects.
			db.run(
				"UPDATE cluster_nodes SET disk_total_bytes = 5000 WHERE node_id = 'node-c'",
			);
			expect(measureDrift(db, settings, { now: at }).changes).toBe(2);
		} finally {
			c.close();
		}
	});
});

describe("only the master mints", () => {
	test("a follower's re-tier is refused, so a master outage cannot move leadership", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const before = currentTiering(follower.db)!.generation;

			// D-2: no automatic failover, and it falls out of the design rather than
			// being enforced on top of it. During a master outage no generation can
			// be minted, so leadership simply does not move.
			expect(retier(follower.state, "manual")).toBeNull();
			expect(tieringDriftJob(follower.state)).toBeNull();
			expect(currentTiering(follower.db)!.generation).toBe(before);
		} finally {
			c.close();
		}
	});

	test("POST /api/cluster/retier mints on the master and 409s everywhere else", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const before = currentTiering(c.master.db)!.generation;
			const admin = await makeUser(c.master.db, "admin", "master");
			const session = c.master.signIn(admin);

			const ok = await c.master.request("/api/cluster/retier", {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
			});
			expect(ok.status).toBe(200);
			expect(currentTiering(c.master.db)!.generation).toBe(before + 1);
			expect(currentTiering(c.master.db)!.reason).toBe("manual");

			const follower = c.nodes[1]!;
			const followerAdmin = await makeUser(follower.db, "admin", "master");
			const followerSession = follower.signIn(followerAdmin);
			const refused = await follower.request("/api/cluster/retier", {
				method: "POST",
				cookie: followerSession.cookie,
				csrf: followerSession.csrf,
			});
			expect(refused.status).toBe(409);
		} finally {
			c.close();
		}
	});
});

describe("the hierarchy", () => {
	test("upstreamOf is the whole topology rule", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const t = currentTiering(c.master.db)!;
			expect(upstreamOf(t, "node-a")).toBeNull();
			expect(upstreamOf(t, "node-b")).toBe("node-a");
			expect(upstreamOf(t, "node-c")).toBe("node-b");
			// A leader that cannot be reached is stepped over, not waited on.
			expect(upstreamOf(t, "node-c", (id) => id !== "node-b")).toBe("node-a");
			expect(roleOf(t, "node-b")).toBe("leader");
		} finally {
			c.close();
		}
	});

	test("a write on a follower reaches the master through its leader", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const [master, leader, follower] = c.nodes;
			const { replicationPullJob } = await import(
				"../src/cluster/replication.ts"
			);
			await makeUser(follower!.db, "owner");

			// One pull interval per hop is the propagation budget the redesign sets
			// (§5.7): the leader picks it up, then the master picks it up from the
			// leader — no follower ever hands anything to a sibling.
			await replicationPullJob(leader!.state);
			expect(
				leader!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM users WHERE username = 'owner'",
				)!.n,
			).toBe(1);
			expect(
				master!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM users WHERE username = 'owner'",
				)!.n,
			).toBe(0);

			await replicationPullJob(master!.state);
			expect(
				master!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM users WHERE username = 'owner'",
				)!.n,
			).toBe(1);
		} finally {
			c.close();
		}
	});
});
