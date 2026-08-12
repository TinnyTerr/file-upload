/**
 * Chunking, the location registry and placement (redesign Phase 8, §5.11).
 *
 * The pure half — how bytes split, how the registry counts copies, where the
 * next copy should go — needs no cluster and is tested as functions. The
 * moving half goes over real HTTP between real nodes through
 * `/api/cluster/chunks`, because "node B pulled this chunk from node A" is a
 * claim about the protocol, not about the SQL under it.
 *
 * LIMITATION, inherited from `clusterHarness.ts`: every node in one harness
 * shares a storage root, so a peer's file is physically visible here in a way
 * it never is in production. The registry is what these tests drive — a node
 * serves and fetches on the strength of `chunk_locations`, so a divergence
 * staged in the *database* exercises exactly the code a real divergence would.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureBlobLocal } from "../src/cluster/blobs.ts";
import { cacheEvictionJob } from "../src/cluster/cacheEviction.ts";
import {
	choosePlacementTarget,
	chunkReplicationJob,
	chunkStorageStats,
	copyCount,
	gcOrphanChunks,
	holdersOf,
	localChunk,
	localNodeId,
	manifestOf,
	markChunk,
	planChunks,
	seedLegacyManifests,
	underReplicatedChunks,
} from "../src/cluster/placement.ts";
import { rechunkCandidates, rechunkLegacyJob } from "../src/cluster/rechunk.ts";
import { replicationPullJob } from "../src/cluster/replication.ts";
import { resetConfigCache } from "../src/config.ts";
import type { ClusterNodeRow, ContentBlobRow } from "../src/db/rows.ts";
import { attachBlob, hashFile } from "../src/storage/blobs.ts";
import { storageRoot } from "../src/storage/paths.ts";
import { type ClusterNodeHarness, makeCluster } from "./clusterHarness.ts";

/** Small enough that a few kilobytes is a multi-chunk blob, so the tests
 * exercise manifests with real boundaries instead of a single whole-file
 * chunk. */
const CHUNK = 1024;

let previousRoot: string | undefined;
let previousChunk: string | undefined;
let root: string;

beforeAll(() => {
	previousRoot = process.env.FILEUPLOAD_STORAGE;
	previousChunk = process.env.FILEUPLOAD_CHUNK_SIZE;
	root = join(tmpdir(), `fu-chunks-${randomBytes(6).toString("hex")}`);
	mkdirSync(root, { recursive: true });
	process.env.FILEUPLOAD_STORAGE = root;
	process.env.FILEUPLOAD_CHUNK_SIZE = String(CHUNK);
	resetConfigCache();
});

afterAll(() => {
	if (previousRoot === undefined) delete process.env.FILEUPLOAD_STORAGE;
	else process.env.FILEUPLOAD_STORAGE = previousRoot;
	if (previousChunk === undefined) delete process.env.FILEUPLOAD_CHUNK_SIZE;
	else process.env.FILEUPLOAD_CHUNK_SIZE = previousChunk;
	resetConfigCache();
});

/** Write real bytes into the storage root and register them as a blob, the
 * way `finalizeStoredFile` does — including the manifest, which is what makes
 * this a Phase 8 blob rather than a legacy one. */
async function makeBlob(
	node: ClusterNodeHarness,
	bytes: Buffer,
): Promise<ContentBlobRow> {
	const rand = randomBytes(16).toString("hex");
	const rel = join(rand.slice(0, 2), rand.slice(2, 4), rand.slice(4));
	const path = join(storageRoot(), rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	const hashes = await hashFile(path);
	return attachBlob(node.db, {
		finalPath: path,
		relPath: rel,
		logicalSize: bytes.length,
		contentType: "application/octet-stream",
		hashes,
		storedHashes: hashes,
		storedChunks: hashes.chunks,
		pinned: true,
		transformKey: "none:compressed=0",
	});
}

function peerRow(from: ClusterNodeHarness, to: ClusterNodeHarness) {
	return from.db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $id",
		{ $id: to.nodeId },
	)!;
}

describe("splitting bytes", () => {
	test("planChunks covers the file exactly, with a short final chunk", () => {
		const plan = planChunks(2_500, 1_000);
		expect(plan).toEqual([
			{ offset: 0, size: 1_000 },
			{ offset: 1_000, size: 1_000 },
			{ offset: 2_000, size: 500 },
		]);
		expect(planChunks(0, 1_000)).toEqual([]);
		expect(planChunks(1_000, 1_000)).toEqual([{ offset: 0, size: 1_000 }]);
	});

	test("hashFile digests each chunk in the same pass as the whole file", async () => {
		const bytes = randomBytes(CHUNK * 2 + 17);
		const path = join(root, `hash-${randomBytes(4).toString("hex")}`);
		writeFileSync(path, bytes);

		const hashed = await hashFile(path);
		expect(hashed.sha256).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);
		expect(hashed.chunks.map((c) => c.size)).toEqual([CHUNK, CHUNK, 17]);
		// Each chunk's hash is over exactly its own range -- that is what lets a
		// peer verify a chunk it received without the rest of the file.
		let offset = 0;
		for (const chunk of hashed.chunks) {
			expect(chunk.sha256).toBe(
				createHash("sha256")
					.update(bytes.subarray(offset, offset + chunk.size))
					.digest("hex"),
			);
			offset += chunk.size;
		}
	});

	test("a blob's manifest resolves to contiguous offsets", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const bytes = randomBytes(CHUNK * 3 + 5);
			const blob = await makeBlob(c.master, bytes);
			const slots = manifestOf(c.master.db, blob.id);
			expect(slots.map((s) => s.offset)).toEqual([
				0,
				CHUNK,
				CHUNK * 2,
				CHUNK * 3,
			]);
			expect(slots.at(-1)!.size).toBe(5);
			// And this node is recorded as holding every one of them.
			for (const slot of slots) {
				expect(holdersOf(c.master.db, slot.sha256)).toEqual([c.master.nodeId]);
			}
		} finally {
			c.close();
		}
	});

	test("a blob that predates chunking is seeded as one whole-file chunk", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const bytes = randomBytes(CHUNK * 2);
			const blob = await makeBlob(c.master, bytes);
			// Simulate the pre-Phase-8 state: bytes and a row, no manifest.
			c.master.db.run("DELETE FROM blob_chunks WHERE blob_id = $id", {
				$id: blob.id,
			});
			expect(seedLegacyManifests(c.master.db)).toBe(1);
			const slots = manifestOf(c.master.db, blob.id);
			expect(slots).toHaveLength(1);
			// Free: a legacy blob's single chunk hash *is* its stored_sha256.
			expect(slots[0]!.sha256).toBe(blob.stored_sha256);
			expect(slots[0]!.size).toBe(bytes.length);
		} finally {
			c.close();
		}
	});
});

describe("the location registry", () => {
	test("counts distinct holders, not rows", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const sha = createHash("sha256").update("x").digest("hex");
			markChunk(db, "node-a", sha, { state: "present", size: 10 });
			markChunk(db, "node-b", sha, { state: "present", size: 10 });
			// A duplicate row for a node the registry already counts must not read
			// as another copy -- over-counting is what would let eviction delete
			// the last one.
			db.run(
				`INSERT INTO chunk_locations (chunk_sha256, node_id, state, size_bytes, pinned, updated_at)
         VALUES ($sha, 'node-b', 'present', 10, 0, '2026-01-01T00:00:00.000Z')`,
				{ $sha: sha },
			);
			expect(copyCount(db, sha)).toBe(2);
			expect(holdersOf(db, sha)).toEqual(["node-a", "node-b"]);
			expect(holdersOf(db, sha, { exclude: "node-a" })).toEqual(["node-b"]);

			markChunk(db, "node-b", sha, { state: "evicted", size: 10 });
			expect(holdersOf(db, sha)).toEqual(["node-a"]);
		} finally {
			c.close();
		}
	});

	test("a pin is never lowered by a later read-time fetch", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const sha = createHash("sha256").update("pinned").digest("hex");
			markChunk(db, "node-a", sha, {
				state: "present",
				size: 10,
				pinned: true,
			});
			markChunk(db, "node-a", sha, {
				state: "present",
				size: 10,
				pinned: false,
			});
			expect(
				db.get<{ pinned: number }>(
					"SELECT pinned FROM chunk_locations WHERE chunk_sha256 = $sha",
					{ $sha: sha },
				)!.pinned,
			).toBe(1);
		} finally {
			c.close();
		}
	});

	test("orphaned location rows are collected once the manifest is gone", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const blob = await makeBlob(c.master, randomBytes(CHUNK));
			const sha = manifestOf(db, blob.id)[0]!.sha256;
			expect(copyCount(db, sha)).toBe(1);

			db.run("DELETE FROM blob_chunks WHERE blob_id = $id", { $id: blob.id });
			expect(gcOrphanChunks(db)).toBe(1);
			expect(copyCount(db, sha)).toBe(0);
		} finally {
			c.close();
		}
	});
});

describe("choosePlacementTarget", () => {
	const peer = (over: Partial<ClusterNodeRow>): ClusterNodeRow =>
		({
			id: 1,
			name: "peer",
			base_url: "http://peer",
			token: "t",
			active: 1,
			node_id: "n",
			is_master: 0,
			disk_free_bytes: 0,
			throughput_bps: null,
			region: null,
			...over,
		}) as ClusterNodeRow;

	test("puts the master first, wherever it is", () => {
		const target = choosePlacementTarget(
			[
				peer({ node_id: "big", disk_free_bytes: 1_000_000_000 }),
				peer({ node_id: "master", is_master: 1, disk_free_bytes: 1 }),
			],
			{ holders: [], selfRegion: "r1", chunkSize: 0 },
		);
		expect(target?.node_id).toBe("master");
	});

	test("prefers another region, then the emptiest node", () => {
		const target = choosePlacementTarget(
			[
				peer({ node_id: "near", region: "r1", disk_free_bytes: 900 }),
				peer({ node_id: "far", region: "r2", disk_free_bytes: 100 }),
			],
			{ holders: [], selfRegion: "r1", chunkSize: 10 },
		);
		expect(target?.node_id).toBe("far");

		const sameRegion = choosePlacementTarget(
			[
				peer({ node_id: "small", region: "r1", disk_free_bytes: 100 }),
				peer({ node_id: "large", region: "r1", disk_free_bytes: 900 }),
			],
			{ holders: [], selfRegion: "r1", chunkSize: 10 },
		);
		expect(sameRegion?.node_id).toBe("large");
	});

	test("skips holders, inactive nodes and nodes without room", () => {
		expect(
			choosePlacementTarget([peer({ node_id: "held" })], {
				holders: ["held"],
				selfRegion: null,
				chunkSize: 0,
			}),
		).toBeNull();
		expect(
			choosePlacementTarget([peer({ node_id: "down", active: 0 })], {
				holders: [],
				selfRegion: null,
				chunkSize: 0,
			}),
		).toBeNull();
		expect(
			choosePlacementTarget([peer({ node_id: "full", disk_free_bytes: 5 })], {
				holders: [],
				selfRegion: null,
				chunkSize: 4_096,
			}),
		).toBeNull();
	});
});

describe("GET/HEAD /api/cluster/chunks/:sha", () => {
	test("serves the chunk's byte range, and only to a node that holds it", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const bytes = randomBytes(CHUNK * 2 + 3);
			const blob = await makeBlob(master, bytes);
			const slots = manifestOf(master.db, blob.id);

			const res = await master.asPeer(
				`/api/cluster/chunks/${slots[1]!.sha256}`,
				{ method: "GET" },
			);
			expect(res.status).toBe(200);
			const served = Buffer.from(await res.arrayBuffer());
			expect(served.equals(bytes.subarray(CHUNK, CHUNK * 2))).toBe(true);

			expect(
				(
					await master.asPeer(`/api/cluster/chunks/${slots[0]!.sha256}`, {
						method: "HEAD",
					})
				).status,
			).toBe(200);
			// The follower has neither the row nor a manifest yet.
			expect(
				(
					await follower.asPeer(`/api/cluster/chunks/${slots[0]!.sha256}`, {
						method: "HEAD",
					})
				).status,
			).toBe(404);
			// And an unauthenticated caller gets nothing at all.
			expect(
				(await master.request(`/api/cluster/chunks/${slots[0]!.sha256}`))
					.status,
			).toBe(401);
		} finally {
			c.close();
		}
	});
});

describe("the manifest replicates", () => {
	test("a peer learns the chunks and who holds them from the change log", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const bytes = randomBytes(CHUNK * 2);
			const blob = await makeBlob(master, bytes);
			await replicationPullJob(follower.state);

			const peerBlob = follower.db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE uid = $uid",
				{ $uid: blob.uid },
			);
			expect(peerBlob).toBeDefined();
			const slots = manifestOf(follower.db, peerBlob!.id);
			expect(slots.map((s) => s.sha256)).toEqual(
				manifestOf(master.db, blob.id).map((s) => s.sha256),
			);
			// The registry travelled too: the follower knows the master holds them
			// without having to ask it.
			for (const slot of slots) {
				expect(holdersOf(follower.db, slot.sha256)).toEqual([master.nodeId]);
			}
		} finally {
			c.close();
		}
	});
});

describe("read-time chunk fetch", () => {
	test("pulls exactly the chunks the registry says are missing", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const bytes = randomBytes(CHUNK * 2 + 11);
			const blob = await makeBlob(master, bytes);
			await replicationPullJob(follower.state);

			const peerBlob = follower.db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE uid = $uid",
				{ $uid: blob.uid },
			)!;
			const slots = manifestOf(follower.db, peerBlob.id);
			// Stage the divergence in the registry: this node once held the first
			// chunk and evicted it. That is what a cache node looks like, and it is
			// what makes the read path go and get it.
			markChunk(follower.db, follower.nodeId, slots[0]!.sha256, {
				state: "evicted",
				size: slots[0]!.size,
			});

			const path = join(storageRoot(), peerBlob.storage_path);
			expect(await ensureBlobLocal(follower.state, peerBlob, path)).toBe(true);

			// Every chunk is now recorded here, and the bytes still hash to the
			// file the master wrote.
			for (const slot of slots) {
				expect(
					holdersOf(follower.db, slot.sha256).includes(follower.nodeId),
				).toBe(true);
			}
			expect(readFileSync(path).equals(bytes)).toBe(true);
		} finally {
			c.close();
		}
	});
});

describe("placement", () => {
	test("pushes an under-replicated chunk to a peer, pinned", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const bytes = randomBytes(CHUNK + 7);
			const blob = await makeBlob(master, bytes);
			// The follower needs the blob row and the manifest before it can accept
			// a chunk of it -- placement moves bytes, never metadata.
			await replicationPullJob(follower.state);

			const candidates = underReplicatedChunks(master.state);
			expect(candidates).toHaveLength(2);

			await chunkReplicationJob(master.state);

			const peerBlob = follower.db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE uid = $uid",
				{ $uid: blob.uid },
			)!;
			const slots = manifestOf(follower.db, peerBlob.id);
			for (const slot of slots) {
				const row = follower.db.get<{ state: string; pinned: number }>(
					`SELECT state, pinned FROM chunk_locations
            WHERE chunk_sha256 = $sha AND node_id = $node`,
					{ $sha: slot.sha256, $node: follower.nodeId },
				);
				expect(row?.state).toBe("present");
				// A durability copy is not cache, even on a cache node.
				expect(row?.pinned).toBe(1);
			}
			// The receiver's own view of its storage separates the two kinds.
			const stats = chunkStorageStats(follower.state);
			expect(stats.pinnedChunks).toBe(2);
			expect(stats.cachedChunks).toBe(0);
			expect(stats.pinnedBytes).toBe(bytes.length);
		} finally {
			c.close();
		}
	});

	test("a chunk the cluster already holds enough copies of is not a candidate", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const blob = await makeBlob(master, randomBytes(CHUNK));
			const sha = manifestOf(master.db, blob.id)[0]!.sha256;
			markChunk(master.db, follower.nodeId, sha, {
				state: "present",
				size: CHUNK,
			});
			expect(underReplicatedChunks(master.state)).toEqual([]);
		} finally {
			c.close();
		}
	});
});

describe("cache eviction", () => {
	test("evicts the least recently read unpinned chunk, and only once a peer confirms it", async () => {
		const c = await makeCluster({
			size: 2,
			settings: (i) =>
				i === 1
					? {
							replicationMode: "cache",
							cacheMaxBytes: 1,
							replicationFactor: 1,
						}
					: {},
		});
		try {
			c.linkAll();
			const [master, cache] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const bytes = randomBytes(CHUNK);
			const blob = await makeBlob(master, bytes);
			await replicationPullJob(cache.state);

			const peerBlob = cache.db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE uid = $uid",
				{ $uid: blob.uid },
			)!;
			const sha = manifestOf(cache.db, peerBlob.id)[0]!.sha256;
			// The cache node holds it as cache -- unpinned, which is the only kind
			// of copy eviction may touch.
			markChunk(cache.db, cache.nodeId, sha, {
				state: "present",
				size: bytes.length,
				pinned: false,
			});
			expect(localChunk(cache.db, sha)).not.toBeNull();

			await cacheEvictionJob(cache.state);

			expect(
				cache.db.get<{ state: string }>(
					"SELECT state FROM chunk_locations WHERE chunk_sha256 = $sha AND node_id = $node",
					{ $sha: sha, $node: cache.nodeId },
				)?.state,
			).toBe("evicted");
			expect(existsSync(join(storageRoot(), peerBlob.storage_path))).toBe(
				false,
			);
			// The master's copy is untouched, which is what the confirming HEAD was
			// checking before anything was deleted.
			expect(holdersOf(master.db, sha)).toEqual([master.nodeId]);
		} finally {
			c.close();
		}
	});

	test("leaves a pinned chunk alone however far over the cap it is", async () => {
		const c = await makeCluster({
			size: 2,
			settings: (i) =>
				i === 1
					? {
							replicationMode: "cache",
							cacheMaxBytes: 1,
							replicationFactor: 1,
						}
					: {},
		});
		try {
			c.linkAll();
			const [master, cache] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const blob = await makeBlob(master, randomBytes(CHUNK));
			await replicationPullJob(cache.state);
			const peerBlob = cache.db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE uid = $uid",
				{ $uid: blob.uid },
			)!;
			const sha = manifestOf(cache.db, peerBlob.id)[0]!.sha256;
			markChunk(cache.db, cache.nodeId, sha, {
				state: "present",
				size: CHUNK,
				pinned: true,
			});

			await cacheEvictionJob(cache.state);

			expect(
				cache.db.get<{ state: string }>(
					"SELECT state FROM chunk_locations WHERE chunk_sha256 = $sha AND node_id = $node",
					{ $sha: sha, $node: cache.nodeId },
				)?.state,
			).toBe("present");
			expect(existsSync(join(storageRoot(), peerBlob.storage_path))).toBe(true);
			expect(localNodeId(cache.db)).toBe(cache.nodeId);
			expect(peerRow(cache, master).node_id).toBe(master.nodeId);
		} finally {
			c.close();
		}
	});
});

describe("retiring the legacy whole-file manifest (R-2)", () => {
	/** Put a blob back into the state a pre-Phase-8 database left it in: bytes
	 * on disk, a `content_blobs` row, and no manifest at all. */
	function forgetManifest(node: ClusterNodeHarness, blobId: number): void {
		node.db.run("DELETE FROM blob_chunks WHERE blob_id = $id", { $id: blobId });
		node.db.run("DELETE FROM chunk_locations WHERE node_id = $node", {
			$node: node.nodeId,
		});
	}

	/** What `jobs/lifecycle.ts` leaves behind: new bytes at the same path, a new
	 * `stored_size_bytes`, `archived = 1` — and `stored_sha256` still naming the
	 * identity the blob was minted for, which no longer describes the file. */
	function archiveInPlace(
		node: ClusterNodeHarness,
		blob: ContentBlobRow,
		bytes: Buffer,
	): void {
		writeFileSync(join(storageRoot(), blob.storage_path), bytes);
		node.db.run(
			"UPDATE content_blobs SET archived = 1, stored_size_bytes = $size WHERE id = $id",
			{ $size: bytes.length, $id: blob.id },
		);
	}

	test("a whole-file manifest is split into per-chunk hashes of the real bytes", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const bytes = randomBytes(CHUNK * 3 + 11);
			const blob = await makeBlob(c.master, bytes);
			forgetManifest(c.master, blob.id);
			expect(seedLegacyManifests(db)).toBe(1);
			expect(manifestOf(db, blob.id)).toHaveLength(1);

			await rechunkLegacyJob(c.master.state);

			const slots = manifestOf(db, blob.id);
			expect(slots).toHaveLength(4);
			for (const slot of slots) {
				const range = bytes.subarray(slot.offset, slot.offset + slot.size);
				expect(createHash("sha256").update(range).digest("hex")).toBe(
					slot.sha256,
				);
				// The bytes did not move, so this node still holds every one of them
				// -- under the hashes the cluster now knows them by.
				expect(
					db.get<{ state: string }>(
						"SELECT state FROM chunk_locations WHERE chunk_sha256 = $sha AND node_id = $node",
						{ $sha: slot.sha256, $node: c.master.nodeId },
					)?.state,
				).toBe("present");
			}

			// Idempotent: a manifest that already describes the file is not a
			// candidate, so the pass does not rewrite it every hour.
			const before = db.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM replication_log",
			)!.n;
			await rechunkLegacyJob(c.master.state);
			expect(rechunkCandidates(db)).toHaveLength(0);
			expect(
				db.get<{ n: number }>("SELECT COUNT(*) AS n FROM replication_log")!.n,
			).toBe(before);
		} finally {
			c.close();
		}
	});

	test("an archived blob is left unseeded and rechunked from its real bytes", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const blob = await makeBlob(c.master, randomBytes(CHUNK * 2));
			forgetManifest(c.master, blob.id);
			const archived = randomBytes(CHUNK + 40);
			archiveInPlace(c.master, blob, archived);

			// The free hash would describe bytes that no longer exist, so the seed
			// declines to mint one at all.
			expect(seedLegacyManifests(db)).toBe(0);
			expect(manifestOf(db, blob.id)).toHaveLength(0);

			await rechunkLegacyJob(c.master.state);

			const slots = manifestOf(db, blob.id);
			expect(slots).toHaveLength(2);
			expect(slots.map((s) => s.size)).toEqual([CHUNK, 40]);
			expect(slots[0]!.sha256).not.toBe(blob.stored_sha256);
			for (const slot of slots) {
				const range = archived.subarray(slot.offset, slot.offset + slot.size);
				expect(createHash("sha256").update(range).digest("hex")).toBe(
					slot.sha256,
				);
			}
		} finally {
			c.close();
		}
	});

	test("a manifest an older seed minted for an archived blob is replaced", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const blob = await makeBlob(c.master, randomBytes(CHUNK));
			forgetManifest(c.master, blob.id);
			const archived = randomBytes(CHUNK - 7);
			archiveInPlace(c.master, blob, archived);
			// Exactly what the seed used to write: one chunk, hashed as the blob's
			// pre-archive identity. Every peer fetching it fails its verification.
			db.run(
				`INSERT INTO blob_chunks (blob_id, idx, chunk_sha256, size_bytes, created_at)
         VALUES ($blob, 0, $sha, $size, '2026-01-01T00:00:00.000Z')`,
				{ $blob: blob.id, $sha: blob.stored_sha256, $size: archived.length },
			);
			expect(rechunkCandidates(db).map((b) => b.id)).toEqual([blob.id]);

			await rechunkLegacyJob(c.master.state);

			const slots = manifestOf(db, blob.id);
			expect(slots).toHaveLength(1);
			expect(slots[0]!.sha256).toBe(
				createHash("sha256").update(archived).digest("hex"),
			);
		} finally {
			c.close();
		}
	});

	test("bytes that do not hash to the blob's identity are left alone", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const bytes = randomBytes(CHUNK * 2);
			const blob = await makeBlob(c.master, bytes);
			forgetManifest(c.master, blob.id);
			seedLegacyManifests(db);
			// A rewrite that landed while the pass was reading looks exactly like
			// this: same length, different content. Recording a manifest of it
			// would be the one way this pass could break a blob for good.
			writeFileSync(
				join(storageRoot(), blob.storage_path),
				randomBytes(bytes.length),
			);

			await rechunkLegacyJob(c.master.state);

			expect(manifestOf(db, blob.id)).toHaveLength(1);
		} finally {
			c.close();
		}
	});

	test("only the master rechunks", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			const blob = await makeBlob(master, randomBytes(CHUNK * 2));
			forgetManifest(master, blob.id);
			seedLegacyManifests(master.db);
			await replicationPullJob(follower.state);
			const peerBlob = follower.db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE uid = $uid",
				{ $uid: blob.uid },
			)!;
			expect(manifestOf(follower.db, peerBlob.id)).toHaveLength(1);

			// A second writer for one manifest would ship a second set of
			// (blob_id, idx) rows to every peer, and neither natural key carries a
			// constraint that would catch it.
			await rechunkLegacyJob(follower.state);

			expect(manifestOf(follower.db, peerBlob.id)).toHaveLength(1);

			// The follower holds the bytes, so it advertises the whole-file chunk
			// the seed named them by.
			await cacheEvictionJob(follower.state);
			const legacySha = manifestOf(follower.db, peerBlob.id)[0]!.sha256;
			expect(holdersOf(follower.db, legacySha)).toContain(follower.nodeId);

			await rechunkLegacyJob(master.state);
			expect(manifestOf(master.db, blob.id)).toHaveLength(2);

			// The re-cut manifest travels like any other row, and the housekeeping
			// half of the eviction tick does the rest: the orphaned row goes, and
			// the same bytes are re-advertised under the hashes they are now known
			// by. Nothing moved on disk.
			await replicationPullJob(follower.state);
			await cacheEvictionJob(follower.state);
			const slots = manifestOf(follower.db, peerBlob.id);
			expect(slots).toHaveLength(2);
			expect(holdersOf(follower.db, legacySha)).not.toContain(follower.nodeId);
			for (const slot of slots) {
				expect(holdersOf(follower.db, slot.sha256)).toContain(follower.nodeId);
			}
			expect(existsSync(join(storageRoot(), peerBlob.storage_path))).toBe(true);
		} finally {
			c.close();
		}
	});
});
