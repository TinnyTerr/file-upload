import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppState } from "../appState.ts";
import type { ClusterNodeRow, ContentBlobRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { ClusterHTTPError, openStream } from "./http.ts";
import {
	blobCompleteLocally,
	blobPath,
	type ChunkSlot,
	chunkSize,
	holdersOf,
	holdsChunkLocally,
	localNodeId,
	manifestOf,
	markChunk,
	pinsByDefault,
	touchChunk,
	writeChunkAt,
} from "./placement.ts";

/**
 * Fetching bytes this node doesn't have (redesign §5.11).
 *
 * The unit is a chunk and the source comes from the registry: `holdersOf`
 * names the nodes that hold these exact bytes, so a read costs one request to
 * a node that has them rather than a walk down the peer list waiting 30
 * seconds per node that doesn't (D6). Chunks are fetched with a small
 * look-ahead in parallel, because a 40 GiB file missing 2,560 chunks
 * sequentially is a read that never finishes.
 *
 * The whole-blob path below it is not dead code and not a second mechanism:
 * it is what a blob with **no manifest anywhere** falls back to — a legacy
 * blob on a cluster whose master has not yet seeded its manifest, or a chunk
 * the registry knows no holder of. Both are transient states of a deployment
 * mid-upgrade, and the fallback is exactly the behaviour that shipped before
 * this phase.
 */

const log = getLogger("app.cluster.blobs");

/** Chunks fetched at once. Small on purpose: the look-ahead is there to hide
 * per-request latency, not to open a connection per chunk of a large file. */
const FETCH_CONCURRENCY = 4;

/** Above this a chunk is streamed to disk rather than held in memory while its
 * hash is checked. Only a legacy whole-file chunk (R-2) is ever this big; a
 * real one is `chunkSize()`. */
function maxInlineChunk(): number {
	return Math.max(chunkSize(), 64 * 1024 * 1024);
}

function reachablePeers(state: AppState): ClusterNodeRow[] {
	return state.db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.base_url && n.token);
}

/** Peers holding a chunk, nearest first.
 *
 * "Nearest" is the measured heartbeat RTT (`cluster_nodes.rtt_ms`, sampled by
 * membership.ts), and a peer with no sample yet sorts last rather than first —
 * an unmeasured link is not a fast one. */
function sourcesFor(state: AppState, sha256: string): ClusterNodeRow[] {
	const holders = new Set(
		holdersOf(state.db, sha256, { exclude: localNodeId(state.db) }),
	);
	return reachablePeers(state)
		.filter((peer) => peer.node_id && holders.has(peer.node_id))
		.sort(
			(a, b) =>
				(a.rtt_ms ?? Number.MAX_SAFE_INTEGER) -
				(b.rtt_ms ?? Number.MAX_SAFE_INTEGER),
		);
}

function chunkUrl(peer: ClusterNodeRow, sha256: string): string {
	return `${peer.base_url.replace(/\/$/, "")}/api/cluster/chunks/${sha256}`;
}

/** Pull one chunk from the first source that serves it, verify it against its
 * own hash, and write it into the blob's file at its offset.
 *
 * The hash check is not ceremony: the bytes are addressed by it, they are
 * being written into the middle of a file the read path will decrypt, and a
 * truncated response would otherwise be indistinguishable from the real
 * thing. */
async function fetchChunk(
	state: AppState,
	path: string,
	slot: ChunkSlot,
): Promise<boolean> {
	const sources = sourcesFor(state, slot.sha256);
	for (const peer of sources) {
		try {
			const resp = await openStream(chunkUrl(peer, slot.sha256), peer.token);
			if (slot.size > maxInlineChunk()) {
				if (!(await streamChunkToFile(resp, path, slot))) continue;
			} else {
				const body = Buffer.from(await resp.arrayBuffer());
				if (body.length !== slot.size) {
					log.warning(
						`chunk ${slot.sha256.slice(0, 12)} from ${peer.name}: expected ${slot.size} bytes, got ${body.length}`,
					);
					continue;
				}
				if (createHash("sha256").update(body).digest("hex") !== slot.sha256) {
					log.warning(
						`chunk ${slot.sha256.slice(0, 12)} from ${peer.name} failed its hash check`,
					);
					continue;
				}
				writeChunkAt(path, slot.offset, body);
			}
			markChunk(state.db, localNodeId(state.db), slot.sha256, {
				state: "present",
				size: slot.size,
				pinned: pinsByDefault(state),
			});
			touchChunk(state.db, slot.sha256);
			return true;
		} catch (err) {
			if (err instanceof ClusterHTTPError) continue;
			throw err;
		}
	}
	return false;
}

/** The oversized case: a legacy whole-file chunk, streamed to a temp file with
 * a running hash so a multi-gigabyte transfer never sits in memory. Only ever
 * covers a whole blob, so the verified file replaces the destination outright
 * rather than being spliced into it. */
async function streamChunkToFile(
	resp: Response,
	path: string,
	slot: ChunkSlot,
): Promise<boolean> {
	if (slot.offset !== 0) return false;
	if (!resp.body) return false;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.chunk.tmp`;
	const hash = createHash("sha256");
	try {
		const source = Readable.fromWeb(resp.body as never);
		source.on("data", (buf: Buffer) => hash.update(buf));
		await pipeline(source, createWriteStream(tmp));
		if (hash.digest("hex") !== slot.sha256) {
			unlinkSync(tmp);
			return false;
		}
		renameSync(tmp, path);
		return true;
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort
		}
		return false;
	}
}

/** Make sure every chunk of `blob` is on this node's disk, fetching what is
 * missing from whoever the registry says has it.
 *
 * Returns whether the blob is now complete here. Best-effort by design: the
 * caller re-checks the file and falls back to its usual "missing from storage"
 * error, which is the same contract the whole-blob fetch had. */
export async function ensureBlobLocal(
	state: AppState,
	blob: ContentBlobRow,
	path: string,
): Promise<boolean> {
	const db = state.db;
	const nodeId = localNodeId(db);
	// The overwhelming case, and the reason it is checked first: this node holds
	// the whole blob and the read costs one stat and one indexed lookup rather
	// than a walk over a 2,560-entry manifest.
	if (blobCompleteLocally(db, nodeId, blob, path)) return true;
	const slots = manifestOf(db, blob.id);
	if (slots.length === 0) {
		// No manifest anywhere yet. Nothing to fetch chunk-wise, so this is the
		// pre-chunking path verbatim.
		if (existsSync(path)) return true;
		return fetchBlobFromPeers(state, {
			storedSha256: blob.stored_sha256,
			transformKey: blob.transform_key,
			dest: path,
		});
	}

	const missing = slots.filter(
		(slot) => !holdsChunkLocally(db, nodeId, blob, slot.sha256),
	);
	if (missing.length === 0) {
		for (const slot of slots) touchChunk(db, slot.sha256);
		return true;
	}

	// A chunk the registry knows no holder of is not a chunk this node can
	// fetch. That happens while a peer's location rows are still in flight, and
	// the whole-blob walk is the only thing that can still answer -- so it is
	// tried once, for the whole blob, rather than per chunk.
	if (missing.some((slot) => sourcesFor(state, slot.sha256).length === 0)) {
		const whole = await fetchBlobFromPeers(state, {
			storedSha256: blob.stored_sha256,
			transformKey: blob.transform_key,
			dest: path,
		});
		if (whole) {
			for (const slot of slots) {
				markChunk(db, nodeId, slot.sha256, {
					state: "present",
					size: slot.size,
					pinned: pinsByDefault(state),
				});
				touchChunk(db, slot.sha256);
			}
			return true;
		}
	}

	let cursor = 0;
	let failed = 0;
	const workers = Array.from(
		{ length: Math.min(FETCH_CONCURRENCY, missing.length) },
		async () => {
			for (;;) {
				const slot = missing[cursor++];
				if (!slot) return;
				if (!(await fetchChunk(state, path, slot))) failed++;
			}
		},
	);
	await Promise.all(workers);
	if (failed > 0) {
		log.warning(
			`blob ${blob.stored_sha256.slice(0, 12)}: ${failed}/${missing.length} chunks could not be fetched from any peer`,
		);
		return false;
	}
	log.info(
		`fetched ${missing.length} chunk(s) of blob ${blob.stored_sha256.slice(0, 12)} from peers`,
	);
	return true;
}

/** Try each active peer in turn for a whole content-addressed blob, streaming
 * the first hit to `dest`.
 *
 * Superseded by the chunk path above for anything with a manifest, and kept
 * for the two cases that have none: a legacy blob whose manifest has not been
 * seeded yet, and a chunk no location row claims. Both resolve themselves once
 * replication catches up. */
export async function fetchBlobFromPeers(
	state: AppState,
	opts: {
		storedSha256: string;
		transformKey: string;
		dest: string;
	},
): Promise<boolean> {
	const peers = reachablePeers(state);

	mkdirSync(dirname(opts.dest), { recursive: true });
	for (const peer of peers) {
		const url = `${peer.base_url.replace(/\/$/, "")}/api/cluster/blobs/${opts.storedSha256}?transform=${encodeURIComponent(opts.transformKey)}`;
		let resp: Response;
		try {
			resp = await openStream(url, peer.token, 30_000);
		} catch (err) {
			if (err instanceof ClusterHTTPError) continue;
			throw err;
		}
		const tmp = `${opts.dest}.peer.tmp`;
		try {
			if (!resp.body) throw new Error("empty response body");
			await pipeline(
				Readable.fromWeb(resp.body as never),
				createWriteStream(tmp),
			);
			renameSync(tmp, opts.dest);
			log.info(
				`fetched blob ${opts.storedSha256.slice(0, 12)} from peer ${peer.base_url}`,
			);
			return true;
		} catch {
			try {
				unlinkSync(tmp);
			} catch {
				// best-effort
			}
			log.warning(
				`failed streaming blob ${opts.storedSha256.slice(0, 12)} from ${peer.base_url}`,
			);
		}
	}
	return false;
}

/** Resolve a blob row to its local path and pull whatever is missing. The
 * entry point `storage/streaming.ts` uses. */
export async function ensureBlobBytes(
	state: AppState,
	blob: ContentBlobRow,
): Promise<boolean> {
	const path = blobPath(blob);
	if (!path) return false;
	return ensureBlobLocal(state, blob, path);
}
