import { existsSync, unlinkSync } from "node:fs";
import type { AppState } from "../appState.ts";
import type { ClusterNodeRow, ContentBlobRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";

/** LRU eviction for REPLICATION_MODE=cache nodes.
 *
 * content_blobs rows are replicated everywhere (cluster/replication.ts), but
 * whether THIS node physically holds a blob's bytes is a per-node fact
 * (local_blob_cache, schema.sql). A cache-mode node treats its local disk as
 * a bounded LRU over the cluster's blob store: every locally-present blob is
 * a cache entry -- including ones uploaded directly here -- and once total
 * cached bytes exceed CACHE_MAX_BYTES, the least-recently-accessed entries
 * are evicted (bytes deleted, content_blobs row left alone -- the metadata
 * stays valid, and a later read pulls the bytes back via
 * cluster/blobs.ts's fetchBlobFromPeers).
 *
 * Deleting the only copy of a file cluster-wide would be silent data loss,
 * and this node has no location registry to know who else holds it (see
 * blobs.ts's fetch loop, which iterates peers rather than consulting one).
 * So eviction verifies durability live, right before deleting: it HEAD-checks
 * the blob against active REPLICATION_MODE=full peers and only evicts once
 * one of them confirms it already has the bytes. A blob nobody else has yet
 * is left alone -- it'll typically get pulled onto a full node by ordinary
 * read traffic soon, at which point a later eviction pass can reclaim it. */

const log = getLogger("app.cluster.cache_eviction");

export function touchBlobAccess(
	db: Db,
	blobId: number | null | undefined,
): void {
	if (!blobId) return;
	db.run(
		`INSERT INTO local_blob_cache (blob_id, last_accessed_at) VALUES ($id, $now)
     ON CONFLICT(blob_id) DO UPDATE SET last_accessed_at = excluded.last_accessed_at`,
		{ $id: blobId, $now: nowIso() },
	);
}

function fullReplicaPeers(db: Db): ClusterNodeRow[] {
	return db
		.all<ClusterNodeRow>(
			"SELECT * FROM cluster_nodes WHERE active = 1 AND replication_mode = 'full'",
		)
		.filter((n) => n.base_url && n.token);
}

/** HEAD the blob against one peer; true if that peer confirms it already has
 * these exact bytes (same stored_sha256 + transform_key). */
async function peerHasBlob(
	peer: ClusterNodeRow,
	storedSha256: string,
	transformKey: string,
): Promise<boolean> {
	const url = `${peer.base_url.replace(/\/$/, "")}/api/cluster/blobs/${storedSha256}?transform=${encodeURIComponent(transformKey)}`;
	try {
		const resp = await fetch(url, {
			method: "HEAD",
			headers: { Authorization: `Bearer ${peer.token}` },
		});
		return resp.ok;
	} catch {
		return false;
	}
}

async function confirmedElsewhere(
	peers: ClusterNodeRow[],
	blob: { stored_sha256: string; transform_key: string },
): Promise<boolean> {
	for (const peer of peers) {
		if (await peerHasBlob(peer, blob.stored_sha256, blob.transform_key))
			return true;
	}
	return false;
}

interface CacheRow extends ContentBlobRow {
	last_accessed_at: string;
}

/** Evict least-recently-used locally-cached blobs until under
 * settings.cacheMaxBytes. No-op unless this node is REPLICATION_MODE=cache
 * with a positive CACHE_MAX_BYTES configured (both opt-in -- an unset cap
 * means "don't evict", matching today's append-only behavior). */
export async function cacheEvictionJob(state: AppState): Promise<void> {
	if (state.settings.replicationMode !== "cache") return;
	const cap = state.settings.cacheMaxBytes;
	if (!(cap > 0)) return;

	const rows = state.db.all<CacheRow>(
		`SELECT cb.*, lbc.last_accessed_at as last_accessed_at
     FROM local_blob_cache lbc JOIN content_blobs cb ON cb.id = lbc.blob_id
     ORDER BY lbc.last_accessed_at ASC`,
	);
	let total = rows.reduce((sum, r) => sum + r.stored_size_bytes, 0);
	if (total <= cap) return;

	const peers = fullReplicaPeers(state.db);
	if (peers.length === 0) {
		log.warning(
			`cache over cap (${total}/${cap} bytes) but no active REPLICATION_MODE=full peer is known -- ` +
				"skipping eviction to avoid deleting the only copy of anything",
		);
		return;
	}

	let evicted = 0;
	let skipped = 0;
	for (const row of rows) {
		if (total <= cap) break;
		const ok = await confirmedElsewhere(peers, row);
		if (!ok) {
			skipped++;
			continue;
		}
		let path: string;
		try {
			path = safeJoin(storageRoot(), row.storage_path);
		} catch {
			continue;
		}
		try {
			if (existsSync(path)) unlinkSync(path);
		} catch (err) {
			log.warning(
				`failed to evict blob id=${row.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}
		state.db.run("DELETE FROM local_blob_cache WHERE blob_id = $id", {
			$id: row.id,
		});
		total -= row.stored_size_bytes;
		evicted++;
	}
	if (evicted > 0 || skipped > 0) {
		log.info(
			`cache eviction: evicted=${evicted} skipped_unconfirmed=${skipped} remaining_bytes=${total} cap=${cap}`,
		);
	}
}
