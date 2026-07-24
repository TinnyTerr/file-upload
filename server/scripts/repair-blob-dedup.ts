import { existsSync, statSync, unlinkSync } from "node:fs";
import { loadSettings } from "../src/config.ts";
import { createDb } from "../src/db/index.ts";
import { safeJoin, storageRoot } from "../src/storage/paths.ts";
import type { ContentBlobRow, FileRow } from "../src/db/rows.ts";

/**
 * One-off repair for servers that hit the pre-fix bug where archiving a blob
 * mutated content_blobs.transform_key (appending "|archived") instead of
 * setting the new `archived` column. That permanently broke dedup matching
 * for that content, so re-uploads of the same bytes silently created a
 * second, duplicate blob alongside the (now-compressed) original.
 *
 * This script:
 *   1. Strips any lingering "|archived" suffix baked into transform_key,
 *      since archive state now lives in content_blobs.archived instead.
 *   2. Finds blobs left as true duplicates (same stored_sha256 + cleaned
 *      transform_key, both un-archived, both still ref'd by files) and merges
 *      them: repoints files.blob_id at the surviving blob, sums ref_count,
 *      deletes the loser row, and deletes the loser's now-unreferenced bytes.
 *
 * Dry-run by default. Pass --apply to actually write changes.
 *
 * Usage:
 *   bun scripts/repair-blob-dedup.ts            # report only
 *   bun scripts/repair-blob-dedup.ts --apply     # fix it
 */

const APPLY = process.argv.includes("--apply");

const settings = loadSettings();
const db = createDb(settings.databaseUrl);

function log(msg: string): void {
  console.log(msg);
}

log(`repair-blob-dedup starting (${APPLY ? "APPLY" : "dry-run"})`);

// Step 1: strip stale "|archived" suffixes now that archive state has its
// own column. Safe to do unconditionally -- transform_key is just an
// identity key, and the physical bytes/format are unaffected by this rename.
const suffixed = db.all<ContentBlobRow>("SELECT * FROM content_blobs WHERE transform_key LIKE '%|archived%'");
log(`found ${suffixed.length} blob(s) with a stale "|archived" transform_key suffix`);
for (const blob of suffixed) {
  const cleaned = blob.transform_key.replace(/(\|archived)+$/, "");
  log(`  blob ${blob.id}: "${blob.transform_key}" -> "${cleaned}"`);
  if (APPLY) {
    db.run("UPDATE content_blobs SET transform_key = $tk WHERE id = $id", { $tk: cleaned, $id: blob.id });
  }
}

// Step 2: find true duplicates -- same (stored_sha256, transform_key) after
// cleanup, neither archived (archived blobs are a single physical
// representation and are left alone; they'll naturally re-merge only if
// unarchived later and still duplicated).
const groups = db.all<{ stored_sha256: string; transform_key: string; ids: string; cnt: number }>(
  `SELECT stored_sha256, transform_key, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
   FROM content_blobs
   WHERE archived = 0
   GROUP BY stored_sha256, transform_key
   HAVING COUNT(*) > 1`,
);
log(`found ${groups.length} group(s) of duplicate blobs to merge`);

let bytesReclaimed = 0;
let blobsMerged = 0;

for (const group of groups) {
  const ids = group.ids.split(",").map(Number);
  const blobs = ids
    .map((id) => db.get<ContentBlobRow>("SELECT * FROM content_blobs WHERE id = $id", { $id: id })!)
    .sort((a, b) => a.id - b.id);
  const survivor = blobs[0]!;
  const losers = blobs.slice(1);

  log(`  sha256=${group.stored_sha256.slice(0, 12)}… transform_key="${group.transform_key}": keeping blob ${survivor.id}, merging ${losers.map((l) => l.id).join(", ")}`);

  for (const loser of losers) {
    const filesOnLoser = db.all<FileRow>("SELECT * FROM files WHERE blob_id = $id", { $id: loser.id });
    log(`    blob ${loser.id}: ${filesOnLoser.length} file row(s), ${loser.stored_size_bytes} stored bytes`);

    let loserPath: string | null = null;
    try {
      loserPath = safeJoin(storageRoot(), loser.storage_path);
    } catch {
      loserPath = null;
    }
    const loserExists = loserPath ? existsSync(loserPath) : false;
    const loserSize = loserExists ? statSync(loserPath!).size : 0;

    if (APPLY) {
      db.run("UPDATE files SET blob_id = $survivorId WHERE blob_id = $loserId", {
        $survivorId: survivor.id,
        $loserId: loser.id,
      });
      db.run("UPDATE content_blobs SET ref_count = ref_count + $n WHERE id = $id", {
        $n: filesOnLoser.length,
        $id: survivor.id,
      });
      db.run("DELETE FROM content_blobs WHERE id = $id", { $id: loser.id });
      if (loserExists && loserPath) {
        unlinkSync(loserPath);
        log(`    deleted duplicate bytes at ${loserPath} (${loserSize} bytes)`);
      }
    }

    bytesReclaimed += loserSize;
    blobsMerged++;
  }
}

log(
  `repair-blob-dedup ${APPLY ? "completed" : "dry-run complete"}: ${blobsMerged} duplicate blob(s), ` +
    `${(bytesReclaimed / 1024 / 1024).toFixed(1)} MiB ${APPLY ? "reclaimed" : "would be reclaimed"}`,
);
if (!APPLY) {
  log("re-run with --apply to make these changes");
}
