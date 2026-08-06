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
 * one cluster harness shares one root. This harness is therefore for the
 * control plane and metadata replication. Chunk placement (Phase 8) needs the
 * storage root to become per-node state first.
 */

import { randomBytes } from "node:crypto";
import type { Settings } from "../src/config.ts";
import { nowIso } from "../src/db/rows.ts";
import { type Harness, makeHarness } from "./harness.ts";

export interface ClusterNodeHarness extends Harness {
	nodeId: string;
	nodeName: string;
	/** The cluster token this node accepts, and that peers present to it. */
	token: string;
	/** `request()` with this node's cluster token attached — i.e. a call made
	 * *as a peer*, hitting the node-to-node auth path rather than a session. */
	asPeer(
		path: string,
		init?: RequestInit & { json?: unknown },
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
	/** Full mesh, both directions, every pair. */
	linkAll(): void;
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
				const { json, headers, ...rest } = init;
				const h = new Headers(headers);
				h.set("authorization", `Bearer ${token}`);
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
		from.db.run(
			`INSERT INTO cluster_nodes (node_id, name, base_url, token, active, is_master, role,
         archive_enabled, replication_mode, created_at)
       VALUES ($nodeId, $name, $baseUrl, $token, 1, $isMaster, $role, 1, $mode, $now)`,
			{
				$nodeId: to.nodeId,
				$name: to.nodeName,
				$baseUrl: to.baseUrl,
				$token: to.token,
				$isMaster: to.state.settings.nodeRole === "master" ? 1 : 0,
				$role: to.state.settings.nodeRole,
				$mode: to.state.settings.replicationMode,
				$now: nowIso(),
			},
		);
	}

	// Point every follower at nodes[0] as its master. In production the join
	// handshake learns this (membership.ts::learnMasterPointer); here it is
	// config, because these tests are about what happens once the mesh exists.
	const master = nodes[0]!;
	for (const node of nodes.slice(1)) {
		node.db.run(
			`UPDATE cluster_self_state
          SET current_master_id = $id, current_master_url = $url, updated_at = $now
        WHERE id = 1`,
			{ $id: master.nodeId, $url: master.baseUrl, $now: nowIso() },
		);
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
		linkAll() {
			for (const from of nodes) {
				for (const to of nodes) {
					if (from !== to) link(from, to);
				}
			}
		},
		close() {
			for (const n of nodes) n.close();
		},
	};
}
