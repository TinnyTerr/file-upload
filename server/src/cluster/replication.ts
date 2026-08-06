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
import { getSelfState } from "./election.ts";
import { ClusterHTTPError, getJson } from "./http.ts";

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
 * Topology, for as long as the region tier is dormant (Phase 4 adds it):
 * the master pulls **up** from every peer, everyone else pulls **down** from
 * the master. A follower does not pull from another follower — its writes
 * reach that peer by going up to the master and back down, which is what keeps
 * the master's log the canonical order.
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
 * A follower with no resolved master pulls from nobody — deliberately. Guessing
 * at a peer to sync from is how two halves of a partition converge on different
 * answers, and D-2 already says that a node which cannot reach the master
 * degrades rather than improvises. */
export function pullTargets(
	state: AppState,
): Array<{ peer: Peer; direction: PullDirection }> {
	const self = getSelfState(state.db);
	if (self.role === "master") {
		return activePeers(state.db).map((peer) => ({
			peer,
			direction: "up" as const,
		}));
	}
	const masterId = self.current_master_id;
	if (!masterId) return [];
	const peer = activePeers(state.db).find((p) => p.nodeId === masterId);
	return peer ? [{ peer, direction: "down" as const }] : [];
}

/** The `cluster_replication_pull` scheduler job. A no-op with no peers, so it
 * costs a single-node deployment nothing. */
export async function replicationPullJob(
	state: AppState,
): Promise<PullOutcome[]> {
	const targets = pullTargets(state);
	const outcomes: PullOutcome[] = [];
	for (const { peer, direction } of targets) {
		outcomes.push(await pullFromPeer(state, peer, direction));
	}
	return outcomes;
}
