/** What this node says about itself, to a peer and to the dashboard.
 *
 * Its own file because Phase 9 split the cluster router in two and both halves
 * need it: `/ping`, `/heartbeat` and `/join` answer with it over the
 * node-to-node surface, and `/self` builds the operator's view on top of it.
 * Keeping one producer is what stops the two surfaces from drifting into
 * describing the same node differently. */

import type { AppState } from "../appState.ts";
import { diskUsageBytes, usedStorageBytes } from "../storage/accounting.ts";
import { chunkStorageStats } from "./placement.ts";
import { currentTiering, regionOf, selfRole } from "./tiering.ts";

export function selfStats(state: AppState) {
	const usage = diskUsageBytes();
	const tiering = currentTiering(state.db);
	const role = selfRole(state);
	const masterId = tiering?.master_node_id ?? null;
	const masterUrl =
		masterId === state.settings.nodeId
			? state.settings.nodeUrl
			: (tiering?.snapshot.find((m) => m.node_id === masterId)?.base_url ??
				null);
	return {
		node_id: state.settings.nodeId,
		name: state.settings.nodeName,
		is_master: role === "master",
		archive_enabled: state.settings.archiveEnabled,
		replication_mode: state.settings.replicationMode,
		disk_total_bytes: usage?.total ?? 0,
		disk_free_bytes: usage?.free ?? 0,
		used_bytes: usedStorageBytes(state.db),
		role,
		region: tiering ? regionOf(tiering, state.settings.nodeId) : null,
		tiering_generation: tiering?.generation ?? 0,
		master_node_id: masterId,
		master_node_url: masterUrl,
		// Pinned and cached kept apart, deliberately (§5.11): they are what makes
		// REPLICATION_MODE=cache legible, and the panel conflating them is part of
		// why it has not been.
		chunk_storage: chunkStorageStats(state),
		// The whole record, so a peer's handshake either learns nothing new or
		// adopts a newer generation without a second request (cluster/tiering.ts).
		tiering,
	};
}
