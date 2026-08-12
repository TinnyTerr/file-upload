import { existsSync, statSync } from "node:fs";
import type { AppState } from "../appState.ts";
import type { ContentBlobRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { hashFile } from "../storage/blobs.ts";
import {
	blobCompleteLocally,
	blobPath,
	type ChunkDigest,
	type ChunkSlot,
	chunkSize,
	localNodeId,
	manifestOf,
	rechunkBlob,
} from "./placement.ts";
import { isMaster } from "./tiering.ts";

/**
 * R-2's second half: the background pass that splits a legacy whole-file
 * manifest into a real one (redesign §5.11, Part 8 R-2).
 *
 * Phase 8 chose non-disruption at the cutover — a blob that predates chunking
 * is recorded as a single chunk covering its whole file, which costs nothing
 * because that chunk's hash *is* its `stored_sha256`. The cost is deferred
 * rather than avoided: until it is split, a 40 GiB legacy blob is one 40 GiB
 * chunk, so it can only be placed on a node with 40 GiB free, only fetched
 * whole, and only evicted whole. Everything Phase 8 bought applies to new
 * writes and to nothing already on disk. This is the pass that retires that
 * distinction, at a byte budget per tick rather than in one afternoon.
 *
 * It lives in its own file because `storage/blobs.ts` already imports
 * `placement.ts` for `chunkSize`/`recordManifest`, so the module that needs
 * `hashFile` cannot be `placement.ts` without a cycle.
 *
 * **Master-only, for the same reason the seed is.** A manifest has one writer
 * cluster-wide (`placement.ts::recordManifest`); two nodes re-splitting the
 * same blob would ship two sets of `(blob_id, idx)` rows to every peer, and
 * neither natural key carries a UNIQUE constraint to catch it.
 *
 * **It also fixes a manifest the seed got wrong.** `jobs/lifecycle.ts` never
 * rewrites `content_blobs.stored_sha256` when it archives a blob — the column
 * stays the identity the blob was minted for, which is exactly why archived
 * blobs are excluded from dedup matching. So for a blob archived *before*
 * Phase 8 the seed's free hash describes bytes that no longer exist, and every
 * peer fetching that chunk fails its verification forever with no fallback
 * (`cluster/blobs.ts` only walks the whole blob when there is no manifest at
 * all). `seedLegacyManifests` now leaves archived blobs alone, and this pass
 * gives them a manifest of hashes read off the bytes that are actually there.
 *
 * **Nothing about the bytes changes.** A manifest describes a file; re-cutting
 * it moves no data and touches no reader. A peer holding the blob keeps
 * serving it throughout, because with its old location row orphaned and no new
 * one yet `holdsChunkLocally` falls through to the file-length rule, and the
 * `cluster_cache_eviction` tick reconciles it — `gcOrphanChunks` before
 * `reconcileLocalChunks`, so both halves land in one pass.
 */

const log = getLogger("app.cluster.rechunk");

/** Bytes read per tick. Splitting a manifest is a full read of the file, and
 * it is migration work nobody is waiting on: hourly ticks at this budget
 * converge a legacy corpus over days without ever making the disk somebody
 * else's problem. */
const BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

/** Blobs whose manifest does not describe them properly.
 *
 * Three shapes, and they are the only three: a whole-file chunk over a blob
 * that should be several (the ordinary legacy blob), an archived blob carrying
 * the seed's `stored_sha256` as a chunk hash (a manifest of bytes that no
 * longer exist), and an archived blob with no manifest at all (what the seed
 * now leaves behind). Largest first — the blob that gains the most from being
 * split is the one splitting costs the most, and a pass that is interrupted
 * has still done the work that mattered. */
export function rechunkCandidates(db: Db, limit = 20): ContentBlobRow[] {
	return db.all<ContentBlobRow>(
		`SELECT cb.* FROM content_blobs cb
      WHERE cb.stored_sha256 <> ''
        AND (
          (cb.stored_size_bytes > $size
           AND (SELECT COUNT(*) FROM blob_chunks bc WHERE bc.blob_id = cb.id) = 1
           AND EXISTS (SELECT 1 FROM blob_chunks bc
                        WHERE bc.blob_id = cb.id
                          AND bc.size_bytes = cb.stored_size_bytes))
          OR (cb.archived = 1
              AND EXISTS (SELECT 1 FROM blob_chunks bc
                           WHERE bc.blob_id = cb.id
                             AND bc.chunk_sha256 = cb.stored_sha256))
          OR (cb.archived = 1
              AND NOT EXISTS (SELECT 1 FROM blob_chunks bc WHERE bc.blob_id = cb.id))
        )
      ORDER BY cb.stored_size_bytes DESC LIMIT ${limit}`,
		{ $size: chunkSize() },
	);
}

function sameManifest(existing: ChunkSlot[], fresh: ChunkDigest[]): boolean {
	return (
		existing.length === fresh.length &&
		existing.every(
			(slot, i) =>
				slot.sha256 === fresh[i]?.sha256 && slot.size === fresh[i]?.size,
		)
	);
}

/** Re-cut one blob's manifest. Returns the bytes read, which is what the
 * tick's budget is spent in — a candidate that had to be skipped after the
 * read still cost the read. */
async function rechunkOne(
	state: AppState,
	blob: ContentBlobRow,
): Promise<{ read: number; rewrote: boolean }> {
	const db = state.db;
	const path = blobPath(blob);
	if (!path || !existsSync(path)) return { read: 0, rewrote: false };
	// Only a node holding the whole file can hash it, and a partial holding
	// would hash a sparse file's zeroes into a manifest every other node then
	// believes. The master holds a full copy by construction (§5.3); this is
	// what happens when it doesn't.
	if (!blobCompleteLocally(db, localNodeId(db), blob, path)) {
		return { read: 0, rewrote: false };
	}
	const before = statSync(path);
	const hashed = await hashFile(path);
	const read = before.size;

	// The archive job rewrites a blob's bytes in place -- compress to a temp
	// file, rename over the same path (`jobs/lifecycle.ts`) -- and it may have
	// done so while this read was in flight. Recording a manifest of bytes that
	// have since been replaced is the one way this pass could make a blob
	// permanently unfetchable, so the row and the file are both re-read and
	// anything that moved abandons the attempt. It runs again next tick.
	const current = db.get<ContentBlobRow>(
		"SELECT * FROM content_blobs WHERE id = $id",
		{ $id: blob.id },
	);
	if (!current || !existsSync(path)) return { read, rewrote: false };
	const after = statSync(path);
	const total = hashed.chunks.reduce((n, chunk) => n + chunk.size, 0);
	if (
		current.storage_path !== blob.storage_path ||
		current.archived !== blob.archived ||
		current.stored_size_bytes !== total ||
		after.size !== before.size ||
		after.mtimeMs !== before.mtimeMs
	) {
		log.info(
			`blob ${blob.stored_sha256.slice(0, 12)} changed while being rechunked; leaving it`,
		);
		return { read, rewrote: false };
	}
	// A blob that is not archived still holds the bytes its identity was minted
	// for, so the read can be checked against that identity outright. An
	// archived one cannot be: `stored_sha256` describes its pre-archive bytes,
	// which is the whole reason its seeded manifest needs replacing.
	if (!current.archived && hashed.sha256 !== current.stored_sha256) {
		log.warning(
			`blob ${blob.stored_sha256.slice(0, 12)} hashes as ${hashed.sha256.slice(0, 12)} on disk; not rechunking`,
		);
		return { read, rewrote: false };
	}
	if (sameManifest(manifestOf(db, blob.id), hashed.chunks)) {
		return { read, rewrote: false };
	}
	rechunkBlob(db, blob.id, hashed.chunks);
	return { read, rewrote: true };
}

export async function rechunkLegacyJob(state: AppState): Promise<void> {
	if (!isMaster(state)) return;
	if (!localNodeId(state.db)) return;
	let budget = BUDGET_BYTES;
	let rewrote = 0;
	for (const blob of rechunkCandidates(state.db)) {
		if (budget <= 0) break;
		const result = await rechunkOne(state, blob);
		budget -= result.read;
		if (result.rewrote) rewrote++;
	}
	if (rewrote > 0) {
		log.info(`rechunked ${rewrote} legacy blob(s) into per-chunk manifests`);
	}
}
