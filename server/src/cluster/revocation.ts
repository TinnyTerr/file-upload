import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import {
	applyChanges,
	type ChangeEntry,
	logHead,
	readChanges,
} from "./changelog.ts";
import { ClusterHTTPError, postJson } from "./http.ts";

/**
 * The synchronous revocation path (redesign §5.9, D-13).
 *
 * Permissions are read locally on every request, which is what keeps
 * `requirePermission` free — and it means a change to them takes effect on a
 * peer only when the change log gets there. For a **grant** that is fine: the
 * worst case is a user waiting a pull interval for a capability they are
 * entitled to. For a **revocation** it is a security hole with a stopwatch on
 * it, so the two are treated differently on purpose:
 *
 * - **Grants are lazy.** They ride the log down like every other row.
 * - **Revocations are pushed.** Removing a flag, lowering a quota, disabling an
 *   account, deleting or deactivating a share link, sealing a file: the admin
 *   call does not return until every *reachable* node has applied it, and the
 *   response names any node that did not.
 *
 * The asymmetry is the whole point: a stale grant is a security hole, a stale
 * denial is an inconvenience.
 *
 * **This is not a second replication mechanism.** What gets pushed is exactly
 * the `replication_log` entries the write already produced, applied through
 * exactly `applyChanges`. The ordinary pull re-delivers them afterwards and the
 * `UNIQUE(origin_node, origin_seq)` dedup makes that a no-op. The push is
 * delivery *earlier*, not delivery *differently* — if it fails entirely, the
 * cluster still converges, just at pull speed.
 *
 * A node that cannot be reached picks the change up from the log when it comes
 * back. Its residual exposure is a stale grant on a **read**: it cannot reach
 * the master either, so it is refusing writes anyway (§5.5).
 */

const log = getLogger("app.cluster.revocation");

/** One fan-out attempt per node, in parallel. Short on purpose: the operator is
 * waiting on this, and a node that cannot answer in five seconds is a node the
 * log will have to catch up anyway. */
const PUSH_TIMEOUT_MS = 5_000;

/** Entries per push. A revocation is a handful of rows; anything past this is a
 * bulk operation, and the pull is the right carrier for those. */
const MAX_PUSH_ENTRIES = 500;

export interface RevocationReport {
	/** Entries the write produced and this push carried. */
	pushed: number;
	/** Nodes that applied them before the call returned. */
	acknowledged: string[];
	/** Nodes that did not, and why. They converge at pull speed instead. */
	lagging: Array<{ node_id: string; name: string; reason: string }>;
}

/** Where the log stood before the revoking write. Take it *before* the write,
 * pass it to `pushRevocation` after. */
export function revocationMark(state: AppState): number {
	return logHead(state.db);
}

function peersToNotify(state: AppState): ClusterNodeRow[] {
	return state.db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.node_id && n.base_url && n.token);
}

/**
 * Deliver everything written since `mark` to every reachable peer, and wait.
 *
 * Safe to call on a single-node deployment and on a node with no peers: it
 * makes no requests and returns an empty report, so the write path pays
 * nothing for a cluster that isn't there.
 */
export async function pushRevocation(
	state: AppState,
	mark: number,
): Promise<RevocationReport> {
	const entries = readChanges(state.db, {
		after: mark,
		limit: MAX_PUSH_ENTRIES,
	});
	const report: RevocationReport = {
		pushed: entries.length,
		acknowledged: [],
		lagging: [],
	};
	if (entries.length === 0) return report;
	const peers = peersToNotify(state);
	if (peers.length === 0) return report;

	await Promise.all(
		peers.map(async (peer) => {
			try {
				const res = (await postJson(
					`${peer.base_url.replace(/\/$/, "")}/api/cluster/revocations`,
					peer.token,
					{ entries },
					PUSH_TIMEOUT_MS,
				)) as { applied?: number; halted?: { reason: string } } | null;
				if (res?.halted) {
					report.lagging.push({
						node_id: peer.node_id!,
						name: peer.name,
						reason: res.halted.reason,
					});
					return;
				}
				report.acknowledged.push(peer.node_id!);
			} catch (err) {
				const reason =
					err instanceof ClusterHTTPError ? err.message : String(err);
				report.lagging.push({
					node_id: peer.node_id!,
					name: peer.name,
					reason,
				});
			}
		}),
	);

	if (report.lagging.length > 0) {
		log.warning(
			`revocation of ${entries.length} change(s) not acknowledged by: ` +
				report.lagging.map((n) => `${n.name} (${n.reason})`).join(", "),
		);
	}
	return report;
}

/** The receiving half: apply a pushed batch out of band.
 *
 * The cursor `applyChanges` returns is deliberately discarded — these entries
 * did not come from the peer's ordinary stream, and moving a cursor for them
 * would claim this node had read past things it has not seen. The pull
 * re-delivers them in order later and dedups.
 */
export function applyPushedRevocation(
	state: AppState,
	entries: ChangeEntry[],
): { applied: number; halted?: { seq: number; reason: string } } {
	const result = applyChanges(state.db, entries, 0);
	return { applied: result.applied, halted: result.halted };
}
