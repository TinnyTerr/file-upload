import { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppState } from "../appState.ts";
import { requireCsrf } from "../security/csrf.ts";
import { requireActiveUser, requireMaster, requirePermission } from "../middleware/deps.ts";
import { requireSession, clientIp } from "../middleware/auth.ts";
import { recordAudit } from "../audit.ts";
import { getLogger } from "../logging.ts";
import { HttpError } from "../httpError.ts";
import { nowIso, type TorrentJobRow, type UserRow } from "../db/rows.ts";
import {
  addTorrent,
  appVersion,
  deleteTorrent,
  infoHashFromMagnet,
  isConfigured,
  requireConfigured,
} from "../torrents/qbittorrent.ts";
import { importJob } from "../torrents/poller.ts";
import { cleanupJobDir } from "../torrents/importer.ts";

const log = getLogger("app.routes.torrents");

/** Max accepted .torrent metainfo file (base64-decoded). */
const MAX_TORRENT_FILE_BYTES = 2 * 1024 * 1024;
/** Concurrent in-flight torrents per user -- keeps one account from occupying
 * the whole host qBittorrent instance. */
const MAX_ACTIVE_PER_USER = 5;

function respondError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.detail });
    return;
  }
  log.error(`unhandled route error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  res.status(500).json({ detail: "internal server error" });
}

function nameFromMagnet(magnet: string): string | null {
  try {
    const dn = new URLSearchParams(magnet.slice(magnet.indexOf("?") + 1)).get("dn");
    return dn ? dn.slice(0, 512) : null;
  } catch {
    return null;
  }
}

function serializeJob(job: TorrentJobRow, ownerUsername?: string): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    progress: job.progress,
    size_bytes: job.size_bytes,
    downloaded_bytes: job.downloaded_bytes,
    dl_speed: job.dl_speed,
    eta_seconds: job.eta_seconds,
    info_hash: job.info_hash,
    directory_id: job.directory_id,
    imported_file_count: job.imported_file_count,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
    ...(ownerUsername !== undefined ? { owner_username: ownerUsername, owner_id: job.owner_id } : {}),
  };
}

function loadOwnJob(state: AppState, user: UserRow, jobId: string): TorrentJobRow {
  const job = state.db.get<TorrentJobRow>("SELECT * FROM torrent_jobs WHERE id = $id", { $id: jobId });
  if (!job) throw new HttpError(404, "not found");
  if (user.role !== "master" && job.owner_id !== user.id) throw new HttpError(403, "not your torrent");
  return job;
}

/** Torrent downloads handled by a qBittorrent instance on the host: the server
 * hands qBittorrent a magnet (or .torrent metainfo), qBittorrent downloads into
 * a per-job directory under the configured save location, and the scheduler's
 * `torrent_poll` job imports the finished content into the owner's storage via
 * the normal upload finalize pipeline (see torrents/poller.ts + importer.ts).
 * Mount at /api/torrents. */
export function torrentsRouter(state: AppState): Router {
  const router = Router();
  const { db, settings } = state;
  const perm = () => requirePermission(state, "can_use_torrents");

  router.get("/config", requireActiveUser(state), (_req, res) => {
    res.json({
      configured: isConfigured(settings),
      save_path: settings.qbittorrentSavePath,
      max_active_per_user: MAX_ACTIVE_PER_USER,
    });
  });

  // Only magnets and uploaded .torrent files are accepted -- handing
  // qBittorrent an arbitrary http(s) URL to fetch would make it an SSRF proxy
  // into the host's network, which the remote-upload route guards against by
  // pinning validated public IPs (see routes/remoteUpload.ts).
  router.post("/", requireSession(state), requireCsrf, perm(), async (req, res) => {
    try {
      requireConfigured(settings);
      const user = req.currentUser!;
      const body = req.body ?? {};
      const magnet = typeof body.magnet === "string" ? body.magnet.trim() : "";
      const fileB64 = typeof body.torrent_file_b64 === "string" ? body.torrent_file_b64 : "";

      if (!magnet && !fileB64) {
        res.status(400).json({ detail: "provide a magnet link or a .torrent file" });
        return;
      }
      if (magnet && !/^magnet:\?/i.test(magnet)) {
        res.status(400).json({ detail: "only magnet links are accepted here; upload the .torrent file instead" });
        return;
      }

      let torrentFile: { filename: string; bytes: Buffer } | undefined;
      if (!magnet) {
        const bytes = Buffer.from(fileB64.replace(/^data:[^,]*,/, ""), "base64");
        if (!bytes.length) {
          res.status(400).json({ detail: "torrent file is empty or not valid base64" });
          return;
        }
        if (bytes.length > MAX_TORRENT_FILE_BYTES) {
          res.status(413).json({ detail: "torrent file is too large" });
          return;
        }
        if (bytes[0] !== 0x64) {
          res.status(400).json({ detail: "that file is not a .torrent metainfo file" });
          return;
        }
        const rawName = typeof body.filename === "string" ? body.filename : "upload.torrent";
        torrentFile = { filename: rawName.replace(/[/\\]/g, "_").slice(0, 255) || "upload.torrent", bytes };
      }

      const active = db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM torrent_jobs WHERE owner_id = $id AND status IN ('queued', 'downloading', 'importing')",
        { $id: user.id },
      )!.n;
      if (active >= MAX_ACTIVE_PER_USER) {
        res.status(429).json({ detail: `you already have ${MAX_ACTIVE_PER_USER} torrents in flight` });
        return;
      }

      const tag = `fu-${randomBytes(8).toString("hex")}`;
      const savePath = join(settings.qbittorrentSavePath, tag);
      const name =
        (typeof body.name === "string" && body.name.trim().slice(0, 512)) ||
        (magnet ? nameFromMagnet(magnet) : torrentFile!.filename.replace(/\.torrent$/i, "")) ||
        "torrent";

      await addTorrent(settings, { url: magnet || undefined, file: torrentFile, savePath, tag });

      db.run(
        `INSERT INTO torrent_jobs (owner_id, name, source, info_hash, tag, save_path, status, created_at, updated_at)
         VALUES ($ownerId, $name, $source, $hash, $tag, $savePath, 'queued', $now, $now)`,
        {
          $ownerId: user.id,
          $name: name,
          $source: magnet ? magnet.slice(0, 2048) : `file:${torrentFile!.filename}`,
          $hash: magnet ? infoHashFromMagnet(magnet) : null,
          $tag: tag,
          $savePath: savePath,
          $now: nowIso(),
        },
      );
      const job = db.get<TorrentJobRow>("SELECT * FROM torrent_jobs WHERE id = last_insert_rowid()")!;
      recordAudit(db, {
        actor: user.username,
        action: "torrent.added",
        target: `torrent_job:${job.id}`,
        ip: clientIp(state, req),
      });
      log.info(`torrent added job_id=${job.id} owner_id=${user.id} tag=${tag}`);
      res.json(serializeJob(job));
    } catch (err) {
      respondError(res, err);
    }
  });

  router.get("/", perm(), (req, res) => {
    const user = req.currentUser!;
    const jobs = db.all<TorrentJobRow>("SELECT * FROM torrent_jobs WHERE owner_id = $id ORDER BY id DESC LIMIT 200", {
      $id: user.id,
    });
    res.json({ torrents: jobs.map((j) => serializeJob(j)), configured: isConfigured(settings) });
  });

  router.get("/:jobId(\\d+)", perm(), (req, res) => {
    try {
      const job = loadOwnJob(state, req.currentUser!, req.params.jobId!);
      res.json(serializeJob(job));
    } catch (err) {
      respondError(res, err);
    }
  });

  // Re-runs the import for a failed job whose downloaded data is still on disk
  // (typically a quota failure the owner has since made room for).
  router.post("/:jobId(\\d+)/retry", requireSession(state), requireCsrf, perm(), async (req, res) => {
    try {
      const user = req.currentUser!;
      const job = loadOwnJob(state, user, req.params.jobId!);
      if (job.status !== "failed") {
        res.status(409).json({ detail: "only failed torrents can be retried" });
        return;
      }
      await importJob(state, job);
      recordAudit(db, {
        actor: user.username,
        action: "torrent.retried",
        target: `torrent_job:${job.id}`,
        ip: clientIp(state, req),
      });
      res.json(serializeJob(db.get<TorrentJobRow>("SELECT * FROM torrent_jobs WHERE id = $id", { $id: job.id })!));
    } catch (err) {
      respondError(res, err);
    }
  });

  // Cancels an in-flight torrent (removing it and its data from qBittorrent) or
  // clears a settled row. Already-imported files are untouched -- they are
  // ordinary files at that point and are deleted from the files page.
  router.delete("/:jobId(\\d+)", requireSession(state), requireCsrf, perm(), async (req, res) => {
    try {
      const user = req.currentUser!;
      const job = loadOwnJob(state, user, req.params.jobId!);
      if (isConfigured(settings) && job.info_hash && job.status !== "completed") {
        await deleteTorrent(settings, job.info_hash, true);
      }
      if (job.status !== "completed") cleanupJobDir(state, job);
      db.run("DELETE FROM torrent_jobs WHERE id = $id", { $id: job.id });
      recordAudit(db, {
        actor: user.username,
        action: "torrent.removed",
        target: `torrent_job:${job.id}`,
        ip: clientIp(state, req),
      });
      log.info(`torrent removed job_id=${job.id} owner_id=${user.id} status=${job.status}`);
      res.json({ status: "deleted" });
    } catch (err) {
      respondError(res, err);
    }
  });

  return router;
}

/** Mount at /api/admin/torrents. */
export function adminTorrentsRouter(state: AppState): Router {
  const router = Router();
  const { db, settings } = state;

  router.get("/status", requireMaster(state), async (_req, res) => {
    if (!isConfigured(settings)) {
      res.json({
        configured: false,
        detail: "set QBITTORRENT_URL and QBITTORRENT_SAVE_PATH in data/app.env",
        save_path: settings.qbittorrentSavePath,
        url: settings.qbittorrentUrl,
      });
      return;
    }
    try {
      const version = await appVersion(settings);
      res.json({
        configured: true,
        connected: true,
        version,
        url: settings.qbittorrentUrl,
        save_path: settings.qbittorrentSavePath,
        content_path: settings.torrentContentPath,
      });
    } catch (err) {
      res.json({
        configured: true,
        connected: false,
        detail: err instanceof HttpError ? err.detail : err instanceof Error ? err.message : String(err),
        url: settings.qbittorrentUrl,
        save_path: settings.qbittorrentSavePath,
        content_path: settings.torrentContentPath,
      });
    }
  });

  router.get("/", requireMaster(state), (_req, res) => {
    const jobs = db.all<TorrentJobRow>("SELECT * FROM torrent_jobs ORDER BY id DESC LIMIT 500");
    const usernames = new Map<number, string>();
    for (const u of db.all<UserRow>("SELECT id, username FROM users")) usernames.set(u.id, u.username);
    res.json({ torrents: jobs.map((j) => serializeJob(j, usernames.get(j.owner_id) ?? "unknown")) });
  });

  return router;
}
