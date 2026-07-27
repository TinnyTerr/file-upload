import type { AppState } from "../appState.ts";
import type { Db } from "../db/types.ts";
import { nowIso, type TorrentJobRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { HttpError } from "../httpError.ts";
import { importCompletedTorrent, cleanupJobDir } from "./importer.ts";
import { deleteTorrent, isConfigured, isDoneState, isErrorState, torrentsByTag, type QbitTorrent } from "./qbittorrent.ts";

const log = getLogger("app.torrents.poller");

/** How long a job may go without qBittorrent knowing about its tag before it is
 * declared lost -- covers the gap between add and the torrent showing up, and
 * catches torrents removed from qBittorrent behind our back. */
const MISSING_GRACE_MS = 3 * 60 * 1000;

export const ACTIVE_STATUSES = ["queued", "downloading"] as const;

function fail(db: Db, job: TorrentJobRow, detail: string): void {
  db.run("UPDATE torrent_jobs SET status = 'failed', error = $err, updated_at = $now, completed_at = $now WHERE id = $id", {
    $err: detail.slice(0, 1000),
    $now: nowIso(),
    $id: job.id,
  });
  log.warning(`torrent job failed job_id=${job.id} owner_id=${job.owner_id} error=${detail}`);
}

function updateProgress(db: Db, job: TorrentJobRow, t: QbitTorrent): void {
  db.run(
    `UPDATE torrent_jobs SET status = 'downloading', name = $name, info_hash = $hash, progress = $progress,
       size_bytes = $size, downloaded_bytes = $done, dl_speed = $speed, eta_seconds = $eta, updated_at = $now
     WHERE id = $id`,
    {
      $name: t.name || job.name,
      $hash: t.hash || job.info_hash,
      $progress: t.progress ?? 0,
      $size: t.size ?? 0,
      $done: t.completed ?? 0,
      $speed: t.dlspeed ?? 0,
      // qBittorrent reports 8640000 ("∞") when it has no estimate.
      $eta: t.eta && t.eta > 0 && t.eta < 8640000 ? t.eta : null,
      $now: nowIso(),
      $id: job.id,
    },
  );
}

/** Runs the import for a job whose data is on disk, then settles the row.
 * Shared by the poller and the manual retry endpoint. */
export async function importJob(state: AppState, job: TorrentJobRow): Promise<void> {
  const { db } = state;
  db.run("UPDATE torrent_jobs SET status = 'importing', updated_at = $now WHERE id = $id", {
    $now: nowIso(),
    $id: job.id,
  });
  try {
    const result = await importCompletedTorrent(state, job);
    db.run(
      `UPDATE torrent_jobs SET status = 'completed', error = NULL, progress = 1, directory_id = $dirId,
         imported_file_count = $count, size_bytes = $size, updated_at = $now, completed_at = $now
       WHERE id = $id`,
      {
        $dirId: result.directoryId,
        $count: result.fileCount,
        $size: result.totalBytes,
        $now: nowIso(),
        $id: job.id,
      },
    );
    if (job.info_hash) await deleteTorrent(state.settings, job.info_hash, true);
    cleanupJobDir(state, job);
    log.info(`torrent job completed job_id=${job.id} owner_id=${job.owner_id} files=${result.fileCount}`);
  } catch (err) {
    // The downloaded data is deliberately left on disk so the owner can free up
    // quota and retry (POST /api/torrents/:id/retry) instead of re-downloading.
    fail(db, job, err instanceof HttpError ? String(err.detail) : err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function pollJob(state: AppState, job: TorrentJobRow): Promise<void> {
  const { db } = state;
  const torrents = await torrentsByTag(state.settings, job.tag);
  const torrent = torrents[0];

  if (!torrent) {
    if (Date.now() - new Date(job.created_at).getTime() > MISSING_GRACE_MS) {
      fail(db, job, "torrent is no longer present in qBittorrent");
    }
    return;
  }

  updateProgress(db, job, torrent);

  if (isErrorState(torrent.state)) {
    fail(db, job, `qBittorrent reported state "${torrent.state}"`);
    await deleteTorrent(state.settings, torrent.hash, true);
    cleanupJobDir(state, { ...job, info_hash: torrent.hash });
    return;
  }

  if (isDoneState(torrent.state) || (torrent.progress ?? 0) >= 1) {
    await importJob(state, { ...job, info_hash: torrent.hash, name: torrent.name || job.name });
  }
}

let running = false;

/** Scheduler job: advances every in-flight torrent and imports the finished
 * ones. Serialized via `running` so a slow import can't overlap the next tick. */
export async function torrentPollJob(state: AppState): Promise<void> {
  if (!isConfigured(state.settings) || running) return;
  running = true;
  try {
    const jobs = state.db.all<TorrentJobRow>(
      "SELECT * FROM torrent_jobs WHERE status IN ('queued', 'downloading') ORDER BY id ASC",
    );
    for (const job of jobs) {
      try {
        await pollJob(state, job);
      } catch (err) {
        log.warning(`torrent poll failed job_id=${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    running = false;
  }
}

/** A row left in `importing` means the process died mid-import. Nothing is
 * resumable from that point, so surface it as failed-but-retryable at boot. */
export function resetInterruptedImports(db: Db): void {
  const rows = db.all<{ id: number }>("SELECT id FROM torrent_jobs WHERE status = 'importing'");
  if (!rows.length) return;
  db.run(
    "UPDATE torrent_jobs SET status = 'failed', error = 'import was interrupted by a server restart', updated_at = $now WHERE status = 'importing'",
    { $now: nowIso() },
  );
  log.warning(`reset ${rows.length} interrupted torrent import(s)`);
}
