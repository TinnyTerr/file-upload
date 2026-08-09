/**
 * Multi-node in-process cluster harness (redesign Phase 0).
 *
 * Each node is a full `makeHarness()` — its own database, its own AppState,
 * its own Express app on its own ephemeral port — so node-to-node calls are
 * real HTTP over the real routers with real cluster-token auth. A test that
 * passes here passed against the actual protocol, not a mock of it.
 *
 * `NODE_URL` can only be known after `listen()`, so it is written back onto
 * the node's `Settings` once the port is bound. Everything reads
 * `state.settings.nodeUrl` at call time, so that is sound.
 *
 * LIMITATION — blob bytes: `storage/paths.ts` resolves the storage root from
 * `process.env.FILEUPLOAD_STORAGE`, which is process-global, so every node in
 * one cluster harness shares one root. Physically, a peer's file is therefore
 * visible to every node here in a way it never is in production.
 *
 * Phase 8's chunk tests work within that because presence is a *database*
 * fact: a node serves, fetches, places and evicts on the strength of its own
 * `chunk_locations` rows (cluster/placement.ts), so staging a divergence in
 * the registry exercises exactly the code a physical divergence would. What is
 * still out of reach is a test that a node genuinely cannot read another's
 * bytes — that needs the storage root to become per-node state.
 */

import { randomBytes } from "node:crypto";
import { performExchange } from "../src/cluster/credentials.ts";
import { adoptTiering, retier } from "../src/cluster/tiering.ts";
import type { Settings } from "../src/config.ts";
import { nowIso } from "../src/db/rows.ts";
import { type Harness, makeHarness } from "./harness.ts";

export interface ClusterNodeHarness extends Harness {
	nodeId: string;
	nodeName: string;
	/** The shared cluster token. Since Phase 9 this is a *bootstrap* credential:
	 * this node honours it only until every linked peer has established a pair
	 * credential (`cluster/credentials.ts::legacyTokenAcceptable`). */
	token: string;
	/** `request()` with a cluster credential attached — i.e. a call made *as a
	 * peer*, hitting the node-to-node auth path rather than a session. Defaults
	 * to the shared token; pass `secret` for a pair credential. */
	asPeer(
		path: string,
		init?: RequestInit & { json?: unknown; secret?: string },
	): Promise<Response>;
}

export interface ClusterHarness {
	nodes: ClusterNodeHarness[];
	/** nodes[0] — the node booted with `NODE_ROLE=master`. */
	master: ClusterNodeHarness;
	node(nodeId: string): ClusterNodeHarness;
	/** Records `to` in `from`'s `cluster_nodes` table, which is what every
	 * peer-walking loop (firehose consumer, replication, blob fetch) reads. */
	link(from: ClusterNodeHarness, to: ClusterNodeHarness): void;
	/** Full mesh, both directions, every pair — then tiers, since a linked but
	 * untiered node has no upstream and replicates with nobody.
	 *
	 * Leaves every pair on the shared cluster token, which is the state an
	 * upgraded deployment boots into and which `legacyTokenAcceptable()` still
	 * honours (§5.13). Call `credentialAll()` to run the exchange. */
	linkAll(): void;
	/** Establish a pair credential across every linked edge, the way the
	 * `cluster_credentials` job does in production. After this the shared token
	 * is refused everywhere, so a test that wants the Phase 9 end state calls
	 * it and a test that wants the migration state does not. */
	credentialAll(): Promise<void>;
	/** Mint a generation on the master and hand it to every other node, which is
	 * what the join handshake and heartbeat do in production
	 * (cluster/tiering.ts). Call this after changing what the computation reads
	 * — capacity, eligibility, liveness — to see the new plan take effect. */
	tier(): void;
	close(): void;
}

const NODE_IDS = "abcdefghijklmnopqrstuvwxyz";

export async function makeCluster(
	opts: {
		size?: number;
		/** Shared cluster token. Per-node credentials land in Phase 9; until
		 * then every node accepts the same one, as production does. */
		token?: string;
		/** Per-node settings overrides, by index. */
		settings?: (index: number) => Partial<Settings>;
	} = {},
): Promise<ClusterHarness> {
	const size = opts.size ?? 2;
	if (size > NODE_IDS.length) {
		throw new Error(
			`cluster harness supports at most ${NODE_IDS.length} nodes`,
		);
	}
	const token = opts.token ?? randomBytes(16).toString("base64url");

	const nodes: ClusterNodeHarness[] = [];
	for (let i = 0; i < size; i++) {
		const nodeId = `node-${NODE_IDS[i]}`;
		const nodeName = `test-${NODE_IDS[i]}`;
		const harness = await makeHarness({
			nodeId,
			nodeName,
			nodeRole: i === 0 ? "master" : "follower",
			clusterToken: token,
			...opts.settings?.(i),
		});
		// Now that the port is bound, tell the node what to advertise.
		harness.state.settings.nodeUrl = harness.baseUrl;

		nodes.push({
			...harness,
			nodeId,
			nodeName,
			token,
			asPeer(path, init = {}) {
				const { json, headers, secret, ...rest } = init;
				const h = new Headers(headers);
				h.set("authorization", `Bearer ${secret ?? token}`);
				if (json !== undefined) {
					h.set("content-type", "application/json");
				}
				return harness.request(path, {
					...rest,
					headers: h,
					...(json !== undefined
						? { method: rest.method ?? "POST", body: JSON.stringify(json) }
						: {}),
				});
			},
		});
	}

	function link(from: ClusterNodeHarness, to: ClusterNodeHarness): void {
		// `cluster_nodes.node_id` carries no unique constraint (production upserts
		// via a select-then-write in membership.ts), so re-linking replaces.
		from.db.run("DELETE FROM cluster_nodes WHERE node_id = $nodeId", {
			$nodeId: to.nodeId,
		});
		// No role, no is_master: both are derived from the tiering generation
		// (cluster/tiering.ts) and writing them here would be asserting exactly
		// the thing Phase 4 stopped letting nodes assert.
		from.db.run(
			`INSERT INTO cluster_nodes (node_id, name, base_url, token, active,
         archive_enabled, replication_mode, created_at)
       VALUES ($nodeId, $name, $baseUrl, $token, 1, 1, $mode, $now)`,
			{
				$nodeId: to.nodeId,
				$name: to.nodeName,
				$baseUrl: to.baseUrl,
				$token: to.token,
				$mode: to.state.settings.replicationMode,
				$now: nowIso(),
			},
		);
	}

	const master = nodes[0]!;

	// nodes[0] booted with NODE_ROLE=master, so it holds the bootstrap
	// generation; every other node adopts what it computes. In production the
	// join handshake and heartbeat carry this (membership.ts), which needs a
	// live mesh — here it is a direct hand-off, because these tests are about
	// what happens once the mesh exists.
	function tier(): void {
		const minted = retier(master.state, "manual");
		if (!minted) throw new Error("cluster harness: nodes[0] is not master");
		for (const node of nodes) {
			if (node === master) continue;
			adoptTiering(node.state, minted, { force: true });
		}
	}

	return {
		nodes,
		master,
		node(nodeId) {
			const found = nodes.find((n) => n.nodeId === nodeId);
			if (!found) throw new Error(`no such node in harness: ${nodeId}`);
			return found;
		},
		link,
		tier,
		linkAll() {
			for (const from of nodes) {
				for (const to of nodes) {
					if (from !== to) link(from, to);
				}
			}
			tier();
		},
		async credentialAll() {
			// One exchange per unordered pair: it re-mints both directions, so
			// running it twice per pair would just rotate what the first call
			// established.
			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					await performExchange(nodes[i]!.state, {
						baseUrl: nodes[j]!.baseUrl,
						auth: nodes[j]!.token,
						expectNodeId: nodes[j]!.nodeId,
					});
				}
			}
		},
		close() {
			for (const n of nodes) n.close();
		},
	};
}
