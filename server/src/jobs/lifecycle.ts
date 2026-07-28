import { existsSync, statSync, renameSync, unlinkSync, createWriteStream } from "node:fs";
import type { Db } from "../db/types.ts";
import { nowIso, type ContentBlobRow, type FileRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { HttpError } from "../httpError.ts";
import { recordAudit } from "../audit.ts";
import { getPermissions } from "../permissions.ts";
import { storageRoot, safeJoin } from "../storage/paths.ts";
import { compressFile, shouldCompress, decompressStream } from "../storage/compress.ts";
import { releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";
import { ensureStorageSettings, usedStorageBytes, usedStorageBytesForUser, diskUsageBytes } from "../storage/accounting.ts";

/** Mirrors app/jobs/lifecycle.py -- background lifecycle sweeps plus the
 * archive/unarchive "core" logic shared with the manual admin routes
 * (app/routes/admin.py::_archive_file_core / _unarchive_file_core). */

const log = getLogger("app.jobs.lifecycle");
const DEFAULT_ARCHIVE_IDLE_DAYS = 5;

function nowMs(): number {
  return Date.now();
}

function fileRow(db: Db, id: number): FileRow | undefined {
  return db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: id });
}

function blobRow(db: Db, blobId: number | null): ContentBlobRow | undefined {
  if (!blobId) return undefined;
  return db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", { $id: blobId });
}

/** Deletes one file record: drops its links, releases its blob ref, deletes
 * the row. Mirrors app/jobs/lifecycle.py::_delete_file -- unlike the admin
 * bulk-delete path (queueFileDelete in routes/admin.ts) this does NOT adjust
 * directory total_bytes, matching the Python job's behavior. Returns the
 * physical path to unlink once the caller's batch has committed. */
function deleteFileForJob(db: Db, f: FileRow): string | null {
  db.run("DELETE FROM links WHERE file_id = $id", { $id: f.id });
  const path = releaseBlob(db, f);
  db.run("DELETE FROM files WHERE id = $id", { $id: f.id });
  deleteThumbnail(f.id);
  log.info(`lifecycle deleted file file_id=${f.id} storage_path=${f.storage_path}`);
  return path;
}

/** Archives idle, compressible, non-client-encrypted files (zstd repack in
 * place). Mirrors app/jobs/lifecycle.py::archive_idle_job. */
export async function archiveIdleJob(db: Db): Promise<number> {
  let processed = 0;
  let scanned = 0;
  let skippedRecent = 0;
  const unlinkAfterCommit: Array<string | null> = [];

  const candidates = db.all<FileRow>(
    `SELECT * FROM files WHERE lifecycle_state = 'active' AND archived = 0 AND encryption_mode != 'client'`,
  );
  log.info(`archive idle job started candidates=${candidates.length}`);

  for (const f0 of candidates) {
    scanned++;
    let f = f0;
    const idleDays = f.archive_after_idle_days ?? DEFAULT_ARCHIVE_IDLE_DAYS;
    const thresholdMs = nowMs() - idleDays * 86400 * 1000;
    const lastMs = new Date(f.last_downloaded_at ?? f.created_at).getTime();
    if (lastMs > thresholdMs) {
      skippedRecent++;
      continue;
    }
    processed++;

    if (f.compressed || !shouldCompress(f.content_type)) {
      db.run("UPDATE files SET lifecycle_state = 'archived' WHERE id = $id", { $id: f.id });
      log.info(`archive idle job marked archived file_id=${f.id} reason=already_compressed_or_incompressible`);
      continue;
    }

    const blob = blobRow(db, f.blob_id);
    if (blob && (blob.ref_count ?? 1) > 1) {
      db.run("UPDATE files SET lifecycle_state = 'archived' WHERE id = $id", { $id: f.id });
      log.info(`archive idle job skipped shared blob file_id=${f.id} blob_id=${blob.id} ref_count=${blob.ref_count}`);
      continue;
    }

    let src: string;
    try {
      src = safeJoin(storageRoot(), f.storage_path);
    } catch {
      src = "";
    }
    if (!src || !existsSync(src)) {
      log.warning(`archive: storage missing for file ${f.id}; removing stale record`);
      unlinkAfterCommit.push(deleteFileForJob(db, f));
      unlinkQueued(unlinkAfterCommit);
      unlinkAfterCommit.length = 0;
      continue;
    }

    const tmp = `${src}.arch.tmp`;
    try {
      db.run("UPDATE files SET lifecycle_state = 'archiving' WHERE id = $id", { $id: f.id });
      const original = f.stored_size_bytes || statSync(src).size;
      await compressFile(src, tmp);
      renameSync(tmp, src);
      const stored = statSync(src).size;
      const saved = Math.max(0, original - stored);
      db.run(
        `UPDATE files SET stored_size_bytes = $stored, archive_original_stored_size_bytes = $orig,
           archive_saved_bytes = $saved, archived = 1, archive_codec = 'zstd', lifecycle_state = 'archived'
         WHERE id = $id`,
        { $stored: stored, $orig: original, $saved: saved, $id: f.id },
      );
      if (blob) {
        db.run("UPDATE content_blobs SET stored_size_bytes = $stored, archived = 1 WHERE id = $id", {
          $stored: stored,
          $id: blob.id,
        });
      }
      log.info(
        `archive idle job archived file_id=${f.id} original_bytes=${original} stored_bytes=${stored} saved_bytes=${saved}`,
      );
    } catch (err) {
      log.error(`archive failed for file ${f.id}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best-effort
      }
      db.run("UPDATE files SET lifecycle_state = 'active' WHERE id = $id", { $id: f.id });
    }
  }

  log.info(`archive idle job completed scanned=${scanned} skipped_recent=${skippedRecent} processed=${processed}`);
  return processed;
}

/** Deletes files whose delete_if_idle_days has elapsed since last download
 * (or creation). Mirrors app/jobs/lifecycle.py::delete_idle_job. */
export function deleteIdleJob(db: Db): number {
  let processed = 0;
  let scanned = 0;
  const unlinkAfterCommit: Array<string | null> = [];

  const files = db.all<FileRow>("SELECT * FROM files WHERE delete_if_idle_days IS NOT NULL");
  log.info(`idle delete job started candidates=${files.length}`);
  for (const f of files) {
    scanned++;
    const lastMs = new Date(f.last_downloaded_at ?? f.created_at).getTime();
    if (nowMs() - lastMs < (f.delete_if_idle_days ?? 0) * 86400 * 1000) continue;
    unlinkAfterCommit.push(deleteFileForJob(db, f));
    processed++;
  }
  unlinkQueued(unlinkAfterCommit);
  log.info(`idle delete job completed scanned=${scanned} processed=${processed}`);
  return processed;
}

/** Deletes non-permanent files past their expires_at. Mirrors
 * app/jobs/lifecycle.py::temp_expiry_job. */
export function tempExpiryJob(db: Db): number {
  let processed = 0;
  const unlinkAfterCommit: Array<string | null> = [];
  const now = nowIso();
  const files = db.all<FileRow>(
    "SELECT * FROM files WHERE is_permanent = 0 AND expires_at IS NOT NULL AND expires_at < $now",
    { $now: now },
  );
  log.info(`temp expiry job started candidates=${files.length}`);
  for (const f of files) {
    unlinkAfterCommit.push(deleteFileForJob(db, f));
    processed++;
  }
  unlinkQueued(unlinkAfterCommit);
  log.info(`temp expiry job completed processed=${processed}`);
  return processed;
}

/** Deactivates links past their expires_at. Mirrors
 * app/jobs/lifecycle.py::link_expiry_job. */
export function linkExpiryJob(db: Db): number {
  log.info("link expiry job started");
  const now = nowIso();
  const rows = db.all<{ id: number }>(
    "UPDATE links SET active = 0 WHERE expires_at IS NOT NULL AND expires_at < $now AND active = 1 RETURNING id",
    { $now: now },
  );
  const processed = rows.length;
  log.info(`link expiry job completed processed=${processed}`);
  return processed;
}

/** Resets files stuck mid-transition (crash during archive/unarchive) back to
 * a stable lifecycle_state. Mirrors app/jobs/lifecycle.py::reconcile_stale_states. */
export function reconcileStaleStates(db: Db): number {
  const stale = db.all<FileRow>("SELECT * FROM files WHERE lifecycle_state IN ('archiving', 'unarchiving')");
  log.info(`lifecycle reconcile started stale=${stale.length}`);
  for (const f of stale) {
    log.warning(`resetting stale lifecycle_state for file ${f.id}`);
    db.run("UPDATE files SET lifecycle_state = $state WHERE id = $id", {
      $state: f.archived ? "archived" : "active",
      $id: f.id,
    });
  }
  log.info(`lifecycle reconcile completed processed=${stale.length}`);
  return stale.length;
}

export interface FileLifecycleSummary {
  id: number;
  archived: boolean;
  lifecycle_state: string;
  stored_size_bytes: number;
  archive_original_stored_size_bytes: number;
  archive_saved_bytes: number;
}

export function serializeFileLifecycle(f: FileRow): FileLifecycleSummary {
  return {
    id: f.id,
    archived: !!f.archived,
    lifecycle_state: f.lifecycle_state,
    stored_size_bytes: f.stored_size_bytes,
    archive_original_stored_size_bytes: f.archive_original_stored_size_bytes,
    archive_saved_bytes: f.archive_saved_bytes,
  };
}

/** Returns the file's ContentBlob iff its physical bytes are shared
 * (ref_count > 1). Archiving/unarchiving rewrites bytes in place, which would
 * corrupt every sibling file that still expects the old bytes, so those
 * operations must refuse shared blobs. Mirrors admin.py::_shared_blob. */
function sharedBlob(db: Db, f: FileRow): ContentBlobRow | null {
  const blob = blobRow(db, f.blob_id);
  return blob && (blob.ref_count ?? 1) > 1 ? blob : null;
}

/** Archives one file on demand (manual admin trigger or bulk action).
 * Mirrors app/routes/admin.py::_archive_file_core. Authorization is the
 * caller's responsibility. */
export async function archiveFileCore(
  db: Db,
  opts: { actor: string; ip: string | null; file: FileRow },
): Promise<FileLifecycleSummary> {
  const { actor, ip } = opts;
  let f = opts.file;
  log.info(`archive requested file_id=${f.id} owner_id=${f.owner_id} actor=${actor}`);
  if (f.archived) return serializeFileLifecycle(f);
  if (f.encryption_mode === "client") {
    throw new HttpError(400, "client-side encrypted files cannot be archived server-side");
  }

  const shared = sharedBlob(db, f);
  if (f.compressed || !shouldCompress(f.content_type) || shared) {
    db.run("UPDATE files SET lifecycle_state = 'archived' WHERE id = $id", { $id: f.id });
    log.info(`archive marked file archived without recompressing file_id=${f.id}`);
    return serializeFileLifecycle(fileRow(db, f.id)!);
  }

  const blob = blobRow(db, f.blob_id);
  const src = safeJoin(storageRoot(), f.storage_path);
  if (!existsSync(src)) throw new HttpError(500, "file missing from storage");
  const original = f.stored_size_bytes || statSync(src).size;
  const tmp = `${src}.manual-archive.tmp`;
  try {
    db.run("UPDATE files SET lifecycle_state = 'archiving' WHERE id = $id", { $id: f.id });
    await compressFile(src, tmp);
    renameSync(tmp, src);
    const stored = statSync(src).size;
    const saved = Math.max(0, original - stored);
    db.run(
      `UPDATE files SET stored_size_bytes = $stored, archive_original_stored_size_bytes = $orig,
         archive_saved_bytes = $saved, archived = 1, archive_codec = 'zstd', lifecycle_state = 'archived'
       WHERE id = $id`,
      { $stored: stored, $orig: original, $saved: saved, $id: f.id },
    );
    if (blob) {
      db.run("UPDATE content_blobs SET stored_size_bytes = $stored, archived = 1 WHERE id = $id", {
        $stored: stored,
        $id: blob.id,
      });
    }
    recordAudit(db, { actor, action: "file.archived", target: `file:${f.id}`, ip });
    f = fileRow(db, f.id)!;
    log.info(
      `archive completed file_id=${f.id} original_bytes=${original} stored_bytes=${stored} saved_bytes=${saved}`,
    );
    return serializeFileLifecycle(f);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort
    }
    db.run("UPDATE files SET lifecycle_state = 'active' WHERE id = $id", { $id: f.id });
    log.error(`archive failed file_id=${f.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    throw err;
  }
}

/** Restores one archived file's bytes on demand. Mirrors
 * app/routes/admin.py::_unarchive_file_core, including the owner-quota,
 * global-cap, and free-disk-space guards. */
export async function unarchiveFileCore(
  db: Db,
  opts: { actor: string; ip: string | null; file: FileRow },
): Promise<FileLifecycleSummary> {
  const { actor, ip } = opts;
  let f = opts.file;
  log.info(`unarchive requested file_id=${f.id} owner_id=${f.owner_id} actor=${actor}`);
  if (!f.archived) return serializeFileLifecycle(f);
  if (sharedBlob(db, f)) {
    throw new HttpError(409, "file shares deduplicated storage with other files and cannot be unarchived");
  }

  const blob = blobRow(db, f.blob_id);
  const src = safeJoin(storageRoot(), f.storage_path);
  if (!existsSync(src)) throw new HttpError(500, "file missing from storage");

  const original = f.archive_original_stored_size_bytes || f.size_bytes;
  const extraNeeded = Math.max(0, original - (f.stored_size_bytes || statSync(src).size));
  const perm = getPermissions(db, f.owner_id);
  const ownerUsedAfter = usedStorageBytesForUser(db, f.owner_id) + extraNeeded;
  if (perm && ownerUsedAfter > perm.quota_bytes) {
    throw new HttpError(413, "unarchive would exceed user quota");
  }
  const settings = ensureStorageSettings(db);
  if (usedStorageBytes(db) + extraNeeded > settings.global_storage_quota_bytes) {
    throw new HttpError(413, "unarchive would exceed global storage allocation");
  }
  const disk = diskUsageBytes();
  if (disk !== null && disk.free < extraNeeded) {
    throw new HttpError(507, "not enough free disk space to unarchive");
  }

  const tmp = `${src}.manual-unarchive.tmp`;
  try {
    db.run("UPDATE files SET lifecycle_state = 'unarchiving' WHERE id = $id", { $id: f.id });
    await new Promise<void>((resolvePromise, reject) => {
      const out = createWriteStream(tmp);
      out.on("error", reject);
      (async () => {
        try {
          for await (const chunk of decompressStream(src, original)) {
            if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
          }
          out.end(() => resolvePromise());
        } catch (err) {
          out.destroy();
          reject(err);
        }
      })();
    });
    renameSync(tmp, src);
    const restored = statSync(src).size;
    db.run(
      `UPDATE files SET stored_size_bytes = $stored, archived = 0, archive_codec = NULL,
         archive_original_stored_size_bytes = 0, archive_saved_bytes = 0, lifecycle_state = 'active',
         last_downloaded_at = $now
       WHERE id = $id`,
      { $stored: restored, $now: nowIso(), $id: f.id },
    );
    if (blob) {
      db.run("UPDATE content_blobs SET stored_size_bytes = $stored, archived = 0 WHERE id = $id", {
        $stored: restored,
        $id: blob.id,
      });
    }
    recordAudit(db, { actor, action: "file.unarchived", target: `file:${f.id}`, ip });
    f = fileRow(db, f.id)!;
    log.info(`unarchive completed file_id=${f.id} restored_bytes=${restored}`);
    return serializeFileLifecycle(f);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort
    }
    db.run("UPDATE files SET lifecycle_state = 'archived' WHERE id = $id", { $id: f.id });
    log.error(`unarchive failed file_id=${f.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    throw err;
  }
}
