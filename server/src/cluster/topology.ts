import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { diskUsageBytes, usedStorageBytes } from "../storage/accounting.ts";
import {
	currentTiering,
	type NodeRole,
	regionOf,
	roleOf,
	type TierReason,
	upstreamOf,
} from "./tiering.ts";

/**
 * The replication graph, as *this* node sees it — the thing the cluster
 * dashboard draws.
 *
 * It is derived here rather than in the client for one reason: `upstreamOf()`
 * is the whole topology rule (§5.1), and a second copy of it in TypeScript on
 * the other side of the wire is a copy that can disagree with the one the
 * replication job actually follows. A diagram that disagrees with the pulls is
 * worse than no diagram, so the picture is built from the same function
 * `pullTargets()` uses, over the same generation, with the same liveness
 * observation.
 *
 * Two views of liveness meet here, exactly as they do in `pullTargets`: the
 * snapshot's `active` flag is the master's view at mint time, while whether a
 * peer answers heartbeats *now* is this node's own. The edges are drawn from
 * the local observation, which is why a follower cut off from its region leader
 * shows the fallback edge to the master — that fallback is real, and it is
 * invisible in the snapshot.
 */

export interface TopologyNode {
	node_id: string;
	name: string;
	base_url: string;
	/** Null when the node is not in the current generation's snapshot: it has no
	 * computed role yet, and pretending it is a follower would draw an edge that
	 * does not exist. */
	role: NodeRole | null;
	region: string | null;
	/** Present in the snapshot the current generation was computed over. A node
	 * linked since then has no upstream and replicates with nobody until the
	 * next generation admits it (§5.4). */
	in_generation: boolean;
	/** This node's own heartbeat observation, not the snapshot's `active`. */
	reachable: boolean;
	/** Eligible for leadership at mint time — live, not operator-flagged, not a
	 * cache-mode node. Null outside the snapshot. */
	eligible: boolean | null;
	pinned: boolean;
	is_self: boolean;
	/** The node this one pulls its change log down from; null on the master and
	 * on anything the generation has never seen. */
	upstream: string | null;
	/** True when `upstream` is the master only because this node's region leader
	 * is unreachable — a degraded edge, not the planned one. */
	fell_back: boolean;
	rtt_ms: number | null;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	last_heartbeat_at: string | null;
}

export interface Topology {
	/** 0 on a node that has never been tiered — which is a node with no edges at
	 * all, deliberately. */
	generation: number;
	computed_at: string | null;
	reason: TierReason | null;
	master_node_id: string | null;
	self_node_id: string;
	nodes: TopologyNode[];
}

/** Everything the graph knows about one node before its edge is computed. */
type Draft = Omit<TopologyNode, "upstream" | "fell_back">;

export function buildTopology(state: AppState): Topology {
	const { db, settings } = state;
	const tiering = currentTiering(db);
	const selfId = settings.nodeId;
	const drafts = new Map<string, Draft>();

	// Self first, so a peer row that somehow carries our own node_id (a node
	// linked to itself by mistake) can't overwrite what we know first-hand.
	const usage = diskUsageBytes();
	drafts.set(selfId, {
		node_id: selfId,
		name: settings.nodeName,
		base_url: settings.nodeUrl,
		role: null,
		region: tiering ? regionOf(tiering, selfId) : null,
		in_generation: false,
		reachable: true,
		eligible: null,
		pinned: false,
		is_self: true,
		rtt_ms: 0,
		replication_mode: settings.replicationMode,
		disk_total_bytes: usage?.total ?? 0,
		disk_free_bytes: usage?.free ?? 0,
		used_bytes: usedStorageBytes(db),
		last_heartbeat_at: null,
	});

	for (const peer of db.all<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes ORDER BY created_at",
	)) {
		if (!peer.node_id || drafts.has(peer.node_id)) continue;
		drafts.set(peer.node_id, {
			node_id: peer.node_id,
			name: peer.name,
			base_url: peer.base_url,
			role: null,
			region: peer.region,
			in_generation: false,
			reachable: !!peer.active,
			eligible: null,
			pinned: !!peer.pinned_master,
			is_self: false,
			rtt_ms: peer.rtt_ms,
			replication_mode: peer.replication_mode,
			disk_total_bytes: peer.disk_total_bytes,
			disk_free_bytes: peer.disk_free_bytes,
			used_bytes: peer.used_bytes,
			last_heartbeat_at: peer.last_heartbeat_at ?? peer.last_seen_at,
		});
	}

	// The snapshot is the authority on membership, region and eligibility: those
	// are what the leader computation actually ran on, and `cluster_nodes.region`
	// is a mirror of them written at heartbeat time.
	for (const member of tiering?.snapshot ?? []) {
		let node = drafts.get(member.node_id);
		if (!node) {
			node = {
				node_id: member.node_id,
				name: member.name,
				base_url: member.base_url,
				role: null,
				region: member.region,
				in_generation: true,
				// In the snapshot but never linked here: not a node this one can
				// reach, and the graph says so rather than assuming it can.
				reachable: false,
				eligible: member.eligible,
				pinned: member.pinned,
				is_self: false,
				rtt_ms: member.rtt_ms,
				replication_mode: member.replication_mode,
				disk_total_bytes: member.disk_total_bytes,
				disk_free_bytes: 0,
				used_bytes: 0,
				last_heartbeat_at: null,
			};
			drafts.set(member.node_id, node);
		}
		node.in_generation = true;
		node.region = member.region;
		node.eligible = member.eligible;
		node.pinned = member.pinned;
	}

	// The same liveness function `pullTargets` builds, so the edges drawn here
	// are the edges this node actually pulls on.
	const reachable = (id: string) => !!drafts.get(id)?.reachable;

	const nodes: TopologyNode[] = [];
	for (const draft of drafts.values()) {
		let upstream: string | null = null;
		let fellBack = false;
		// A role is only meaningful inside the generation that computed it: a node
		// the snapshot has never seen is not a follower, it is untiered.
		const role =
			tiering && draft.in_generation ? roleOf(tiering, draft.node_id) : null;
		if (tiering && draft.in_generation) {
			upstream = upstreamOf(tiering, draft.node_id, reachable);
			const region = regionOf(tiering, draft.node_id);
			const leader = region ? (tiering.regions[region]?.leader ?? null) : null;
			// The planned edge is the region's leader; anything else while a leader
			// exists is the §5.1 fallback to the master.
			fellBack =
				!!upstream &&
				!!leader &&
				leader !== draft.node_id &&
				upstream !== leader;
		}
		nodes.push({ ...draft, role, upstream, fell_back: fellBack });
	}

	// Master first, then leaders, then by name — a stable order the client can
	// lay out from directly.
	const rank = (n: TopologyNode) =>
		n.role === "master" ? 0 : n.role === "leader" ? 1 : n.role ? 2 : 3;
	nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

	return {
		generation: tiering?.generation ?? 0,
		computed_at: tiering?.computed_at ?? null,
		reason: tiering?.reason ?? null,
		master_node_id: tiering?.master_node_id ?? null,
		self_node_id: selfId,
		nodes,
	};
}
