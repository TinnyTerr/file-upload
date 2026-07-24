import { createHash } from "node:crypto";
import { createReadStream, existsSync, unlinkSync } from "node:fs";
import { statSync } from "node:fs";
import type { Db } from "../db/types.ts";
import { nowIso, type ContentBlobRow, type FileRow } from "../db/rows.ts";
import { safeJoin, storageRoot } from "./paths.ts";
import { touchBlobAccess } from "../cluster/cacheEviction.ts";

/** Mirrors app/storage/blobs.py: content-addressed dedup with ref counting. */

export interface FileHashes {
  sha256: string;
  sha1: string;
  md5: string;
  blake2b: string;
}

export async function hashFile(path: string): Promise<FileHashes> {
  const sha256 = createHash("sha256");
  const sha1 = createHash("sha1");
  const md5 = createHash("md5");
  // Python hashlib.blake2b defaults to a 64-byte digest == blake2b512.
  const blake2b = createHash("blake2b512");
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    sha256.update(chunk);
    sha1.update(chunk);
    md5.update(chunk);
    blake2b.update(chunk);
  }
  return {
    sha256: sha256.digest("hex"),
    sha1: sha1.digest("hex"),
    md5: md5.digest("hex"),
    blake2b: blake2b.digest("hex"),
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
    db.run("UPDATE content_blobs SET ref_count = ref_count + 1 WHERE id = $id", { $id: existing.id });
    try {
      if (existsSync(opts.finalPath)) unlinkSync(opts.finalPath);
    } catch {
      // best-effort cleanup; orphaned bytes are reconciled by lifecycle jobs
    }
    existing.ref_count += 1;
    touchBlobAccess(db, existing.id);
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
  const created = db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = last_insert_rowid()")!;
  touchBlobAccess(db, created.id);
  return created;
}

export function fileHashes(db: Db, file: FileRow): Partial<FileHashes> {
  const blob = file.blob_id
    ? db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", { $id: file.blob_id })
    : undefined;
  if (!blob) return {};
  return { sha256: blob.sha256, sha1: blob.sha1, md5: blob.md5, blake2b: blob.blake2b };
}

/** Decrement the blob's ref count, deleting the row and returning the physical
 * path to unlink (after commit) only when the last reference is removed. */
export function releaseBlob(db: Db, file: FileRow): string | null {
  const blob = file.blob_id
    ? db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", { $id: file.blob_id })
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
    db.run("UPDATE content_blobs SET ref_count = $n WHERE id = $id", { $n: newCount, $id: blob.id });
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
