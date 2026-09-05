import { createHash } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { touchBlobAccess } from "../cluster/cacheEviction.ts";
import { type ContentBlobRow, type FileRow, nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { hashInWorker } from "./hashPool.ts";
import { safeJoin, storageRoot } from "./paths.ts";

/** Mirrors app/storage/blobs.py: content-addressed dedup with ref counting. */

/** The digests every new blob carries.
 *
 * Was four (sha256, sha1, md5, blake2b512). Nothing in this codebase ever
 * *consumed* the extra three -- dedup keys on `stored_sha256`, and sha1/blake2b
 * only ever reached the API's `hashes` field and replication's column list --
 * but all four ran over every uploaded byte, which measured 125 MB/s against
 * 312 MB/s for sha256 alone. The two kept here run one-per-worker in parallel
 * (storage/hashPool.ts), so md5 hides behind sha256 and costs ~4%.
 *
 * The `sha1` and `blake2b` columns still exist on `content_blobs` and still
 * replicate; new rows simply leave them at their schema default. Blobs written
 * before this change keep the digests they were minted with, and `fileHashes`
 * still reports them. */
export interface FileHashes {
	sha256: string;
	md5: string;
}

/** Both digests, fed incrementally on the calling thread.
 *
 * Only for a caller that is *already* streaming the bytes for another reason
 * and can fold the digests into that pass -- currently just
 * `routes/files.ts::assembleChunks`, which hashes while copying a legacy-layout
 * upload it has to read anyway. Every other caller wants `hashFile`, which runs
 * off the event loop; this one blocks it. */
export interface Hashers {
	update(chunk: Buffer): void;
	digest(): FileHashes;
}

export function createHashers(): Hashers {
	const sha256 = createHash("sha256");
	const md5 = createHash("md5");
	return {
		update(chunk: Buffer) {
			sha256.update(chunk);
			md5.update(chunk);
		},
		digest: () => ({
			sha256: sha256.digest("hex"),
			md5: md5.digest("hex"),
		}),
	};
}

/** Every digest of `path`, each computed in its own worker thread.
 *
 * The two run concurrently and neither touches this thread, so a multi-GB
 * finalize no longer freezes the server for the length of the hash -- see
 * storage/hashWorker.ts for the measurements. */
export async function hashFile(path: string): Promise<FileHashes> {
	const [sha256, md5] = await Promise.all([
		hashInWorker(path, "sha256"),
		hashInWorker(path, "md5"),
	]);
	return { sha256, md5 };
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
		touchBlobAccess(db, existing.id);
		return existing;
	}

	// `sha1` and `blake2b` are omitted, not passed empty: the columns carry a
	// `DEFAULT ''` and are no longer computed (see FileHashes). Naming them here
	// would only restate the default, and would hide the fact that nothing
	// produces them any more.
	db.run(
		`INSERT INTO content_blobs (
       storage_path, content_type, size_bytes, stored_size_bytes,
       sha256, md5, stored_sha256, transform_key, ref_count, created_at
     ) VALUES ($path, $ct, $size, $stored, $sha256, $md5, $storedSha, $tk, 1, $createdAt)`,
		{
			$path: opts.relPath,
			$ct: opts.contentType,
			$size: opts.logicalSize,
			$stored: statSync(opts.finalPath).size,
			$sha256: opts.hashes.sha256,
			$md5: opts.hashes.md5,
			$storedSha: storedSha256,
			$tk: transformKey,
			$createdAt: nowIso(),
		},
	);
	const created = db.get<ContentBlobRow>(
		"SELECT * FROM content_blobs WHERE id = last_insert_rowid()",
	)!;
	touchBlobAccess(db, created.id);
	return created;
}

/** The digests actually recorded for this file's blob.
 *
 * Reports the columns rather than a fixed shape, and omits empty ones. A blob
 * minted before the digest set shrank still holds real sha1/blake2b values and
 * keeps publishing them; a new one carries sha256 + md5 and simply says so,
 * instead of advertising two empty strings as if they were digests. */
export function fileHashes(db: Db, file: FileRow): Record<string, string> {
	const blob = file.blob_id
		? db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", {
				$id: file.blob_id,
			})
		: undefined;
	if (!blob) return {};
	const all: Record<string, string> = {
		sha256: blob.sha256,
		sha1: blob.sha1,
		md5: blob.md5,
		blake2b: blob.blake2b,
	};
	return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
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
