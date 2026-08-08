/**
 * The replication graph the cluster dashboard draws (`cluster/topology.ts`).
 *
 * The diagram is only worth having if it shows the edges the cluster actually
 * pulls on, so these tests assert exactly that: the graph agrees with
 * `upstreamOf()` over the same generation, it reflects *this* node's liveness
 * observation rather than the snapshot's, and it refuses to invent an edge for
 * a node the generation has never seen.
 */

import { describe, expect, test } from "bun:test";
import { buildTopology, type TopologyNode } from "../src/cluster/topology.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeUser } from "./harness.ts";

const byId = (nodes: TopologyNode[]) =>
	new Map(nodes.map((n) => [n.node_id, n]));

describe("cluster topology", () => {
	test("is the hierarchy: master on top, region leader between", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const nodes = byId(buildTopology(c.master.state).nodes);
			// Equal capacity across the harness, so the tie-break is node_id: a is
			// master, and b leads the region because the master is struck out of
			// every region's candidate set.
			expect(nodes.get("node-a")!.role).toBe("master");
			expect(nodes.get("node-b")!.role).toBe("leader");
			expect(nodes.get("node-c")!.role).toBe("follower");

			expect(nodes.get("node-a")!.upstream).toBeNull();
			expect(nodes.get("node-b")!.upstream).toBe("node-a");
			expect(nodes.get("node-c")!.upstream).toBe("node-b");
			for (const node of nodes.values()) {
				expect(node.in_generation).toBe(true);
				expect(node.fell_back).toBe(false);
			}
			expect(nodes.get("node-a")!.is_self).toBe(true);
			expect(nodes.get("node-b")!.is_self).toBe(false);
		} finally {
			c.close();
		}
	});

	test("every node draws the same graph, because it is one generation", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const edgesOf = (node: (typeof c.nodes)[number]) =>
				buildTopology(node.state)
					.nodes.map((n) => `${n.node_id}->${n.upstream ?? "-"}`)
					.sort();

			const fromMaster = edgesOf(c.master);
			for (const node of c.nodes) {
				expect(edgesOf(node)).toEqual(fromMaster);
			}
		} finally {
			c.close();
		}
	});

	test("a follower cut off from its leader shows the fallback edge — and only it does", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const follower = c.node("node-c");
			// Only node-c stops seeing the leader. Liveness here is this node's own
			// heartbeat observation, not the snapshot's `active` flag, so nobody
			// else's picture may change.
			follower.db.run(
				"UPDATE cluster_nodes SET active = 0 WHERE node_id = 'node-b'",
			);

			const own = byId(buildTopology(follower.state).nodes).get("node-c")!;
			expect(own.upstream).toBe("node-a");
			expect(own.fell_back).toBe(true);

			const seenByMaster = byId(buildTopology(c.master.state).nodes).get(
				"node-c",
			)!;
			expect(seenByMaster.upstream).toBe("node-b");
			expect(seenByMaster.fell_back).toBe(false);
		} finally {
			c.close();
		}
	});

	test("a node the generation has never seen gets no upstream and no role", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			// Linked, but deliberately not tiered: until a snapshot admits it, it
			// has no upstream and replicates with nobody.
			c.link(c.master, c.nodes[1]!);
			const nodes = byId(buildTopology(c.master.state).nodes);

			const joiner = nodes.get("node-b")!;
			expect(joiner.in_generation).toBe(false);
			expect(joiner.role).toBeNull();
			expect(joiner.upstream).toBeNull();
			expect(nodes.get("node-a")!.role).toBe("master");

			// Re-tiering is what admits it, and the edge appears with it.
			c.tier();
			const after = byId(buildTopology(c.master.state).nodes).get("node-b")!;
			expect(after.in_generation).toBe(true);
			expect(after.upstream).toBe("node-a");
		} finally {
			c.close();
		}
	});

	test("GET /api/cluster/topology serves it to a cluster manager", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const admin = await makeUser(c.master.db, "admin", "master");
			const session = c.master.signIn(admin);

			const res = await c.master.request("/api/cluster/topology", {
				cookie: session.cookie,
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				generation: number;
				master_node_id: string;
				self_node_id: string;
				nodes: TopologyNode[];
			};
			expect(body.generation).toBeGreaterThan(0);
			expect(body.master_node_id).toBe("node-a");
			expect(body.self_node_id).toBe("node-a");
			expect(body.nodes).toHaveLength(2);

			// Session-authenticated management surface: a caller with no session is
			// not one of them.
			const anon = await c.master.request("/api/cluster/topology");
			expect(anon.status).toBe(401);
		} finally {
			c.close();
		}
	});
});
