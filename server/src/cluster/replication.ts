import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import {
	applyChanges,
	type ChangeEntry,
	getCursor,
	type PullDirection,
	setCursor,
} from "./changelog.ts";
import { ClusterHTTPError, getJson } from "./http.ts";
import { currentTiering, upstreamOf } from "./tiering.ts";

/**
 * Shipping the change log between nodes (redesign §5.7).
 *
 * Replication is a **pull**, one cursor per peer per direction, and the entries
 * are whatever `cluster/changelog.ts` recorded — this file knows nothing about
 * files, folders or users, which is exactly why deletes, renames, moves,
 * permission edits, link revocations and lifecycle transitions all propagate
 * now without a single route handler mentioning replication (B5).
 *
 * What this replaced: an announce-the-id protocol where an upload handler
 * reserved `files.id` on every peer, pushed a hand-assembled bundle of related
 * rows, and on collision pulled the master's entire table set to overwrite
 * local divergence. It shipped two of the ~40 mutations that needed shipping,
 * it could not represent a delete at all, and its conflict case was a
 * full-database rebase (B4, B5, D4). None of that survives; row identity is a
 * ULID now (§5.6), so the collision it existed to detect cannot happen.
 *
 * Topology (§5.1, live since Phase 4): strictly hierarchical, and derived
 * entirely from the tiering generation. Every node pulls **down** from its
 * upstream — a follower from its region leader, a leader from the master — and
 * **up** from everyone whose upstream is itself. Two rules, one function
 * (`upstreamOf`), and the mesh falls out of them.
 *
 * A follower does not pull from a sibling: its writes reach that peer by going
 * up to the master and back down, which is what keeps the master's log the
 * canonical order. A follower whose leader has gone quiet pulls from the master
 * directly — the region leader is a relay and a cache, not an authority, so
 * losing it degrades latency rather than capability.
 */

const log = getLogger("app.cluster.replication");

/** One request's worth of entries. Matches the firehose consumer's batch size;
 * a pull that fills it is followed immediately by another rather than waiting
 * for the next tick. */
const PULL_LIMIT = 500;

const PULL_TIMEOUT_MS = 20_000;

/** Consecutive full batches before a single tick gives up and lets the next
 * one continue. Bounds how long a node that is far behind can hold the job. */
const MAX_BATCHES_PER_TICK = 20;

interface Peer {
	nodeId: string;
	baseUrl: string;
	token: string;
}

interface ChangesResponse {
	entries?: ChangeEntry[];
	last_seq?: number;
	head?: number;
}

function activePeers(db: AppState["db"]): Peer[] {
	return db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.node_id && n.base_url && n.token)
		.map((n) => ({
			nodeId: n.node_id!,
			baseUrl: n.base_url.replace(/\/$/, ""),
			token: n.token,
		}));
}

export interface PullOutcome {
	peer: string;
	applied: number;
	cursor: number;
	halted?: string;
	unreachable?: boolean;
}

/** Pull one peer's log from where we left off and apply it.
 *
 * The cursor only ever advances past entries that actually landed
 * (`applyChanges` halts rather than skipping), so a peer whose entry we cannot
 * apply yet is retried on the next tick instead of leaving a permanent hole. */
export async function pullFromPeer(
	state: AppState,
	peer: Peer,
	direction: PullDirection,
): Promise<PullOutcome> {
	const { db } = state;
	let applied = 0;
	for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
		const after = getCursor(db, peer.nodeId, direction);
		let payload: ChangesResponse | null;
		try {
			payload = (await getJson(
				`${peer.baseUrl}/api/cluster/changes?after=${after}&limit=${PULL_LIMIT}`,
				peer.token,
				PULL_TIMEOUT_MS,
			)) as ChangesResponse;
		} catch (err) {
			const reason =
				err instanceof ClusterHTTPError ? err.message : String(err);
			log.debug(
				`replication pull ${direction} from ${peer.nodeId}: peer unreachable (${reason}); cursor stays at ${after}`,
			);
			return { peer: peer.nodeId, applied, cursor: after, unreachable: true };
		}
		const entries = payload?.entries ?? [];
		if (entries.length === 0) {
			return { peer: peer.nodeId, applied, cursor: after };
		}
		const result = applyChanges(db, entries, after);
		applied += result.applied;
		if (result.cursor !== after) {
			setCursor(db, peer.nodeId, direction, result.cursor);
		}
		if (result.halted) {
			return {
				peer: peer.nodeId,
				applied,
				cursor: result.cursor,
				halted: result.halted.reason,
			};
		}
		if (result.applied > 0) {
			log.info(
				`replication pull ${direction} from ${peer.nodeId}: applied ${result.applied} change(s), cursor ${after} -> ${result.cursor}`,
			);
		}
		if (entries.length < PULL_LIMIT) {
			return { peer: peer.nodeId, applied, cursor: result.cursor };
		}
	}
	return {
		peer: peer.nodeId,
		applied,
		cursor: getCursor(db, peer.nodeId, direction),
	};
}

/** Every peer this node pulls from, and in which direction.
 *
 * `down` from this node's own upstream; `up` from every active peer that has
 * this node as *its* upstream. Because both sides are computed from the same
 * `upstreamOf` over the same generation, the two halves of every edge agree
 * without negotiating.
 *
 * A node that cannot resolve an upstream pulls from nobody — deliberately, and
 * that includes a node holding no tiering generation at all. Guessing at a peer
 * to sync from is how two halves of a partition converge on different answers,
 * and D-2 already says that a node which cannot reach the master degrades
 * rather than improvises. */
export function pullTargets(
	state: AppState,
): Array<{ peer: Peer; direction: PullDirection }> {
	const tiering = currentTiering(state.db);
	if (!tiering) return [];
	const selfId = state.settings.nodeId;
	const peers = new Map(activePeers(state.db).map((p) => [p.nodeId, p]));
	// This node's own liveness observation, used for both halves of every edge.
	// Both ends read the same generation and, when they agree about who is
	// reachable, derive the same edges — so the fallback below does not need to
	// be negotiated. When they disagree, the worst case is one redundant or one
	// missing pull for as long as the disagreement lasts, which the next
	// heartbeat resolves.
	const reachable = (id: string) => id === selfId || peers.has(id);
	const targets: Array<{ peer: Peer; direction: PullDirection }> = [];

	const upstream = upstreamOf(tiering, selfId, reachable);
	if (upstream) {
		const peer = peers.get(upstream);
		if (peer) targets.push({ peer, direction: "down" });
	}
	for (const member of tiering.snapshot) {
		if (member.node_id === selfId) continue;
		if (upstreamOf(tiering, member.node_id, reachable) !== selfId) continue;
		const peer = peers.get(member.node_id);
		if (peer) targets.push({ peer, direction: "up" });
	}
	return targets;
}

/** The `cluster_replication_pull` scheduler job. A no-op with no peers, so it
 * costs a single-node deployment nothing. */
export async function replicationPullJob(
	state: AppState,
): Promise<PullOutcome[]> {
	const tiering = currentTiering(state.db);
	const masterId = tiering?.master_node_id ?? null;
	const targets = pullTargets(state);
	const outcomes: PullOutcome[] = [];
	for (const { peer, direction } of targets) {
		const outcome = await pullFromPeer(state, peer, direction);
		outcomes.push(outcome);
		// This job runs once a second against the master (directly, or through a
		// leader that is itself pulling from it), so it is by far the freshest
		// signal of master reachability available -- much fresher than the
		// 1-minute heartbeat. Feeding §5.5's grace timer from it is free.
		if (peer.nodeId === masterId && masterId !== state.settings.nodeId) {
			if (outcome.unreachable) state.masterReachability.noteFailure();
			else state.masterReachability.confirmContact();
		}
	}
	return outcomes;
}
