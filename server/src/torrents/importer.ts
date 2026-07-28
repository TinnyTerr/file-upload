import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { Request } from "express";
import type { AppState } from "../appState.ts";
import type { TorrentJobRow, UserRow, DirectoryRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import { ensurePermissions } from "../permissions.ts";
import { newSlug } from "../links.ts";
import { recordAudit } from "../audit.ts";
import { getLogger } from "../logging.ts";
import { HttpError } from "../httpError.ts";
import { storageRoot, debridRoot, newInternalRelPath } from "../storage/paths.ts";
import { finalizeStoredFile } from "../routes/files.ts";

const log = getLogger("app.torrents.importer");

/** Partial-file suffixes qBittorrent leaves behind; never importable. */
const SKIP_SUFFIXES = [".!qB", ".parts", ".unwanted"];

export interface DiscoveredFile {
  /** Absolute path on this server's filesystem. */
  path: string;
  /** Path relative to the torrent root, used as the display filename. */
  rel: string;
  size: number;
}

/** The per-job download directory as *this server* sees it.
 *
 * Real-Debrid jobs are fetched by this process into our own staging root, so
 * the path is unambiguous. For qBittorrent jobs, `save_path` on the row is the
 * directory as *qBittorrent* sees it -- the two differ when qBittorrent runs
 * in a container (see TORRENT_CONTENT_PATH). */
export function localJobDir(state: AppState, job: TorrentJobRow): string {
  if (job.provider === "debrid") return join(debridRoot(), job.tag);
  return join(state.settings.torrentContentPath || state.settings.qbittorrentSavePath, job.tag);
}

/** The per-job dir holds exactly one entry: the torrent's own file or folder.
 * Descending into a lone folder keeps imported filenames free of a redundant
 * "<torrent name>/" prefix while preserving deeper subdirectory paths. */
function torrentRoot(jobDir: string): string {
  const entries = readdirSync(jobDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0]!.isDirectory()) return join(jobDir, entries[0]!.name);
  return jobDir;
}

export function discoverFiles(root: string): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      out.push({ path: full, rel: relative(root, full).split(sep).join("/"), size });
    }
  };
  const stat = statSync(root);
  if (stat.isFile()) return [{ path: root, rel: basename(root), size: stat.size }];
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Minimal stand-in Request for finalizeStoredFile, which only reads the client
 * IP (audit row) and the host (returned share URL) off it. Imports happen on a
 * scheduler tick, so there is no real request to carry through. */
function backgroundRequest(state: AppState): Request {
  const nodeUrl = state.settings.nodeUrl || "";
  const host = nodeUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "") || "localhost:8000";
  return {
    protocol: nodeUrl.startsWith("https://") || state.settings.appEnv !== "dev" ? "https" : "http",
    socket: { remoteAddress: "127.0.0.1" },
    header: () => undefined,
    get: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
  } as unknown as Request;
}

function createDirectory(state: AppState, user: UserRow, title: string, req: Request): DirectoryRow {
  const { db } = state;
  const slug = newSlug();
  db.run(
    `INSERT INTO directories (owner_id, slug, title, encryption_mode, total_bytes, created_at)
     VALUES ($ownerId, $slug, $title, 'none', 0, $now)`,
    { $ownerId: user.id, $slug: slug, $title: title.slice(0, 512) || "Torrent", $now: nowIso() },
  );
  const dir = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = last_insert_rowid()")!;
  db.run(
    "INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
    { $dirId: dir.id, $slug: slug, $now: nowIso() },
  );
  recordAudit(db, { actor: user.username, action: "directory.created", target: `directory:${dir.id}` });
  return dir;
}

export interface ImportResult {
  fileCount: number;
  directoryId: number | null;
  totalBytes: number;
}

/** Copies every completed file of `job` into the owner's storage, reusing the
 * regular upload finalize pipeline (quota accounting, blob attach, share link,
 * cluster replication). Multi-file torrents land in a new folder named after
 * the torrent; single-file torrents become a plain file. */
export async function importCompletedTorrent(state: AppState, job: TorrentJobRow): Promise<ImportResult> {
  const { db } = state;
  const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: job.owner_id });
  if (!user) throw new HttpError(404, "torrent owner no longer exists");
  const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
  const req = backgroundRequest(state);

  const root = localJobDir(state, job);
  let files: DiscoveredFile[];
  try {
    files = discoverFiles(torrentRoot(root));
  } catch (err) {
    throw new HttpError(500, `downloaded content is not readable at ${root}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!files.length) throw new HttpError(500, "torrent finished but no files were found on disk");

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const oversized = files.find((f) => f.size > perm.max_file_bytes);
  if (oversized) {
    throw new HttpError(413, `"${oversized.rel}" exceeds your max file size`);
  }
  const used =
    db.get<{ total: number | null }>("SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id", { $id: user.id })
      ?.total ?? 0;
  if (used + totalBytes > perm.quota_bytes) {
    throw new HttpError(413, "torrent would exceed your storage quota");
  }

  const directory = files.length > 1 ? createDirectory(state, user, job.name, req) : null;

  let imported = 0;
  for (const file of files) {
    const relPath = newInternalRelPath();
    const work = `${join(storageRoot(), relPath)}.torrent.work`;
    mkdirSync(join(work, ".."), { recursive: true });
    // Async copy: a multi-GB torrent must not block the event loop, and the
    // import runs on a scheduler tick alongside live requests.
    await copyFile(file.path, work);
    try {
      await finalizeStoredFile({
        state,
        req,
        user,
        perm,
        directory,
        workPath: work,
        relPath,
        stored: file.size,
        contentType: Bun.file(file.path).type || "application/octet-stream",
        encryptionMode: "none",
        compress: false,
        randomizeFilename: false,
        originalFilename: directory ? file.rel : basename(file.rel),
        isPermanent: true,
        tempDays: null,
        deleteIfIdleDays: null,
        archiveAfterIdleDays: null,
        autoUnarchiveOnDownload: true,
        maxUses: null,
        expiresInSeconds: null,
        sourceType: "torrent",
      });
      imported += 1;
    } catch (err) {
      try {
        unlinkSync(work);
      } catch {
        // best-effort
      }
      throw err;
    }
  }

  log.info(
    `torrent imported job_id=${job.id} owner_id=${user.id} files=${imported} bytes=${totalBytes} directory_id=${directory?.id ?? "none"}`,
  );
  return { fileCount: imported, directoryId: directory ? directory.id : null, totalBytes };
}

/** Removes the per-job download directory from disk. Best-effort. */
export function cleanupJobDir(state: AppState, job: TorrentJobRow): void {
  const root = localJobDir(state, job);
  if (!root || !job.tag) return;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    log.warning(`torrent cleanup failed job_id=${job.id} path=${root}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
