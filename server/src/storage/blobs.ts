import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync, unlinkSync } from "node:fs";
import {
	type ChunkDigest,
	chunkSize,
	markBlobLocal,
	recordManifest,
} from "../cluster/placement.ts";
import { type ContentBlobRow, type FileRow, nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { safeJoin, storageRoot } from "./paths.ts";

/** Mirrors app/storage/blobs.py: content-addressed dedup with ref counting. */

export interface FileHashes {
	sha256: string;
	sha1: string;
	md5: string;
	blake2b: string;
}

export interface HashedFile extends FileHashes {
	/** The chunk manifest of the same bytes (cluster/placement.ts, §5.11),
	 * computed in this pass rather than in a second read of the file. */
	chunks: ChunkDigest[];
}

export async function hashFile(
	path: string,
	opts: { chunkSize?: number } = {},
): Promise<HashedFile> {
	const sha256 = createHash("sha256");
	const sha1 = createHash("sha1");
	const md5 = createHash("md5");
	// Python hashlib.blake2b defaults to a 64-byte digest == blake2b512.
	const blake2b = createHash("blake2b512");
	const size = opts.chunkSize ?? chunkSize();
	const chunks: ChunkDigest[] = [];
	let chunkHash = createHash("sha256");
	let chunkBytes = 0;

	const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		sha256.update(chunk);
		sha1.update(chunk);
		md5.update(chunk);
		blake2b.update(chunk);
		// A read is 1 MiB and a chunk is 16 MiB, but nothing guarantees the
		// alignment, so the boundary is cut here rather than assumed.
		let cursor = 0;
		while (cursor < chunk.length) {
			const take = Math.min(size - chunkBytes, chunk.length - cursor);
			chunkHash.update(chunk.subarray(cursor, cursor + take));
			chunkBytes += take;
			cursor += take;
			if (chunkBytes === size) {
				chunks.push({ sha256: chunkHash.digest("hex"), size: chunkBytes });
				chunkHash = createHash("sha256");
				chunkBytes = 0;
			}
		}
	}
	if (chunkBytes > 0) {
		chunks.push({ sha256: chunkHash.digest("hex"), size: chunkBytes });
	}
	return {
		sha256: sha256.digest("hex"),
		sha1: sha1.digest("hex"),
		md5: md5.digest("hex"),
		blake2b: blake2b.digest("hex"),
		chunks,
	};
}

/** Register a stored file as a content blob, reusing an existing blob when the
 * stored-content hash and transform key match. The upload pipeline has already
 * renamed the work file to `finalPath`; on dedup the duplicate bytes are
 * removed and the existing canonical row returned. */
export function attachBlob(
	db: Db,
	opts: {
		finalPath: string;
		relPath: string;
		logicalSize: number;
		contentType: string;
		hashes: FileHashes;
		storedHashes?: FileHashes;
		transformKey?: string;
		/** The stored bytes' chunk manifest (§5.11), from the same pass that
		 * produced `storedHashes`. Absent means the caller doesn't chunk — the
		 * blob is then recorded as a single whole-file chunk by the legacy seed
		 * pass, exactly like a blob that predates this phase. */
		storedChunks?: ChunkDigest[];
		/** Whether the bytes this node just wrote are a durability copy. True
		 * everywhere except a `REPLICATION_MODE=cache` node, where a fresh
		 * upload is simply the newest cache entry. */
		pinned?: boolean;
	},
): ContentBlobRow {
	const transformKey = opts.transformKey ?? "plain";
	const storedSha256 = (opts.storedHashes ?? opts.hashes).sha256;
	// Archived blobs are excluded from dedup matching: their bytes are
	// currently zstd-compressed on disk, not the plain representation the
	// (sha256, transform_key) identity was minted for, and archiving only ever
	// happens to a ref_count == 1 blob (see lifecycle.ts::sharedBlob). A new
	// upload that matches an archived blob's content just gets its own fresh,
	// dedup-eligible blob rather than reusing compressed bytes it can't read.
	const existing = db.get<ContentBlobRow>(
		"SELECT * FROM content_blobs WHERE stored_sha256 = $sha AND transform_key = $tk AND archived = 0",
		{ $sha: storedSha256, $tk: transformKey },
	);
	if (existing) {
		db.run(
			"UPDATE content_blobs SET ref_count = ref_count + 1 WHERE id = $id",
			{ $id: existing.id },
		);
		try {
			if (existsSync(opts.finalPath)) unlinkSync(opts.finalPath);
		} catch {
			// best-effort cleanup; orphaned bytes are reconciled by lifecycle jobs
		}
		existing.ref_count += 1;
		// The duplicate's bytes were just deleted; the canonical blob's are what
		// this node now holds a second reference to. Marking presence (rather
		// than a manifest) is all a dedup hit may do -- the manifest belongs to
		// whoever created the blob, and minting a second one here would ship a
		// duplicate set of rows to every peer.
		if (blobBytesComplete(existing)) {
			markBlobLocal(db, existing.id, { pinned: opts.pinned !== false });
		}
		return existing;
	}

	db.run(
		`INSERT INTO content_blobs (
       storage_path, content_type, size_bytes, stored_size_bytes,
       sha256, sha1, md5, blake2b, stored_sha256, transform_key, ref_count, created_at
     ) VALUES ($path, $ct, $size, $stored, $sha256, $sha1, $md5, $blake2b, $storedSha, $tk, 1, $createdAt)`,
		{
			$path: opts.relPath,
			$ct: opts.contentType,
			$size: opts.logicalSize,
			$stored: statSync(opts.finalPath).size,
			$sha256: opts.hashes.sha256,
			$sha1: opts.hashes.sha1,
			$md5: opts.hashes.md5,
			$blake2b: opts.hashes.blake2b,
			$storedSha: storedSha256,
			$tk: transformKey,
			$createdAt: nowIso(),
		},
	);
	const created = db.get<ContentBlobRow>(
		"SELECT * FROM content_blobs WHERE id = last_insert_rowid()",
	)!;
	// The manifest is minted here, on the node that created the blob, and
	// replicates from here. Every other node reads it rather than computing
	// it, which is what keeps one manifest per blob cluster-wide.
	if (opts.storedChunks?.length) {
		recordManifest(db, created.id, opts.storedChunks);
		markBlobLocal(db, created.id, { pinned: opts.pinned !== false });
	}
	return created;
}

/** Whether this node's copy of a blob's bytes is whole — the file exists and
 * is exactly as long as the row says. */
function blobBytesComplete(blob: ContentBlobRow): boolean {
	let path: string;
	try {
		path = safeJoin(storageRoot(), blob.storage_path);
	} catch {
		return false;
	}
	if (!existsSync(path)) return false;
	return statSync(path).size === blob.stored_size_bytes;
}

export function fileHashes(db: Db, file: FileRow): Partial<FileHashes> {
	const blob = file.blob_id
		? db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", {
				$id: file.blob_id,
			})
		: undefined;
	if (!blob) return {};
	return {
		sha256: blob.sha256,
		sha1: blob.sha1,
		md5: blob.md5,
		blake2b: blob.blake2b,
	};
}

/** Decrement the blob's ref count, deleting the row and returning the physical
 * path to unlink (after commit) only when the last reference is removed. */
export function releaseBlob(db: Db, file: FileRow): string | null {
	const blob = file.blob_id
		? db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", {
				$id: file.blob_id,
			})
		: undefined;
	if (!blob) {
		try {
			return safeJoin(storageRoot(), file.storage_path);
		} catch {
			return null;
		}
	}
	const newCount = Math.max(0, blob.ref_count - 1);
	if (newCount > 0) {
		db.run("UPDATE content_blobs SET ref_count = $n WHERE id = $id", {
			$n: newCount,
			$id: blob.id,
		});
		return null;
	}
	let full: string | null;
	try {
		full = safeJoin(storageRoot(), blob.storage_path);
	} catch {
		full = null;
	}
	// Clear the file's FK before deleting the blob row so SQLite never sees a
	// live files.blob_id reference during blob deletion.
	db.run("UPDATE files SET blob_id = NULL WHERE id = $id", { $id: file.id });
	// Explicitly, not by the ON DELETE CASCADE the schema also declares: a
	// cascade only fires the change-log triggers with recursive_triggers on, and
	// a manifest that is deleted here but nowhere else would leave every peer
	// pointing at chunks of a blob that no longer exists. The location rows
	// stay: each node deletes its own once the manifest is gone
	// (cluster/placement.ts::gcOrphanChunks), because they are the only rows it
	// may write.
	db.run("DELETE FROM blob_chunks WHERE blob_id = $id", { $id: blob.id });
	db.run("DELETE FROM content_blobs WHERE id = $id", { $id: blob.id });
	return full;
}

export function unlinkQueued(paths: Array<string | null>): void {
	for (const path of paths) {
		if (!path) continue;
		try {
			if (existsSync(path)) unlinkSync(path);
		} catch {
			// ignore — already gone or unwritable; reconcile job sweeps leftovers
		}
	}
}
