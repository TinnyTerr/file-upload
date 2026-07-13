import { statfsSync } from "node:fs";
import type { Db } from "../db/types.ts";
import { nowIso, type PermissionRow, type StorageSettingsRow } from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { storageRoot } from "./paths.ts";

/** Mirrors app/storage/accounting.py (cluster peers excluded — cluster port
 * is deferred, so cluster_used_storage_bytes degrades to local usage). */

const GB = 1024 ** 3;
export const DEFAULT_GLOBAL_STORAGE_QUOTA_BYTES = 500 * GB;

interface SumRow {
  total: number | null;
}

export function ensureStorageSettings(db: Db): StorageSettingsRow {
  const existing = db.get<StorageSettingsRow>("SELECT * FROM storage_settings WHERE id = 1");
  if (existing) return existing;
  const now = nowIso();
  db.run(
    `INSERT INTO storage_settings (id, global_storage_quota_bytes, created_at, updated_at)
     VALUES (1, $quota, $now, $now)`,
    { $quota: DEFAULT_GLOBAL_STORAGE_QUOTA_BYTES, $now: now },
  );
  return db.get<StorageSettingsRow>("SELECT * FROM storage_settings WHERE id = 1")!;
}

export function usedStorageBytes(db: Db): number {
  return db.get<SumRow>("SELECT SUM(stored_size_bytes) as total FROM content_blobs")?.total ?? 0;
}

export function usedStorageBytesForUser(db: Db, userId: number): number {
  return (
    db.get<SumRow>("SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id", { $id: userId })?.total ?? 0
  );
}

export function logicalStorageBytes(db: Db): number {
  return db.get<SumRow>("SELECT SUM(size_bytes) as total FROM files")?.total ?? 0;
}

export function dedupSavedBytes(db: Db): number {
  return Math.max(0, logicalStorageBytes(db) - usedStorageBytes(db));
}

export function allocatedQuotaBytes(db: Db): number {
  return db.get<SumRow>("SELECT SUM(quota_bytes) as total FROM permissions")?.total ?? 0;
}

export function allocatedQuotaBytesWithOverride(db: Db, opts: { userId: number; quotaBytes: number }): number {
  let total = 0;
  for (const perm of db.all<PermissionRow>("SELECT * FROM permissions")) {
    total += perm.user_id === opts.userId ? opts.quotaBytes : perm.quota_bytes;
  }
  return total;
}

function diskUsage(): { total: number; free: number } | null {
  try {
    const s = statfsSync(storageRoot());
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

/** Exported so lifecycle/admin code (e.g. the unarchive free-space guard) can
 * read both total and free bytes without duplicating the statfs call. */
export function diskUsageBytes(): { total: number; free: number } | null {
  return diskUsage();
}

export function physicalStorageCapacityBytes(): number | null {
  return diskUsage()?.total ?? null;
}

export function validateAllocatedQuotaCapacity(allocatedBytes: number): void {
  const capacity = physicalStorageCapacityBytes();
  if (capacity !== null && allocatedBytes > capacity) {
    throw new HttpError(400, "user quotas would exceed available disk space");
  }
}

export function validateGlobalStorageCap(db: Db, capBytes: number): void {
  const minimum = Math.max(usedStorageBytes(db), allocatedQuotaBytes(db));
  if (capBytes < minimum) {
    throw new HttpError(400, "global storage cap cannot be below current usage or allocated user quotas");
  }
  const capacity = physicalStorageCapacityBytes();
  if (capacity !== null && capBytes > capacity) {
    throw new HttpError(400, "global storage cap cannot exceed available disk space");
  }
}

export function enforceGlobalUploadCapacity(db: Db, incomingBytes: number): void {
  const settings = ensureStorageSettings(db);
  if (usedStorageBytes(db) + incomingBytes > settings.global_storage_quota_bytes) {
    throw new HttpError(413, "upload would exceed global storage allocation");
  }
  const usage = diskUsage();
  if (usage !== null && usage.free < incomingBytes) {
    throw new HttpError(507, "not enough free disk space");
  }
}

export function setGlobalStorageCap(db: Db, capBytes: number): StorageSettingsRow {
  validateGlobalStorageCap(db, capBytes);
  ensureStorageSettings(db);
  db.run("UPDATE storage_settings SET global_storage_quota_bytes = $cap, updated_at = $now WHERE id = 1", {
    $cap: capBytes,
    $now: nowIso(),
  });
  return db.get<StorageSettingsRow>("SELECT * FROM storage_settings WHERE id = 1")!;
}
