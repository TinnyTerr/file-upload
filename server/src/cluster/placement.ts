import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AppState } from "../appState.ts";
import { configValue } from "../config.ts";
import type {
	BlobChunkRow,
	ChunkLocationRow,
	ChunkState,
	ClusterNodeRow,
	ContentBlobRow,
} from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { fetchLogged } from "../outbound.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";

/**
 * Chunk manifests, the location registry and placement (redesign §5.11).
 *
 * Phase 8 in one sentence: a blob stops being an indivisible object and
 * becomes a manifest over content-addressed chunks of its *stored* bytes, and
 * which node holds which chunk becomes a replicated table instead of a
 * question you answer by asking every peer in turn (D6).
 *
 * Three things follow, and they are the phase's whole point:
 *
 * - **A node can hold part of a file.** A 40 GiB blob is 2,560 chunks and any
 *   node with 16 MiB free can hold one, so a small node contributes real
 *   capacity toward files far larger than its disk instead of being unable to
 *   participate (D-10). Its contribution degrades smoothly as it fills rather
 *   than falling off a cliff at "largest file it can hold".
 * - **Bytes are pushed, not merely pulled.** `chunkReplicationJob` places
 *   `REPLICATION_FACTOR` copies of every chunk without waiting for somebody to
 *   download it, which is what finally makes cache mode safe (B10): before
 *   this, a cache node could never evict, because nothing had ever guaranteed
 *   a second copy existed.
 * - **Eviction is a table lookup.** Durability is read off `chunk_locations`
 *   and confirmed with one HEAD, rather than an N-peer walk per blob (D6).
 *
 * **The bytes are not a separate object store.** A chunk is a byte range of
 * the blob's file at `content_blobs.storage_path` — a column that replicates,
 * so every node agrees on the path — and a node holding a subset holds a
 * sparse file. A node holding all of them holds exactly the file every
 * existing read path already opens, which is what makes this an addition to
 * the read path rather than a rewrite of it.
 *
 * **The registry is the truth about partial holdings, the file is the truth
 * about complete ones.** A sparse file's *size* reaches the end of the highest
 * chunk written, so size alone cannot tell a complete blob from one with
 * holes. The rule (`holdsChunkLocally`) is therefore: if this node has any
 * location row for the chunk, believe it; if it has none at all, believe a
 * file whose length matches `stored_size_bytes`. A node only ever acquires a
 * partial blob through a fetch or a push, and both write rows.
 */

const log = getLogger("app.cluster.placement");

/** 16 MiB, matching the chunked-upload size — which is already a whole
 * multiple of the AEAD container's 2 MiB plaintext frame, so a chunk boundary
 * never bisects a GCM frame. `routes/files.ts::chunkUploadSize` delegates
 * here: one definition, or the boundary an upload session commits at and the
 * boundary the manifest records could disagree. */
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

export function chunkSize(): number {
	const raw = configValue("FILEUPLOAD_CHUNK_SIZE");
	if (raw) {
		const v = Number(raw);
		if (v > 0) return v;
	}
	return DEFAULT_CHUNK_SIZE;
}

/** Read from `replication_control` rather than taken as an argument: this is
 * the node identity the change-log triggers already stamp on every entry, so
 * a location row and the log entry announcing it can never disagree about who
 * "this node" is. Empty until `setNodeIdentity` has run, which is exactly when
 * nothing should be recording locations either. */
export function localNodeId(db: Db): string {
	return (
		db.get<{ node_id: string }>(
			"SELECT node_id FROM replication_control WHERE id = 1",
		)?.node_id ?? ""
	);
}

// ── manifests ───────────────────────────────────────────────────────────────

export interface ChunkDigest {
	sha256: string;
	size: number;
}

/** A manifest entry resolved to where its bytes live in the blob's file. */
export interface ChunkSlot extends ChunkDigest {
	idx: number;
	offset: number;
}

/** The byte ranges a blob of `total` bytes splits into. Exported for the
 * tests and for callers that need the boundaries without a manifest. */
export function planChunks(
	total: number,
	size = chunkSize(),
): Array<{ offset: number; size: number }> {
	if (total <= 0 || size <= 0) return [];
	const out: Array<{ offset: number; size: number }> = [];
	for (let offset = 0; offset < total; offset += size) {
		out.push({ offset, size: Math.min(size, total - offset) });
	}
	return out;
}

/** Offsets are derived from the manifest's own sizes rather than from
 * `idx * chunkSize()`: a blob chunked under a different `FILEUPLOAD_CHUNK_SIZE`
 * — or a legacy blob recorded as one whole-file chunk (R-2) — still resolves
 * correctly, and a node that later changes the setting doesn't silently start
 * reading at the wrong offset. */
export function manifestOf(db: Db, blobId: number): ChunkSlot[] {
	const rows = db.all<BlobChunkRow>(
		"SELECT * FROM blob_chunks WHERE blob_id = $id ORDER BY idx",
		{ $id: blobId },
	);
	let offset = 0;
	return rows.map((row) => {
		const slot: ChunkSlot = {
			idx: row.idx,
			sha256: row.chunk_sha256,
			size: row.size_bytes,
			offset,
		};
		offset += row.size_bytes;
		return slot;
	});
}

/** Record a blob's manifest, once.
 *
 * A no-op when the blob already has one, and that is load-bearing rather than
 * defensive: `blob_chunks` replicates, so a manifest minted a second time —
 * on a dedup hit, or by two nodes both backfilling the same legacy blob —
 * would land on every peer as a *second* set of rows for the same (blob, idx).
 * One writer per manifest is what keeps the natural key unique without a
 * constraint whose violation would halt a replication batch. */
export function recordManifest(
	db: Db,
	blobId: number,
	chunks: ChunkDigest[],
): boolean {
	if (chunks.length === 0) return false;
	const existing = db.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM blob_chunks WHERE blob_id = $id",
		{ $id: blobId },
	);
	if ((existing?.n ?? 0) > 0) return false;
	const now = nowIso();
	db.transaction(() => {
		chunks.forEach((chunk, idx) => {
			db.run(
				`INSERT INTO blob_chunks (blob_id, idx, chunk_sha256, size_bytes, created_at)
         VALUES ($blob, $idx, $sha, $size, $now)`,
				{
					$blob: blobId,
					$idx: idx,
					$sha: chunk.sha256,
					$size: chunk.size,
					$now: now,
				},
			);
		});
	});
	return true;
}

/** Drop and re-record a manifest whose bytes were rewritten underneath it.
 *
 * The archive job compresses a blob's file in place (`ZSTD(ENC(x))`), so every
 * chunk hash it had is now wrong. Nothing else rewrites stored bytes without
 * minting a new blob. */
export function replaceManifest(
	db: Db,
	blobId: number,
	chunks: ChunkDigest[],
): void {
	db.run("DELETE FROM blob_chunks WHERE blob_id = $id", { $id: blobId });
	recordManifest(db, blobId, chunks);
}

/** Re-record the manifest of a blob whose bytes were rewritten in place, and
 * keep this node's copy classified as whatever it already was.
 *
 * The archive job is the only thing that rewrites stored bytes without minting
 * a new blob (`jobs/lifecycle.ts`), so it is the only caller — but it is not
 * optional: every hash in the old manifest describes bytes that no longer
 * exist, and a peer fetching against it would fail its verification forever.
 * Whether the local copy was pinned is preserved rather than re-derived, or
 * archiving a file on a cache node would quietly promote it out of the cache. */
export function rechunkBlob(
	db: Db,
	blobId: number,
	chunks: ChunkDigest[],
): void {
	const nodeId = localNodeId(db);
	const wasPinned = !!db.get<{ id: number }>(
		`SELECT cl.id FROM chunk_locations cl
       JOIN blob_chunks bc ON bc.chunk_sha256 = cl.chunk_sha256
      WHERE bc.blob_id = $blob AND cl.node_id = $node AND cl.pinned = 1 LIMIT 1`,
		{ $blob: blobId, $node: nodeId },
	);
	replaceManifest(db, blobId, chunks);
	markBlobLocal(db, blobId, { pinned: wasPinned });
}

/** The manifest for a blob that predates chunking: one chunk covering the
 * whole file. Free — a legacy blob's single chunk hash *is* its
 * `stored_sha256`, so nothing has to be read to record it.
 *
 * R-2's answer: legacy blobs are non-disruptive rather than rechunked at the
 * cutover. The cost is that they are still transferred whole, and
 * `cluster/rechunk.ts` is the background pass that pays it off later.
 *
 * **Archived blobs are excluded, because for them the free hash is wrong.**
 * `jobs/lifecycle.ts` compresses a blob's bytes in place without rewriting
 * `stored_sha256` — the column stays the identity the blob was minted for,
 * which is why archived blobs are excluded from dedup matching too. Seeding it
 * as a chunk hash would describe bytes that no longer exist, and a peer
 * fetching against it would fail its verification forever with no fallback.
 * Left with no manifest at all they fall back to the whole-blob walk
 * (`cluster/blobs.ts::fetchBlobFromPeers`) until the rechunk pass reads their
 * real hashes off the disk. */
export function seedLegacyManifests(db: Db, limit = 500): number {
	const blobs = db.all<ContentBlobRow>(
		`SELECT * FROM content_blobs cb
      WHERE cb.stored_sha256 <> '' AND cb.archived = 0
        AND NOT EXISTS (SELECT 1 FROM blob_chunks bc WHERE bc.blob_id = cb.id)
      ORDER BY cb.id LIMIT ${limit}`,
	);
	let seeded = 0;
	for (const blob of blobs) {
		if (
			recordManifest(db, blob.id, [
				{
					sha256: blob.stored_sha256,
					size: blob.stored_size_bytes,
				},
			])
		) {
			seeded++;
		}
	}
	if (seeded > 0) {
		log.info(`recorded single-chunk manifests for ${seeded} legacy blobs`);
	}
	return seeded;
}

// ── the location registry ────────────────────────────────────────────────────

export function chunkLocation(
	db: Db,
	sha256: string,
	nodeId: string,
): ChunkLocationRow | undefined {
	return db.get<ChunkLocationRow>(
		"SELECT * FROM chunk_locations WHERE chunk_sha256 = $sha AND node_id = $node",
		{ $sha: sha256, $node: nodeId },
	);
}

/** Write this node's own presence row for a chunk. Update-then-insert, never
 * a bare insert: (chunk, node) carries no UNIQUE constraint — see schema.sql
 * for why — so the single-writer discipline has to hold it.
 *
 * `pinned` only ever goes up. A durability copy that a later read-time fetch
 * touches is still a durability copy, and a pass that quietly demoted it would
 * hand the cache permission to evict the second copy the factor just placed. */
export function markChunk(
	db: Db,
	nodeId: string,
	sha256: string,
	opts: { state: ChunkState; size: number; pinned?: boolean },
): void {
	if (!nodeId) return;
	const existing = chunkLocation(db, sha256, nodeId);
	const pinned = opts.pinned ? 1 : 0;
	if (existing) {
		// Every row for this (chunk, node), not just the first: without a UNIQUE
		// constraint there can be more than one, and a state change that left a
		// stale duplicate saying `present` would keep advertising bytes this node
		// has just evicted.
		db.run(
			`UPDATE chunk_locations SET state = $state, size_bytes = $size,
         pinned = MAX(pinned, $pinned), updated_at = $now
       WHERE chunk_sha256 = $sha AND node_id = $node`,
			{
				$state: opts.state,
				$size: opts.size,
				$pinned: pinned,
				$now: nowIso(),
				$sha: sha256,
				$node: nodeId,
			},
		);
		return;
	}
	db.run(
		`INSERT INTO chunk_locations (chunk_sha256, node_id, state, size_bytes, pinned, updated_at)
     VALUES ($sha, $node, $state, $size, $pinned, $now)`,
		{
			$sha: sha256,
			$node: nodeId,
			$state: opts.state,
			$size: opts.size,
			$pinned: pinned,
			$now: nowIso(),
		},
	);
}

/** Record that this node holds every chunk of a blob whose bytes it just
 * wrote (an upload, a re-encrypt, a dedup hit against bytes already here).
 * Cheap enough for the upload path — it is one small write per 16 MiB. */
export function markBlobLocal(
	db: Db,
	blobId: number,
	opts: { pinned: boolean },
): void {
	const nodeId = localNodeId(db);
	if (!nodeId) return;
	for (const slot of manifestOf(db, blobId)) {
		markChunk(db, nodeId, slot.sha256, {
			state: "present",
			size: slot.size,
			pinned: opts.pinned,
		});
		touchChunk(db, slot.sha256);
	}
}

/** Node ids holding these bytes. `DISTINCT` because the natural key is not
 * enforced (schema.sql), so a duplicated row must not read as a second copy —
 * over-counting copies is what would let eviction delete the last one. */
export function holdersOf(
	db: Db,
	sha256: string,
	opts: { exclude?: string } = {},
): string[] {
	const rows = db.all<{ node_id: string }>(
		`SELECT DISTINCT node_id FROM chunk_locations
      WHERE chunk_sha256 = $sha AND state = 'present'`,
		{ $sha: sha256 },
	);
	return rows
		.map((r) => r.node_id)
		.filter((id) => id && id !== opts.exclude)
		.sort();
}

export function copyCount(db: Db, sha256: string): number {
	return (
		db.get<{ n: number }>(
			`SELECT COUNT(DISTINCT node_id) AS n FROM chunk_locations
        WHERE chunk_sha256 = $sha AND state = 'present'`,
			{ $sha: sha256 },
		)?.n ?? 0
	);
}

/** The LRU clock. Node-local (schema.sql): a read must not append a
 * replication-log entry. */
export function touchChunk(db: Db, sha256: string): void {
	db.run(
		`INSERT INTO local_chunk_cache (chunk_sha256, last_read_at) VALUES ($sha, $now)
     ON CONFLICT(chunk_sha256) DO UPDATE SET last_read_at = excluded.last_read_at`,
		{ $sha: sha256, $now: nowIso() },
	);
}

/** Reading a file touches every chunk of it, at most once a minute.
 *
 * Throttled for the same reason `sessions.last_seen_at` is: a video being
 * seeked through issues a Range request per seek, and a 40 GiB title is 2,560
 * rows — updating all of them per request would make the LRU clock cost more
 * than the read. One minute is far finer than any eviction decision. */
const TOUCH_INTERVAL_MS = 60_000;

export function touchBlobRead(db: Db, blobId: number | null | undefined): void {
	if (!blobId) return;
	const latest = db.get<{ last_read_at: string }>(
		`SELECT lcc.last_read_at FROM blob_chunks bc
       JOIN local_chunk_cache lcc ON lcc.chunk_sha256 = bc.chunk_sha256
      WHERE bc.blob_id = $id ORDER BY lcc.last_read_at DESC LIMIT 1`,
		{ $id: blobId },
	);
	if (
		latest &&
		Date.now() - Date.parse(latest.last_read_at) < TOUCH_INTERVAL_MS
	) {
		return;
	}
	db.run(
		`INSERT INTO local_chunk_cache (chunk_sha256, last_read_at)
     SELECT bc.chunk_sha256, $now FROM blob_chunks bc WHERE bc.blob_id = $id
     ON CONFLICT(chunk_sha256) DO UPDATE SET last_read_at = excluded.last_read_at`,
		{ $id: blobId, $now: nowIso() },
	);
}

export interface ChunkStorageStats {
	/** Durability copies (`pinned = 1`). Never evicted. */
	pinnedBytes: number;
	/** Opportunistic copies (`pinned = 0`) — what `CACHE_MAX_BYTES` caps. */
	cachedBytes: number;
	pinnedChunks: number;
	cachedChunks: number;
	/** `CACHE_MAX_BYTES`; 0 means uncapped. */
	capBytes: number;
	/** Cap minus cached bytes, floored at 0. Null when uncapped. */
	headroomBytes: number | null;
	/** Chunks this node holds that the cluster has fewer than
	 * `REPLICATION_FACTOR` copies of — placement's backlog. */
	underReplicated: number;
}

/** The numbers the admin panel shows per node. Pinned and cached are kept
 * apart deliberately: conflating them is part of why `REPLICATION_MODE=cache`
 * has been hard to reason about (§5.11). */
export function chunkStorageStats(state: AppState): ChunkStorageStats {
	const db = state.db;
	const nodeId = localNodeId(db);
	const row = db.get<{
		pinned_bytes: number;
		cached_bytes: number;
		pinned_chunks: number;
		cached_chunks: number;
	}>(
		`SELECT
       COALESCE(SUM(CASE WHEN pinned = 1 THEN size_bytes ELSE 0 END), 0) AS pinned_bytes,
       COALESCE(SUM(CASE WHEN pinned = 0 THEN size_bytes ELSE 0 END), 0) AS cached_bytes,
       COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned_chunks,
       COALESCE(SUM(CASE WHEN pinned = 0 THEN 1 ELSE 0 END), 0) AS cached_chunks
     FROM chunk_locations WHERE node_id = $node AND state = 'present'`,
		{ $node: nodeId },
	);
	const cap = state.settings.cacheMaxBytes;
	const cached = row?.cached_bytes ?? 0;
	return {
		pinnedBytes: row?.pinned_bytes ?? 0,
		cachedBytes: cached,
		pinnedChunks: row?.pinned_chunks ?? 0,
		cachedChunks: row?.cached_chunks ?? 0,
		capBytes: cap,
		headroomBytes: cap > 0 ? Math.max(0, cap - cached) : null,
		underReplicated: underReplicatedChunks(state).length,
	};
}

// ── the local physical layer ─────────────────────────────────────────────────

export function blobPath(blob: { storage_path: string }): string | null {
	try {
		return safeJoin(storageRoot(), blob.storage_path);
	} catch {
		return null;
	}
}

/** Does this node hold these bytes, and where?
 *
 * A chunk can appear in more than one blob (two files sharing a 16 MiB-aligned
 * run), so this searches every manifest carrying it and returns the first
 * whose file actually backs the range. */
export interface LocalChunk {
	blob: ContentBlobRow;
	path: string;
	offset: number;
	size: number;
}

export function localChunk(db: Db, sha256: string): LocalChunk | null {
	const nodeId = localNodeId(db);
	const rows = db.all<BlobChunkRow>(
		"SELECT * FROM blob_chunks WHERE chunk_sha256 = $sha ORDER BY blob_id",
		{ $sha: sha256 },
	);
	for (const row of rows) {
		const blob = db.get<ContentBlobRow>(
			"SELECT * FROM content_blobs WHERE id = $id",
			{ $id: row.blob_id },
		);
		if (!blob) continue;
		if (!holdsChunkLocally(db, nodeId, blob, sha256)) continue;
		const path = blobPath(blob);
		if (!path || !existsSync(path)) continue;
		const offset =
			db.get<{ n: number }>(
				`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM blob_chunks
          WHERE blob_id = $blob AND idx < $idx`,
				{ $blob: row.blob_id, $idx: row.idx },
			)?.n ?? 0;
		if (statSync(path).size < offset + row.size_bytes) continue;
		return { blob, path, offset, size: row.size_bytes };
	}
	return null;
}

/** The presence rule, stated once (see the file header). A location row is
 * believed whenever one exists; with none at all, a whole file of the right
 * length is taken as the complete blob it looks like — which is every blob
 * written before this phase, and every blob on a node that has never evicted
 * anything. */
export function holdsChunkLocally(
	db: Db,
	nodeId: string,
	blob: ContentBlobRow,
	sha256: string,
): boolean {
	const row = chunkLocation(db, sha256, nodeId);
	if (row) return row.state === "present";
	if (hasAnyLocalRow(db, blob.id, nodeId)) return false;
	const path = blobPath(blob);
	if (!path || !existsSync(path)) return false;
	return statSync(path).size === blob.stored_size_bytes;
}

/** The read path's fast answer to "is this blob whole here?".
 *
 * One stat and one indexed lookup, because it runs on every read — including
 * every Range request of a video being seeked through. A file of exactly the
 * right length with no location row saying otherwise is complete; anything
 * else falls through to the per-chunk walk, which is the expensive one and is
 * only ever paid by a node that really is missing something. */
export function blobCompleteLocally(
	db: Db,
	nodeId: string,
	blob: ContentBlobRow,
	path: string,
): boolean {
	if (!existsSync(path)) return false;
	if (statSync(path).size !== blob.stored_size_bytes) return false;
	return !db.get<{ id: number }>(
		`SELECT cl.id FROM chunk_locations cl
       JOIN blob_chunks bc ON bc.chunk_sha256 = cl.chunk_sha256
      WHERE bc.blob_id = $blob AND cl.node_id = $node AND cl.state <> 'present'
      LIMIT 1`,
		{ $blob: blob.id, $node: nodeId },
	);
}

function hasAnyLocalRow(db: Db, blobId: number, nodeId: string): boolean {
	return !!db.get<{ id: number }>(
		`SELECT cl.id FROM chunk_locations cl
       JOIN blob_chunks bc ON bc.chunk_sha256 = cl.chunk_sha256
      WHERE bc.blob_id = $blob AND cl.node_id = $node LIMIT 1`,
		{ $blob: blobId, $node: nodeId },
	);
}

/** Write a chunk into the blob's file at its offset, creating a sparse file if
 * this node holds nothing else of that blob. Positional, never append: chunk 7
 * can arrive before chunk 3. */
export function writeChunkAt(
	path: string,
	offset: number,
	bytes: Buffer,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, existsSync(path) ? "r+" : "w+");
	try {
		writeSync(fd, bytes, 0, bytes.length, offset);
	} finally {
		closeSync(fd);
	}
}

/** Reclaim a chunk's disk. Returns whether the bytes actually went away —
 * an eviction that cannot free anything must not be *recorded* as one, or the
 * cache would believe it is under its cap while the disk says otherwise.
 *
 * Two cases. If nothing else of the blob is held here, the whole file goes,
 * which is the common one and the only one that works everywhere. Otherwise
 * the range is a hole inside a file that has to stay, and only a filesystem
 * that supports punching one can free it; where that fails the chunk stays
 * present and the pass moves on to another candidate. */
export function reclaimChunk(
	db: Db,
	nodeId: string,
	sha256: string,
): { freed: number } {
	const local = localChunk(db, sha256);
	if (!local) return { freed: 0 };
	const others = db.all<BlobChunkRow>(
		"SELECT * FROM blob_chunks WHERE blob_id = $id AND chunk_sha256 <> $sha",
		{ $id: local.blob.id, $sha: sha256 },
	);
	const anyOtherHeld = others.some((row) =>
		holdsChunkLocally(db, nodeId, local.blob, row.chunk_sha256),
	);
	if (!anyOtherHeld) {
		try {
			unlinkSync(local.path);
			return { freed: local.size };
		} catch {
			return { freed: 0 };
		}
	}
	return punchHole(local.path, local.offset, local.size)
		? { freed: local.size }
		: { freed: 0 };
}

/** `fallocate --punch-hole`, the one way to free a range inside a file that
 * has to keep its length. Node exposes no binding for it, and no portable
 * equivalent exists, so this is a best-effort shell-out whose failure is an
 * ordinary answer rather than an error. */
function punchHole(path: string, offset: number, length: number): boolean {
	if (process.platform !== "linux") return false;
	try {
		const proc = Bun.spawnSync([
			"fallocate",
			"--punch-hole",
			"--keep-size",
			"--offset",
			String(offset),
			"--length",
			String(length),
			path,
		]);
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

// ── keeping the registry honest ──────────────────────────────────────────────

/** Whether a chunk landing here is a durability copy or cache.
 *
 * On a `full` node everything it holds is durability — it never evicts — so
 * even a read-time fetch is pinned. On a `cache` node a read-time fetch is
 * cache and a placement push is not, which is the distinction the whole
 * eviction pass turns on. */
export function pinsByDefault(state: AppState): boolean {
	return state.settings.replicationMode !== "cache";
}

/** Mark this node present for every chunk of blobs whose bytes are complete
 * here but whose manifest arrived later (or never had rows written for it).
 *
 * This is what gives an existing deployment a populated registry without a
 * rehash of the entire blob store: the manifest was computed by whoever
 * created the blob, and a local file of exactly `stored_size_bytes` is that
 * same content by the identity `attachBlob` keyed on. */
export function reconcileLocalChunks(state: AppState, limit = 200): number {
	const db = state.db;
	const nodeId = localNodeId(db);
	if (!nodeId) return 0;
	const pinned = pinsByDefault(state);
	const blobs = db.all<ContentBlobRow>(
		`SELECT cb.* FROM content_blobs cb
      WHERE EXISTS (SELECT 1 FROM blob_chunks bc WHERE bc.blob_id = cb.id)
        AND NOT EXISTS (
          SELECT 1 FROM chunk_locations cl
            JOIN blob_chunks bc2 ON bc2.chunk_sha256 = cl.chunk_sha256
           WHERE bc2.blob_id = cb.id AND cl.node_id = $node)
      ORDER BY cb.id LIMIT ${limit}`,
		{ $node: nodeId },
	);
	let marked = 0;
	for (const blob of blobs) {
		const path = blobPath(blob);
		if (!path || !existsSync(path)) continue;
		if (statSync(path).size !== blob.stored_size_bytes) continue;
		for (const slot of manifestOf(db, blob.id)) {
			markChunk(db, nodeId, slot.sha256, {
				state: "present",
				size: slot.size,
				pinned,
			});
			marked++;
		}
	}
	return marked;
}

/** Drop this node's registry rows for chunks no manifest references any more.
 *
 * The bytes went with the blob's file when its last reference was released
 * (`storage/blobs.ts::releaseBlob`); what is left is a row claiming this node
 * holds something that no longer exists, which would make it a candidate
 * source for a fetch that can only fail. Each node cleans up its own rows —
 * they are the only ones it may write. */
export function gcOrphanChunks(db: Db, limit = 500): number {
	const nodeId = localNodeId(db);
	if (!nodeId) return 0;
	const rows = db.all<{ id: number; chunk_sha256: string }>(
		`SELECT cl.id, cl.chunk_sha256 FROM chunk_locations cl
      WHERE cl.node_id = $node
        AND NOT EXISTS (
          SELECT 1 FROM blob_chunks bc WHERE bc.chunk_sha256 = cl.chunk_sha256)
      LIMIT ${limit}`,
		{ $node: nodeId },
	);
	for (const row of rows) {
		db.run("DELETE FROM chunk_locations WHERE id = $id", { $id: row.id });
		db.run("DELETE FROM local_chunk_cache WHERE chunk_sha256 = $sha", {
			$sha: row.chunk_sha256,
		});
	}
	return rows.length;
}

// ── placement (D-11) ─────────────────────────────────────────────────────────

export function replicationFactor(state: AppState): number {
	const raw = state.settings.replicationFactor;
	return raw > 0 ? raw : 1;
}

export interface PlacementCandidate {
	sha256: string;
	size: number;
	copies: number;
}

/** Chunks this node holds that the cluster has too few copies of.
 *
 * Ordered by how thin they are, so the chunk with one copy is placed before
 * the chunk with two — a pass that is interrupted has still done the most
 * valuable work first. */
export function underReplicatedChunks(
	state: AppState,
	limit = 50,
): PlacementCandidate[] {
	const db = state.db;
	const nodeId = localNodeId(db);
	if (!nodeId) return [];
	const factor = replicationFactor(state);
	return db.all<PlacementCandidate>(
		`SELECT chunk_sha256 AS sha256, size_bytes AS size, copies FROM (
       SELECT cl.chunk_sha256, cl.size_bytes,
              (SELECT COUNT(DISTINCT o.node_id) FROM chunk_locations o
                WHERE o.chunk_sha256 = cl.chunk_sha256 AND o.state = 'present') AS copies
         FROM chunk_locations cl
        WHERE cl.node_id = $node AND cl.state = 'present'
     ) WHERE copies < $factor ORDER BY copies ASC, size_bytes DESC LIMIT ${limit}`,
		{ $node: nodeId, $factor: factor },
	);
}

/** Where the next copy of a chunk should go, given who already holds it.
 *
 * Pure and exported so the rule can be tested without a cluster. The order is
 * the design's (§5.11):
 *
 * 1. **The master, if it is missing a copy.** It holds a full copy by
 *    construction — it is the largest node (§5.3) — and being always a valid
 *    witness is what makes the durability check terminate.
 * 2. **A node in another region**, so the second copy survives losing one.
 * 3. **The emptiest**, by free disk, then the fastest by observed throughput.
 *
 * A node that is inactive, unreachable (no base URL or token) or already
 * holding the chunk is not a candidate at all. */
export function choosePlacementTarget(
	peers: ClusterNodeRow[],
	opts: { holders: string[]; selfRegion: string | null; chunkSize: number },
): ClusterNodeRow | null {
	const held = new Set(opts.holders);
	const eligible = peers.filter(
		(peer) =>
			peer.active === 1 &&
			peer.base_url &&
			peer.token &&
			peer.node_id &&
			!held.has(peer.node_id) &&
			// Free space is a fact about the node that will hold the bytes, so it
			// is checked here and nowhere else (§5.5's rule for the upload cap,
			// applied to placement).
			(peer.disk_free_bytes === 0 || peer.disk_free_bytes > opts.chunkSize),
	);
	if (eligible.length === 0) return null;
	const master = eligible.find((peer) => peer.is_master === 1);
	if (master) return master;
	const score = (peer: ClusterNodeRow): number =>
		opts.selfRegion && peer.region && peer.region !== opts.selfRegion ? 1 : 0;
	return (
		eligible.sort(
			(a, b) =>
				score(b) - score(a) ||
				b.disk_free_bytes - a.disk_free_bytes ||
				(b.throughput_bps ?? 0) - (a.throughput_bps ?? 0) ||
				a.node_id!.localeCompare(b.node_id!),
		)[0] ?? null
	);
}

/** Pushes already made, so a pass does not re-push a chunk whose receiver's
 * location row has not travelled back here yet (it goes up to the master and
 * down again, seconds behind a 1-minute job). Bounded by its own TTL sweep —
 * an unbounded map here would be the leak CLAUDE.md warns about. */
const recentPushes = new Map<string, number>();
const PUSH_MEMORY_MS = 5 * 60_000;

function prunePushMemory(now: number): void {
	for (const [key, at] of recentPushes) {
		if (now - at > PUSH_MEMORY_MS) recentPushes.delete(key);
	}
}

/** Chunks pushed per tick. Placement is background work: a node that has just
 * absorbed a terabyte should saturate neither its uplink nor the receiver. */
const PUSH_BUDGET = 20;

export async function chunkReplicationJob(state: AppState): Promise<void> {
	const db = state.db;
	const nodeId = localNodeId(db);
	if (!nodeId) return;
	const peers = db.all<ClusterNodeRow>("SELECT * FROM cluster_nodes");
	if (peers.length === 0) return;
	const now = Date.now();
	prunePushMemory(now);

	const selfRegion =
		db.get<{ region: string | null }>(
			"SELECT region FROM cluster_nodes WHERE node_id = $node",
			{ $node: nodeId },
		)?.region ??
		state.settings.nodeRegion ??
		null;

	let pushed = 0;
	let failed = 0;
	for (const candidate of underReplicatedChunks(state, PUSH_BUDGET * 2)) {
		if (pushed >= PUSH_BUDGET) break;
		const holders = holdersOf(db, candidate.sha256);
		const target = choosePlacementTarget(peers, {
			holders: [
				...holders,
				...peers
					.filter((p) => recentPushes.has(`${candidate.sha256}:${p.node_id}`))
					.map((p) => p.node_id!),
			],
			selfRegion,
			chunkSize: candidate.size,
		});
		if (!target) continue;
		const ok = await pushChunk(state, target, candidate.sha256);
		if (ok) {
			recentPushes.set(`${candidate.sha256}:${target.node_id}`, now);
			pushed++;
		} else {
			failed++;
		}
	}
	if (pushed > 0 || failed > 0) {
		log.info(`chunk placement: pushed=${pushed} failed=${failed}`);
	}
}

/** Send one chunk to one peer, and record what the transfer says about it.
 *
 * The receiver writes its own location row — this node never writes a row
 * about somebody else's disk — so success here is followed by nothing except
 * a throughput sample. */
async function pushChunk(
	state: AppState,
	target: ClusterNodeRow,
	sha256: string,
): Promise<boolean> {
	const db = state.db;
	const local = localChunk(db, sha256);
	if (!local) return false;
	const blobUid = local.blob.uid;
	if (!blobUid) return false;
	const file = Bun.file(local.path).slice(
		local.offset,
		local.offset + local.size,
	);
	const url = `${target.base_url.replace(/\/$/, "")}/api/cluster/chunks/${sha256}?blob=${encodeURIComponent(blobUid)}`;
	const startedAt = Date.now();
	try {
		const resp = await fetchLogged("cluster", url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${target.token}`,
				"Content-Type": "application/octet-stream",
			},
			body: file,
		});
		if (!resp.ok) {
			log.warning(
				`chunk push ${sha256.slice(0, 12)} -> ${target.name} failed: ${resp.status}`,
			);
			return false;
		}
		recordThroughput(db, target, local.size, Date.now() - startedAt);
		return true;
	} catch (err) {
		log.warning(
			`chunk push ${sha256.slice(0, 12)} -> ${target.name} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

/** `cluster_nodes.throughput_bps`, sampled from a real transfer rather than a
 * synthetic probe (§5.2). Smoothed, and only from transfers big enough to
 * measure — a 4 KiB chunk over a warm connection would report a link speed
 * nobody has. */
export function recordThroughput(
	db: Db,
	target: ClusterNodeRow,
	bytes: number,
	elapsedMs: number,
): void {
	if (bytes < 1024 * 1024 || elapsedMs <= 0) return;
	const sample = Math.round((bytes * 1000) / elapsedMs);
	const previous = target.throughput_bps ?? 0;
	const smoothed =
		previous > 0 ? Math.round(previous * 0.7 + sample * 0.3) : sample;
	db.run("UPDATE cluster_nodes SET throughput_bps = $bps WHERE id = $id", {
		$bps: smoothed,
		$id: target.id,
	});
}
