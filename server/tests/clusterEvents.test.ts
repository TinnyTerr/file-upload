/**
 * Cluster event pipeline (redesign Phase 1, §5.12 — B1, B2, B3).
 *
 * The three defects here are all silent in production: a restarted node's
 * events vanish, a burst loses its oldest entries, and a restart leaves a
 * permanent hole in every peer's view. So each test asserts the *observable*
 * consequence — what a peer polling this node actually receives — rather than
 * the internal counter.
 */

import { describe, expect, test } from "bun:test";
import { createAppState } from "../src/appState.ts";
import { EventBus } from "../src/cluster/eventBus.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeHarness, testSettings } from "./harness.ts";

interface EventsResponse {
	events: { id: number; node_id: string; action: string }[];
	last_id: number;
	count: number;
}

describe("EventBus sequence seeding (B1)", () => {
	test("resumes above the highest sequence already emitted", async () => {
		const h = await makeHarness();
		try {
			for (const action of ["a", "b", "c"]) {
				h.state.eventBus.publish({ action, actor: "tester" });
			}
			expect(h.state.eventBus.currentSeq()).toBe(3);

			// A restart: same database, same node id, a brand new AppState.
			const restarted = createAppState(h.state.settings, h.db);
			expect(restarted.eventBus.currentSeq()).toBe(3);

			// The next event must not collide with one already stored, or
			// INSERT OR IGNORE swallows it.
			const next = restarted.eventBus.publish({ action: "d", actor: "tester" });
			expect(next.id).toBe(4);
			const stored = h.db.all<{ origin_seq: number; action: string }>(
				"SELECT origin_seq, action FROM cluster_events ORDER BY origin_seq",
			);
			expect(stored.map((r) => r.action)).toEqual(["a", "b", "c", "d"]);
		} finally {
			h.close();
		}
	});

	test("seeding is per-node, and never moves backwards", async () => {
		const h = await makeHarness();
		try {
			h.state.eventBus.publish({ action: "mine", actor: "tester" });
			// A peer's event sitting in the same mirror must not raise this
			// node's own counter.
			h.state.eventWriter.write({
				id: 900,
				node_id: "some-peer",
				node_name: "peer",
				ts: new Date().toISOString(),
				kind: "audit",
				action: "theirs",
				actor: "them",
			});
			expect(createAppState(h.state.settings, h.db).eventBus.currentSeq()).toBe(
				1,
			);

			const bus = new EventBus(testSettings());
			bus.seedSeq(10);
			bus.seedSeq(4);
			expect(bus.currentSeq()).toBe(10);
		} finally {
			h.close();
		}
	});
});

describe("EventBus.recent (B2)", () => {
	test("a limited read returns the OLDEST matches, not the newest", () => {
		const bus = new EventBus(testSettings());
		for (let i = 0; i < 10; i++) {
			bus.publish({ action: `e${i}`, actor: "tester" });
		}
		const page = bus.recent({ afterId: 0, limit: 4 });
		expect(page.map((e) => e.id)).toEqual([1, 2, 3, 4]);

		// A consumer advancing its cursor to last_id must not skip anything.
		const next = bus.recent({ afterId: page[page.length - 1]!.id, limit: 4 });
		expect(next.map((e) => e.id)).toEqual([5, 6, 7, 8]);
	});
});

describe("GET /api/admin/cluster/events (B3)", () => {
	test("serves this node's events from the durable table, ascending", async () => {
		const cluster = await makeCluster({ size: 2 });
		try {
			const [a, b] = cluster.nodes;
			for (let i = 0; i < 3; i++) {
				a!.state.eventBus.publish({ action: `a${i}`, actor: "tester" });
			}

			const res = await a!.asPeer(
				"/api/admin/cluster/events?after=0&limit=100",
				{
					method: "GET",
				},
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as EventsResponse;
			expect(body.events.map((e) => e.action)).toEqual(["a0", "a1", "a2"]);
			expect(body.last_id).toBe(3);
			expect(body.count).toBe(3);

			// b's token is the same shared cluster token today, but a node with no
			// token must still be refused.
			const unauthorized = await b!.request(
				"/api/admin/cluster/events?after=0",
			);
			expect(unauthorized.status).toBe(401);
		} finally {
			cluster.close();
		}
	});

	test("a restart does not create a hole in a peer's view", async () => {
		const h = await makeHarness({ clusterToken: "tok" });
		try {
			for (const action of ["before-1", "before-2"]) {
				h.state.eventBus.publish({ action, actor: "tester" });
			}

			// Restart: the in-memory ring buffer is gone, the table is not.
			const restarted = createAppState(h.state.settings, h.db);
			expect(restarted.eventBus.recent()).toEqual([]);
			restarted.eventBus.publish({ action: "after-1", actor: "tester" });

			// A peer polling from cursor 0 still gets everything, in order.
			const res = await h.request("/api/admin/cluster/events?after=0", {
				headers: { authorization: "Bearer tok" },
			});
			const body = (await res.json()) as EventsResponse;
			expect(body.events.map((e) => e.action)).toEqual([
				"before-1",
				"before-2",
				"after-1",
			]);
		} finally {
			h.close();
		}
	});

	test("does not serve events mirrored from other nodes", async () => {
		const h = await makeHarness({ clusterToken: "tok" });
		try {
			h.state.eventBus.publish({ action: "local", actor: "tester" });
			// The cursor a peer sends is *this* node's origin_seq, so a third
			// node's event carrying its own seq would corrupt it.
			h.state.eventWriter.write({
				id: 1,
				node_id: "other-node",
				node_name: "other",
				ts: new Date().toISOString(),
				kind: "audit",
				action: "remote",
				actor: "them",
			});

			const res = await h.request("/api/admin/cluster/events?after=0", {
				headers: { authorization: "Bearer tok" },
			});
			const body = (await res.json()) as EventsResponse;
			expect(body.events.map((e) => e.action)).toEqual(["local"]);
			expect(body.events.every((e) => e.node_id === "test-node")).toBe(true);
		} finally {
			h.close();
		}
	});

	test("paging a burst larger than the limit loses nothing", async () => {
		const h = await makeHarness({ clusterToken: "tok" });
		try {
			for (let i = 0; i < 25; i++) {
				h.state.eventBus.publish({ action: `e${i}`, actor: "tester" });
			}
			const seen: string[] = [];
			let cursor = 0;
			for (let page = 0; page < 5; page++) {
				const res = await h.request(
					`/api/admin/cluster/events?after=${cursor}&limit=10`,
					{ headers: { authorization: "Bearer tok" } },
				);
				const body = (await res.json()) as EventsResponse;
				if (body.count === 0) break;
				seen.push(...body.events.map((e) => e.action));
				cursor = body.last_id;
			}
			expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `e${i}`));
		} finally {
			h.close();
		}
	});
});

describe("cluster harness (Phase 0)", () => {
	test("nodes are separately addressable and authenticate as peers", async () => {
		const cluster = await makeCluster({ size: 3 });
		try {
			expect(cluster.nodes.map((n) => n.nodeId)).toEqual([
				"node-a",
				"node-b",
				"node-c",
			]);
			expect(cluster.master.nodeId).toBe("node-a");
			// Every node advertises the URL a peer would actually dial.
			for (const n of cluster.nodes) {
				expect(n.state.settings.nodeUrl).toBe(n.baseUrl);
			}

			const ping = await cluster.node("node-b").asPeer("/api/cluster/ping", {
				method: "GET",
			});
			expect(ping.status).toBe(200);
			const self = (await ping.json()) as { node_id: string; role: string };
			expect(self.node_id).toBe("node-b");

			cluster.linkAll();
			for (const n of cluster.nodes) {
				const peers = n.db.all<{ node_id: string; base_url: string }>(
					"SELECT node_id, base_url FROM cluster_nodes ORDER BY node_id",
				);
				expect(peers.map((p) => p.node_id)).toEqual(
					cluster.nodes.filter((o) => o !== n).map((o) => o.nodeId),
				);
				for (const p of peers) {
					expect(p.base_url).toBe(cluster.node(p.node_id).baseUrl);
				}
			}
			// Re-linking replaces rather than duplicating.
			cluster.linkAll();
			expect(cluster.master.db.all("SELECT id FROM cluster_nodes").length).toBe(
				2,
			);
		} finally {
			cluster.close();
		}
	});
});
