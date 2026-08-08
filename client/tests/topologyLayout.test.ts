import { describe, expect, test } from "bun:test";
import {
	layoutTopology,
	NODE_H,
	NODE_W,
} from "../src/features/cluster/lib/topologyLayout";
import type {
	ClusterTopology,
	TopologyNode,
} from "../src/features/cluster/types";

function node(id: string, over: Partial<TopologyNode> = {}): TopologyNode {
	return {
		node_id: id,
		name: id,
		base_url: `http://${id}`,
		role: "follower",
		region: "r1",
		in_generation: true,
		reachable: true,
		eligible: true,
		pinned: false,
		is_self: false,
		upstream: null,
		fell_back: false,
		rtt_ms: 1,
		replication_mode: "full",
		disk_total_bytes: 100,
		disk_free_bytes: 50,
		used_bytes: 50,
		last_heartbeat_at: null,
		...over,
	};
}

function topology(nodes: TopologyNode[]): ClusterTopology {
	return {
		generation: 3,
		computed_at: "2026-01-01T00:00:00Z",
		reason: "manual",
		master_node_id: nodes.find((n) => n.role === "master")?.node_id ?? null,
		self_node_id: nodes[0]?.node_id ?? "",
		nodes,
	};
}

const at = (layout: ReturnType<typeof layoutTopology>, id: string) =>
	layout.nodes.find((p) => p.node.node_id === id)!;

describe("topology layout", () => {
	test("stacks the tiers: master, region leader, followers", () => {
		const layout = layoutTopology(
			topology([
				node("a", { role: "master" }),
				node("b", { role: "leader", upstream: "a" }),
				node("c", { upstream: "b" }),
				node("d", { upstream: "b" }),
			]),
		);

		expect(at(layout, "a").y).toBeLessThan(at(layout, "b").y);
		expect(at(layout, "b").y).toBeLessThan(at(layout, "c").y);
		// Siblings share a row and don't overlap.
		expect(at(layout, "c").y).toBe(at(layout, "d").y);
		expect(
			Math.abs(at(layout, "c").x - at(layout, "d").x),
		).toBeGreaterThanOrEqual(NODE_W);
		// Every box is inside the canvas the card sizes itself to.
		for (const placed of layout.nodes) {
			expect(placed.x).toBeGreaterThanOrEqual(0);
			expect(placed.x + NODE_W).toBeLessThanOrEqual(layout.width);
			expect(placed.y + NODE_H).toBeLessThanOrEqual(layout.height);
		}
	});

	test("draws one edge per upstream, child top to parent bottom", () => {
		const layout = layoutTopology(
			topology([
				node("a", { role: "master" }),
				node("b", { role: "leader", upstream: "a" }),
				node("c", { upstream: "b" }),
			]),
		);

		expect(layout.edges).toHaveLength(2);
		const edge = layout.edges.find((e) => e.id === "c->b")!;
		expect(edge.y1).toBe(at(layout, "c").y);
		expect(edge.y2).toBe(at(layout, "b").y + NODE_H);
		expect(edge.fallback).toBe(false);
	});

	test("marks the fallback edge so it reads as the anomaly it is", () => {
		const layout = layoutTopology(
			topology([
				node("a", { role: "master" }),
				node("b", { role: "leader", upstream: "a", reachable: false }),
				node("c", { upstream: "a", fell_back: true }),
			]),
		);

		const edge = layout.edges.find((e) => e.id === "c->a")!;
		expect(edge.fallback).toBe(true);
		// It still spans two tiers -- a follower that has fallen back is still a
		// follower, and the long line is the point.
		expect(at(layout, "c").y).toBeGreaterThan(at(layout, "b").y);
	});

	test("a region with no leader hangs its followers off the master", () => {
		const layout = layoutTopology(
			topology([
				node("a", { role: "master", region: "r1" }),
				node("b", { role: "leader", region: "r1", upstream: "a" }),
				node("c", { region: "r2", upstream: "a" }),
			]),
		);

		// No leader in r2, so no empty tier is left for one.
		expect(at(layout, "c").y).toBe(at(layout, "b").y);
		expect(layout.bands.map((b) => b.region)).toEqual(["r1", "r2"]);
	});

	test("an untiered node is drawn unconnected, because it has no upstream", () => {
		const layout = layoutTopology(
			topology([
				node("a", { role: "master" }),
				node("b", { role: "leader", upstream: "a" }),
				node("z", {
					role: null,
					region: null,
					in_generation: false,
					upstream: null,
				}),
			]),
		);

		expect(layout.untiered.map((n) => n.node_id)).toEqual(["z"]);
		expect(layout.edges.map((e) => e.id)).toEqual(["b->a"]);
		expect(at(layout, "z").y).toBeGreaterThan(at(layout, "b").y);
	});

	test("a single-node cluster is a single box", () => {
		const layout = layoutTopology(topology([node("a", { role: "master" })]));
		expect(layout.nodes).toHaveLength(1);
		expect(layout.edges).toHaveLength(0);
		expect(layout.width).toBeGreaterThanOrEqual(NODE_W);
	});
});
