import { createHash } from "node:crypto";
import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { ensureStorageSettings } from "../storage/accounting.ts";
import { ClusterHTTPError, getJson } from "./http.ts";
import { currentTiering, selfRole } from "./tiering.ts";

/** Mirrors app/api/cluster/digest.py. */

const log = getLogger("app.cluster.digest");

export interface ClusterDigest {
	hash: string;
	global_quota: number;
	members: string[];
	role: string;
	/** The tiering generation this node holds. Reported, not hashed: it
	 * legitimately lags by a heartbeat on a node that has not been told yet. */
	generation: number;
}

/** A small, comparable summary of state that SHOULD be identical on every
 * node: the shared global storage cap and the membership set (in a full
 * mesh every node should know the same node_ids). Counts that legitimately
 * differ per-node (each node's own files) are deliberately excluded --
 * adding them would produce permanent false "mismatch" alerts. */
export function computeDigest(state: AppState): ClusterDigest {
	const storage = ensureStorageSettings(state.db);
	const globalQuota = Number(storage.global_storage_quota_bytes);
	const peerIds = state.db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.map((n) => n.node_id)
		.filter((id): id is string => !!id);
	const members = [...new Set([state.settings.nodeId, ...peerIds])].sort();
	// role/generation are deliberately excluded from the hash -- role
	// legitimately differs per node, and a generation legitimately lags on a
	// node that has not been told about the newest one yet.
	const body = { global_quota: globalQuota, members };
	const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	return {
		hash,
		...body,
		role: selfRole(state),
		generation: currentTiering(state.db)?.generation ?? 0,
	};
}

/** Compare this node's digest against every peer's and alert on divergence.
 * Emits a `cluster.sync_mismatch` event and a warning log for each
 * disagreeing peer. Returns the number of mismatches found. */
export async function syncCheckJob(state: AppState): Promise<number> {
	const local = computeDigest(state);
	const targets = state.db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.base_url && n.token);

	let mismatches = 0;
	for (const node of targets) {
		let remote: ClusterDigest | null = null;
		try {
			remote = (await getJson(
				`${node.base_url.replace(/\/$/, "")}/api/cluster/digest`,
				node.token,
				10_000,
			)) as ClusterDigest;
		} catch (err) {
			if (err instanceof ClusterHTTPError) {
				log.debug(`digest fetch failed for ${node.base_url}: ${err.message}`);
			}
			continue;
		}
		if (!remote || remote.hash !== local.hash) {
			mismatches++;
			log.warning(
				`cluster sync mismatch node=${node.node_id ?? node.id} local=${JSON.stringify(local)} remote=${JSON.stringify(remote)}`,
			);
			try {
				state.eventBus.publish({
					action: "cluster.sync_mismatch",
					actor: "system",
					target: `node:${node.node_id ?? node.id}`,
					kind: "system",
					local_hash: local.hash,
					remote_hash: remote?.hash ?? null,
				});
			} catch {
				// best-effort
			}
		}
		// There is no split-brain cross-check here any more, and its absence is
		// the point. Two nodes could both hold role=master only because role was
		// something a node *decided*; it is now derived from a generation only the
		// master mints, so "both believe they are master" is not a state the data
		// model can express. Phase 4 deleted the check along with the elections
		// that made it necessary.
	}
	return mismatches;
}
