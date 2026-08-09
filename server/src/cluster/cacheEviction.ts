import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { fetchLogged } from "../outbound.ts";
import {
	copyCount,
	gcOrphanChunks,
	holdersOf,
	localNodeId,
	markChunk,
	reclaimChunk,
	reconcileLocalChunks,
	replicationFactor,
} from "./placement.ts";

/** LRU chunk eviction for REPLICATION_MODE=cache nodes (redesign §5.11).
 *
 * A cache node treats its disk as a bounded cache over the cluster's chunk
 * store, and Phase 8 changes three things about how that works:
 *
 * - **The unit is a chunk, not a blob.** A node can hold and drop part of a
 *   file, which is what lets a small node serve a large one.
 * - **`pinned` chunks are exempt.** Those are the durability copies placement
 *   put here (`cluster/placement.ts`), and they are not cache. Evicting them
 *   to make room for cache would delete the copy the replication factor just
 *   went to the trouble of placing. `CACHE_MAX_BYTES` therefore caps the
 *   *unpinned* bytes only.
 * - **Durability is a table read.** `chunk_locations` already says how many
 *   nodes hold these bytes, so the pass checks the registry first and spends
 *   exactly one HEAD confirming the copy it intends to rely on — rather than
 *   the N-peer walk per blob this file used to do (D6). The HEAD stays because
 *   a registry row is a claim about somebody else's disk, and deleting the
 *   last copy of anything on the strength of a stale row is not a mistake that
 *   can be undone.
 *
 * The GC half runs on every node, cache or not: a location row for a chunk no
 * manifest references any more names bytes that went with their blob, and
 * leaving it would make this node a source for a fetch that can only fail.
 */

const log = getLogger("app.cluster.cache_eviction");

function reachablePeers(state: AppState): ClusterNodeRow[] {
	return state.db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.base_url && n.token);
}

/** One HEAD against a node the registry says holds the chunk. True only if it
 * confirms. Anything else — 404, a timeout, a refused connection — reads as
 * "cannot confirm", which is what keeps the bytes here. */
async function peerHasChunk(
	peer: ClusterNodeRow,
	sha256: string,
): Promise<boolean> {
	const url = `${peer.base_url.replace(/\/$/, "")}/api/cluster/chunks/${sha256}`;
	try {
		const resp = await fetchLogged("cluster", url, {
			method: "HEAD",
			headers: { Authorization: `Bearer ${peer.token}` },
		});
		return resp.ok;
	} catch {
		return false;
	}
}

interface EvictionCandidate {
	chunk_sha256: string;
	size_bytes: number;
	last_read_at: string | null;
}

export async function cacheEvictionJob(state: AppState): Promise<void> {
	const db = state.db;
	const nodeId = localNodeId(db);
	if (!nodeId) return;

	// Housekeeping first, and on every node: it is what keeps the registry from
	// advertising bytes that are gone, and it can only ever free space.
	gcOrphanChunks(db);
	reconcileLocalChunks(state);

	if (state.settings.replicationMode !== "cache") return;
	const cap = state.settings.cacheMaxBytes;
	if (!(cap > 0)) return;

	const rows = db.all<EvictionCandidate>(
		`SELECT cl.chunk_sha256, cl.size_bytes, lcc.last_read_at
       FROM chunk_locations cl
       LEFT JOIN local_chunk_cache lcc ON lcc.chunk_sha256 = cl.chunk_sha256
      WHERE cl.node_id = $node AND cl.state = 'present' AND cl.pinned = 0
      ORDER BY lcc.last_read_at IS NULL DESC, lcc.last_read_at ASC`,
		{ $node: nodeId },
	);
	let total = rows.reduce((sum, r) => sum + r.size_bytes, 0);
	if (total <= cap) return;

	const factor = replicationFactor(state);
	const peers = reachablePeers(state);
	let evicted = 0;
	let skipped = 0;
	for (const row of rows) {
		if (total <= cap) break;
		// `copyCount` counts this node too, so the durability requirement is
		// "the factor's worth of copies survive losing this one".
		if (copyCount(db, row.chunk_sha256) <= factor) {
			skipped++;
			continue;
		}
		// The witness has to be a node the registry names as a holder — asking
		// an arbitrary peer would confirm nothing about these bytes.
		const holders = new Set(
			holdersOf(db, row.chunk_sha256, { exclude: nodeId }),
		);
		const witness = peers.find(
			(peer) => peer.node_id && holders.has(peer.node_id),
		);
		if (!witness || !(await peerHasChunk(witness, row.chunk_sha256))) {
			skipped++;
			continue;
		}
		const { freed } = reclaimChunk(db, nodeId, row.chunk_sha256);
		if (freed === 0) {
			// The bytes are a hole inside a file that has to stay and the
			// filesystem would not punch it. Recording an eviction that freed
			// nothing would leave the cache believing it is under a cap the disk
			// says it is over.
			skipped++;
			continue;
		}
		markChunk(db, nodeId, row.chunk_sha256, {
			state: "evicted",
			size: row.size_bytes,
		});
		db.run("DELETE FROM local_chunk_cache WHERE chunk_sha256 = $sha", {
			$sha: row.chunk_sha256,
		});
		total -= row.size_bytes;
		evicted++;
	}
	if (evicted > 0 || skipped > 0) {
		log.info(
			`chunk cache eviction: evicted=${evicted} skipped=${skipped} cached_bytes=${total} cap=${cap}`,
		);
	}
}
