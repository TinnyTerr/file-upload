import { Router } from "express";
import busboy from "busboy";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  statSync,
  createWriteStream,
  createReadStream,
  rmSync,
  unlinkSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { ZipArchive } from "archiver";
import type { Request, Response } from "express";
import type { AppState } from "../appState.ts";
import { requireCsrf } from "../security/csrf.ts";
import { getUploadUser, requireActiveUser, requireMaster, requirePermission } from "../middleware/deps.ts";
import { requireSession, clientIp } from "../middleware/auth.ts";
import { getMasterKey } from "../config.ts";
import { recordAudit } from "../audit.ts";
import { getLogger } from "../logging.ts";
import { HttpError } from "../httpError.ts";
import { newSlug, resolveActiveLink, consumeUse } from "../links.ts";
import { hashFile, attachBlob, fileHashes, releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { storageRoot, safeJoin } from "../storage/paths.ts";
import { compressFile, shouldCompress } from "../storage/compress.ts";
import { safeArcname, memberSource } from "../storage/zip.ts";
import { encryptFile } from "../crypto/aead.ts";
import { seal, openBox } from "../crypto/secretbox.ts";
import { ensurePermissions } from "../permissions.ts";
import { enforceGlobalUploadCapacity, usedStorageBytes } from "../storage/accounting.ts";
import { replicateFile } from "../cluster/replication.ts";
import { nowIso, type FileRow, type LinkRow, type PermissionRow, type UserRow } from "../db/rows.ts";

const log = getLogger("app.routes.files");

const CHUNK = 256 * 1024;
const REQUEST_OVERHEAD_ALLOWANCE = 1024 * 1024;
const CHUNK_UPLOAD_SIZE = 16 * 1024 * 1024;
const CHUNK_SESSION_TTL = 12 * 3600;
const CHUNK_TOKEN_AAD = Buffer.from("chunked-upload-v1");

const UNSAFE_CT = new Set(["text/html", "text/xhtml", "text/xhtml+xml", "image/svg+xml", "application/xhtml+xml"]);

interface SumRow {
  total: number | null;
}
interface DirRow {
  id: number;
  owner_id: number;
  encryption_mode: string;
  enc_key_blob: Uint8Array | null;
  enc_access_blob: Uint8Array | null;
  total_bytes: number;
}
interface CollabRow {
  id: number;
}

/** Exported for reuse by dropbox.ts (owner-quota lookups on behalf of the
 * dropbox link's owner, mirroring app/routes/dropbox.py's import from
 * app/routes/files.py). */
export function usedBytes(state: AppState, userId: number): number {
  return (
    state.db.get<SumRow>("SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id", { $id: userId })
      ?.total ?? 0
  );
}

/** Exported for reuse by dropbox.ts. */
export function canEditDirectory(state: AppState, directoryId: number, user: UserRow): boolean {
  const { db } = state;
  const dir = db.get<DirRow>("SELECT * FROM directories WHERE id = $id", { $id: directoryId });
  if (!dir) return false;
  if (user.role === "master" || dir.owner_id === user.id) return true;
  return !!db.get<CollabRow>(
    "SELECT id FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user AND role = 'editor'",
    { $dir: directoryId, $user: user.id },
  );
}

function fileUrl(req: Request, slug: string): string {
  const proto = req.protocol;
  const host = req.get("host");
  return `${proto}://${host}/file/${slug}`;
}

function randomizedFilename(originalFilename: string): string {
  const base = basename(originalFilename.replace(/\\/g, "/")).trim();
  let ext = extname(base);
  if (!/^[a-z0-9]+$/i.test(ext.slice(1)) || ext.length > 17) ext = "";
  return `${randomBytes(16).toString("hex")}${ext.toLowerCase()}`;
}

interface PreparedUpload {
  encryptionMode: string;
  compress: boolean;
  isPermanent: boolean;
  tempDays: number | null;
  randomizeFilename: boolean;
  directory: DirRow | null;
  perm: PermissionRow;
}

function prepareUpload(
  state: AppState,
  user: UserRow,
  opts: {
    encryptionMode: string;
    compress: boolean;
    isPermanent: boolean;
    tempDays: number | null;
    randomizeFilename: boolean;
    directoryId: number | null;
  },
): PreparedUpload {
  let { encryptionMode, compress, isPermanent, tempDays, randomizeFilename } = opts;
  if (!["none", "server", "client"].includes(encryptionMode)) {
    throw new HttpError(400, "invalid encryption_mode");
  }

  let directory: DirRow | null = null;
  if (opts.directoryId !== null) {
    directory = state.db.get<DirRow>("SELECT * FROM directories WHERE id = $id", { $id: opts.directoryId }) ?? null;
    if (!directory) throw new HttpError(404, "directory not found");
    if (!canEditDirectory(state, directory.id, user)) throw new HttpError(403, "not your directory");
    encryptionMode = directory.encryption_mode;
    compress = false;
    isPermanent = true;
    tempDays = null;
    randomizeFilename = false;
  }

  if (!isPermanent && !tempDays) throw new HttpError(400, "temp_days is required when is_permanent is false");

  const perm = ensurePermissions(state.db, user.id, { master: user.role === "master" });
  if (encryptionMode === "client" && !perm.can_upload_client_encrypted) {
    throw new HttpError(403, "client-side encryption not permitted");
  }

  return { encryptionMode, compress, isPermanent, tempDays, randomizeFilename, directory, perm };
}

/** Rejects new uploads while a cluster-wide or per-user halt is active (see
 * server/src/cluster/halt.ts). Checked at the start of every upload entry
 * point -- single-shot and chunked-init -- so a storage-emergency halt
 * gossiped over the firehose takes effect immediately without needing to
 * touch each in-flight request individually. Exported for reuse by
 * dropbox.ts, mirroring precheckDeclaredSize below. */
export function checkUploadHalt(state: AppState, userId: number): void {
  const until = state.haltRegistry.activeUntil(userId);
  if (until !== null) {
    throw new HttpError(503, "uploads are temporarily halted on this cluster; try again shortly");
  }
}

/** Exported for reuse by dropbox.ts. Mirrors
 * app/routes/dropbox.py's import of app/routes/files.py::_precheck_declared_size. */
export function precheckDeclaredSize(state: AppState, user: UserRow, perm: PermissionRow, declared: number): void {
  if (declared > perm.max_file_bytes + REQUEST_OVERHEAD_ALLOWANCE) {
    log.warning(`upload precheck rejected user_id=${user.id} reason=max_file declared_bytes=${declared}`);
    throw new HttpError(413, "file exceeds max file size");
  }
  if (usedBytes(state, user.id) + declared > perm.quota_bytes + REQUEST_OVERHEAD_ALLOWANCE) {
    log.warning(`upload precheck rejected user_id=${user.id} reason=user_quota declared_bytes=${declared}`);
    throw new HttpError(413, "upload would exceed your quota");
  }
}

interface FinalizeOpts {
  state: AppState;
  req: Request;
  user: UserRow;
  perm: PermissionRow;
  directory: DirRow | null;
  workPath: string;
  relPath: string;
  stored: number;
  contentType: string | null;
  encryptionMode: string;
  compress: boolean;
  randomizeFilename: boolean;
  originalFilename: string;
  isPermanent: boolean;
  tempDays: number | null;
  deleteIfIdleDays: number | null;
  archiveAfterIdleDays: number | null;
  autoUnarchiveOnDownload: boolean;
  maxUses: number | null;
  expiresInSeconds: number | null;
  sourceType?: string;
  savedFromFileId?: number | null;
}

/** Mirrors app/routes/files.py::_finalize_stored_file -- quota check, optional
 * compression, DB record, optional server-side encryption, link minting. */
export async function finalizeStoredFile(opts: FinalizeOpts): Promise<Record<string, unknown>> {
  const { state, req, user, perm, directory } = opts;
  const { db } = state;
  const basePath = join(storageRoot(), opts.relPath);
  const directoryId = directory ? directory.id : null;

  let plainHashes;
  try {
    plainHashes = await hashFile(opts.workPath);
    enforceGlobalUploadCapacity(db, opts.stored);
  } catch (err) {
    try {
      unlinkSync(opts.workPath);
    } catch {
      // best-effort
    }
    log.warning(`upload finalize rejected user_id=${user.id} reason=global_storage stored_bytes=${opts.stored}`);
    throw err;
  }

  if (usedBytes(state, user.id) + opts.stored > perm.quota_bytes) {
    try {
      unlinkSync(opts.workPath);
    } catch {
      // best-effort
    }
    log.warning(`upload finalize rejected user_id=${user.id} reason=user_quota stored_bytes=${opts.stored}`);
    throw new HttpError(413, "upload would exceed your quota");
  }

  let sizeBytes = opts.stored;
  let fileCompressed = false;
  let current = opts.workPath;

  const cleanupPaths = [opts.workPath, `${basePath}.zst.work`, `${basePath}.fupl.work`, basePath];

  try {
    let ct = (opts.contentType || "application/octet-stream").toLowerCase().split(";")[0]!.trim();
    if (UNSAFE_CT.has(ct)) ct = "application/octet-stream";

    if (opts.compress && opts.encryptionMode !== "client" && shouldCompress(ct)) {
      const compressed = `${basePath}.zst.work`;
      await compressFile(current, compressed);
      unlinkSync(current);
      current = compressed;
      fileCompressed = true;
    }

    const displayName = opts.randomizeFilename ? randomizedFilename(opts.originalFilename) : opts.originalFilename;
    let expiresAt: string | null = null;
    if (!opts.isPermanent && opts.tempDays) {
      expiresAt = new Date(Date.now() + opts.tempDays * 86400 * 1000).toISOString();
    }

    db.run(
      `INSERT INTO files (
         owner_id, directory_id, storage_path, original_filename, source_type,
         saved_from_file_id, size_bytes, stored_size_bytes, content_type, encryption_mode,
         compressed, is_permanent, expires_at, delete_if_idle_days, archive_after_idle_days,
         auto_unarchive_on_download, created_at
       ) VALUES ($ownerId, $dirId, $relPath, $displayName, $sourceType, $savedFrom, $size, 0, $ct, $enc,
         $compressed, $isPermanent, $expiresAt, $deleteIfIdle, $archiveAfterIdle, $autoUnarchive, $now)`,
      {
        $ownerId: user.id,
        $dirId: directoryId,
        $relPath: opts.relPath,
        $displayName: displayName,
        $sourceType: opts.sourceType ?? "upload",
        $savedFrom: opts.savedFromFileId ?? null,
        $size: sizeBytes,
        $ct: ct,
        $enc: opts.encryptionMode,
        $compressed: fileCompressed ? 1 : 0,
        $isPermanent: opts.isPermanent ? 1 : 0,
        $expiresAt: expiresAt,
        $deleteIfIdle: opts.deleteIfIdleDays,
        $archiveAfterIdle: opts.archiveAfterIdleDays,
        $autoUnarchive: opts.autoUnarchiveOnDownload ? 1 : 0,
        $now: nowIso(),
      },
    );
    const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = last_insert_rowid()")!;

    let encKeyBlobVal: Buffer | null = null;
    let encAccessBlobVal: Buffer | null = null;
    let accessKey: string | null = null;

    if (opts.encryptionMode === "server") {
      const masterKey = getMasterKey(state.settings);
      let perFileKey: Buffer;
      if (directory) {
        if (!directory.enc_key_blob) throw new HttpError(500, "directory key missing");
        perFileKey = openBox(masterKey, Buffer.from(directory.enc_key_blob));
        encKeyBlobVal = Buffer.from(directory.enc_key_blob);
        encAccessBlobVal = directory.enc_access_blob ? Buffer.from(directory.enc_access_blob) : null;
      } else {
        perFileKey = randomBytes(32);
        accessKey = randomBytes(18).toString("base64url");
        encKeyBlobVal = seal(masterKey, perFileKey);
        encAccessBlobVal = seal(masterKey, Buffer.from(accessKey));
      }
      const encrypted = `${basePath}.fupl.work`;
      await encryptFile(perFileKey, current, encrypted);
      unlinkSync(current);
      current = encrypted;
    }

    mkdirSync(join(basePath, ".."), { recursive: true });
    renameSync(current, basePath);
    const storedHashes = await hashFile(basePath);
    const transformKey = `${opts.encryptionMode}:compressed=${fileCompressed ? 1 : 0}`;
    const blob = attachBlob(db, {
      finalPath: basePath,
      relPath: opts.relPath,
      logicalSize: sizeBytes,
      contentType: ct,
      hashes: plainHashes,
      storedHashes,
      transformKey,
    });

    let expiresLink: string | null = null;
    let linkMaxUses = opts.maxUses;
    if (directory) {
      linkMaxUses = null;
      db.run("UPDATE directories SET total_bytes = COALESCE(total_bytes, 0) + $inc WHERE id = $id", {
        $inc: sizeBytes,
        $id: directory.id,
      });
    } else if (opts.expiresInSeconds !== null) {
      expiresLink = new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString();
    }

    const slug = newSlug();
    db.run(
      `UPDATE files SET blob_id = $blobId, storage_path = $path, stored_size_bytes = $stored,
         enc_key_blob = $encKey, enc_access_blob = $encAccess WHERE id = $id`,
      {
        $blobId: blob.id,
        $path: blob.storage_path,
        $stored: blob.stored_size_bytes,
        $encKey: encKeyBlobVal,
        $encAccess: encAccessBlobVal,
        $id: fileObj.id,
      },
    );
    db.run(
      `INSERT INTO links (file_id, slug, max_uses, use_count, expires_at, active, created_at)
       VALUES ($fileId, $slug, $maxUses, 0, $expiresAt, 1, $now)`,
      { $fileId: fileObj.id, $slug: slug, $maxUses: linkMaxUses, $expiresAt: expiresLink, $now: nowIso() },
    );

    recordAudit(db, {
      actor: user.username,
      action: "file.uploaded",
      target: `file:${fileObj.id}`,
      ip: clientIp(state, req),
    });
    log.info(
      `upload finalized file_id=${fileObj.id} owner_id=${user.id} stored_bytes=${blob.stored_size_bytes} size_bytes=${sizeBytes} encryption=${opts.encryptionMode} compressed=${fileCompressed} directory_id=${directoryId}`,
    );
    // Best-effort, fire-and-forget cluster replication -- never adds peer
    // round-trip latency to the upload response, and a no-op without any
    // linked peers (see cluster/replication.ts::replicateFile).
    void replicateFile(state, fileObj.id).catch((err) => {
      log.warning(`cluster replication failed file_id=${fileObj.id}: ${err instanceof Error ? err.message : String(err)}`);
    });

    const baseUrl = fileUrl(req, slug);
    return {
      file_id: fileObj.id,
      slug,
      url: baseUrl,
      raw_url: `${baseUrl}/raw`,
      access_key: accessKey,
      encryption_mode: opts.encryptionMode,
      max_uses: opts.maxUses,
      expires_at: expiresLink,
      compressed: fileCompressed,
      source_type: opts.sourceType ?? "upload",
      saved_from_file_id: opts.savedFromFileId ?? null,
    };
  } catch (err) {
    for (const p of cleanupPaths) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // best-effort
      }
    }
    log.error(`upload finalize failed owner_id=${user.id} rel_path=${opts.relPath} stored_bytes=${opts.stored}`);
    throw err;
  }
}

function recoverAccessKey(state: AppState, f: { encryption_mode: string; enc_access_blob: Uint8Array | null }): string | null {
  if (f.encryption_mode !== "server" || !f.enc_access_blob) return null;
  try {
    return openBox(getMasterKey(state.settings), Buffer.from(f.enc_access_blob)).toString("utf-8");
  } catch {
    return null;
  }
}

function verifyFileAccessKey(state: AppState, f: FileRow, ek: string | null): boolean {
  if (f.encryption_mode !== "server") return true;
  const expected = recoverAccessKey(state, f);
  if (expected === null || !ek) return false;
  const a = Buffer.from(ek);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── chunked upload token helpers ────────────────────────────────────────────

interface ChunkMeta {
  v: number;
  uid: number;
  rel: string;
  total: number;
  cs: number;
  n: number;
  fn: string;
  ct: string | null;
  enc: string;
  cmp: boolean;
  perm: boolean;
  td: number | null;
  did: number | null;
  aaid: number | null;
  auod: boolean;
  rnd: boolean;
  dir: number | null;
  mu: number | null;
  eis: number | null;
  exp: number;
}

function sealChunkToken(state: AppState, meta: ChunkMeta): string {
  const raw = Buffer.from(JSON.stringify(meta));
  return seal(getMasterKey(state.settings), raw, CHUNK_TOKEN_AAD).toString("base64url");
}

function openChunkToken(state: AppState, token: string, user: UserRow): ChunkMeta {
  let meta: ChunkMeta;
  try {
    const blob = Buffer.from(token, "base64url");
    meta = JSON.parse(openBox(getMasterKey(state.settings), blob, CHUNK_TOKEN_AAD).toString("utf-8"));
  } catch {
    throw new HttpError(400, "invalid upload token");
  }
  if (meta.uid !== user.id) throw new HttpError(403, "not your upload");
  if (meta.exp < Date.now() / 1000) {
    try {
      rmSync(partsDir(meta.rel), { recursive: true, force: true });
      unlinkSync(`${join(storageRoot(), meta.rel)}.part`);
    } catch {
      // best-effort
    }
    throw new HttpError(410, "upload session expired");
  }
  return meta;
}

/** Exported for reuse by dropbox.ts. */
export function chunkUploadSize(): number {
  const raw = process.env.FILEUPLOAD_CHUNK_SIZE;
  if (raw) {
    const v = Number(raw);
    if (v > 0) return v;
  }
  return CHUNK_UPLOAD_SIZE;
}

/** Exported for reuse by dropbox.ts. */
export function partsDir(relPath: string): string {
  return `${join(storageRoot(), relPath)}.parts`;
}

/** Exported for reuse by dropbox.ts. */
export function numChunks(total: number, chunkSize: number): number {
  if (total <= 0 || chunkSize <= 0) return 0;
  return Math.ceil(total / chunkSize);
}

/** Exported for reuse by dropbox.ts. */
export function expectedChunkLen(index: number, total: number, chunkSize: number, n: number): number {
  if (index < 0 || index >= n) return -1;
  if (index < n - 1) return chunkSize;
  return total - (n - 1) * chunkSize;
}

/** Exported for reuse by dropbox.ts. */
export function receivedIndices(parts: string, n: number): number[] {
  const out: number[] = [];
  try {
    for (const entry of readdirSync(parts)) {
      if (/^\d+$/.test(entry)) {
        const i = Number(entry);
        if (i >= 0 && i < n) out.push(i);
      }
    }
  } catch {
    // best-effort
  }
  return out.sort((a, b) => a - b);
}

/** Drops chunk dirs / assembly files left behind by abandoned uploads. Exported
 * so jobs/scheduler.ts can run it on an interval, mirroring the APScheduler job. */
export function sweepStaleParts(): void {
  const cutoff = Date.now() / 1000 - CHUNK_SESSION_TTL;
  const root = storageRoot();

  function walk(dir: string, onEntry: (path: string, isDir: boolean) => void): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry.endsWith(".parts")) onEntry(p, true);
        else walk(p, onEntry);
      } else if (entry.endsWith(".part") || entry.endsWith(".work")) {
        onEntry(p, false);
      }
    }
  }

  walk(root, (p, isDir) => {
    try {
      const st = statSync(p);
      if (st.mtimeMs / 1000 < cutoff) {
        if (isDir) rmSync(p, { recursive: true, force: true });
        else unlinkSync(p);
      }
    } catch {
      // best-effort
    }
  });
}

function serializeFiles(state: AppState, req: Request, files: FileRow[]): Record<string, unknown>[] {
  const { db } = state;
  const ownerIds = [...new Set(files.map((f) => f.owner_id))];
  const usernameMap = new Map<number, string>();
  if (ownerIds.length) {
    for (const u of db.all<UserRow>(`SELECT * FROM users WHERE id IN (${ownerIds.map((_, i) => `$id${i}`).join(",")})`, Object.fromEntries(ownerIds.map((id, i) => [`$id${i}`, id])))) {
      usernameMap.set(u.id, u.username);
    }
  }
  return files.map((f) => {
    const links = db.all<LinkRow>("SELECT * FROM links WHERE file_id = $id", { $id: f.id });
    return {
      id: f.id,
      owner_id: f.owner_id,
      owner_username: usernameMap.get(f.owner_id) ?? `user:${f.owner_id}`,
      blob_id: f.blob_id,
      original_filename: f.original_filename,
      source_type: f.source_type,
      saved_from_file_id: f.saved_from_file_id,
      size_bytes: f.size_bytes,
      stored_size_bytes: f.stored_size_bytes,
      hashes: fileHashes(db, f),
      content_type: f.content_type,
      encryption_mode: f.encryption_mode,
      compressed: !!f.compressed,
      archived: !!f.archived,
      lifecycle_state: f.lifecycle_state,
      archive_original_stored_size_bytes: f.archive_original_stored_size_bytes,
      archive_saved_bytes: f.archive_saved_bytes,
      is_permanent: !!f.is_permanent,
      expires_at: f.expires_at,
      last_downloaded_at: f.last_downloaded_at,
      access_key: recoverAccessKey(state, f),
      created_at: f.created_at,
      links: links.map((lk) => ({
        id: lk.id,
        slug: lk.slug,
        max_uses: lk.max_uses,
        use_count: lk.use_count,
        expires_at: lk.expires_at,
        active: !!lk.active,
        hide_uploader: !!lk.hide_uploader,
      })),
    };
  });
}

function boolField(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  return v === "true" || v === "1" || v === true;
}
function intField(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Mirrors app/routes/files.py. */
export function filesRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  // ── single-shot multipart upload ──────────────────────────────────────
  // A generous streaming safety net -- the exact per-user max_file_bytes check
  // only runs once every form field has arrived (see below), which may be
  // after the file field for browser-built multipart bodies.
  const ABSOLUTE_UPLOAD_CEILING = 20 * 1024 * 1024 * 1024; // 20 GiB

  router.post("/upload", getUploadUser(state), (req, res, next) => {
    const user = req.currentUser!;
    if (state.haltRegistry.activeUntil(user.id) !== null) {
      res.status(503).json({ detail: "uploads are temporarily halted on this cluster; try again shortly" });
      return;
    }
    const bb = busboy({ headers: req.headers, limits: { fileSize: ABSOLUTE_UPLOAD_CEILING } });
    const fields: Record<string, string> = {};
    let handled = false;
    let fileSeen = false;

    let work: string | null = null;
    let relPath = "";
    let stored = 0;
    let contentType: string | null = null;
    let originalFilenameFromStream = "upload";
    let fileWriteDone: Promise<void> | null = null;
    let fileTruncated = false;

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (_name, stream, info) => {
      fileSeen = true;
      contentType = info.mimeType || null;
      originalFilenameFromStream = info.filename || "upload";

      const rand = randomBytes(32).toString("hex");
      relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
      const basePath = join(storageRoot(), relPath);
      mkdirSync(join(basePath, ".."), { recursive: true });
      work = `${basePath}.work`;
      const workPath = work;

      const out = createWriteStream(workPath);
      stream.on("data", (chunk: Buffer) => {
        stored += chunk.length;
        out.write(chunk);
      });
      stream.on("limit", () => {
        fileTruncated = true;
      });
      fileWriteDone = new Promise((resolve, reject) => {
        stream.on("end", () => out.end(() => resolve()));
        stream.on("error", (err) => {
          out.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    });

    bb.on("close", () => {
      if (handled) return;
      if (!fileSeen || !work || !fileWriteDone) {
        res.status(400).json({ detail: "no file uploaded" });
        return;
      }
      handled = true;
      const workPath = work;

      fileWriteDone
        .then(async () => {
          if (fileTruncated) throw new HttpError(413, "file exceeds max file size");
          const prepared = prepareUpload(state, user, {
            encryptionMode: fields.encryption_mode || "none",
            compress: boolField(fields.compress, false),
            isPermanent: boolField(fields.is_permanent, true),
            tempDays: intField(fields.temp_days),
            randomizeFilename: boolField(fields.randomize_filename, false),
            directoryId: intField(fields.directory_id),
          });
          const hasLifecycleOptions =
            !prepared.isPermanent ||
            prepared.tempDays !== null ||
            intField(fields.delete_if_idle_days) !== null ||
            intField(fields.archive_after_idle_days) !== null ||
            boolField(fields.auto_unarchive_on_download, true) !== true;
          if (hasLifecycleOptions && !prepared.perm.can_manage_lifecycle) {
            throw new HttpError(403, "lifecycle options not permitted");
          }
          if (stored > prepared.perm.max_file_bytes) {
            throw new HttpError(413, "file exceeds max file size");
          }
          precheckDeclaredSize(state, user, prepared.perm, stored);

          return finalizeStoredFile({
            state,
            req,
            user,
            perm: prepared.perm,
            directory: prepared.directory,
            workPath,
            relPath,
            stored,
            contentType,
            encryptionMode: prepared.encryptionMode,
            compress: prepared.compress,
            randomizeFilename: prepared.randomizeFilename,
            originalFilename: fields.original_filename || originalFilenameFromStream,
            isPermanent: prepared.isPermanent,
            tempDays: prepared.tempDays,
            deleteIfIdleDays: intField(fields.delete_if_idle_days),
            archiveAfterIdleDays: intField(fields.archive_after_idle_days),
            autoUnarchiveOnDownload: boolField(fields.auto_unarchive_on_download, true),
            maxUses: intField(fields.max_uses),
            expiresInSeconds: intField(fields.expires_in_seconds),
          });
        })
        .then((result) => res.json(result))
        .catch((err) => {
          try {
            if (existsSync(workPath)) unlinkSync(workPath);
          } catch {
            // best-effort
          }
          respondError(res, err);
        });
    });
    bb.on("error", (err) => next(err));
    req.pipe(bb);
  });

  // ── chunked uploads ──────────────────────────────────────────────────
  router.post("/upload/init", getUploadUser(state), (req, res) => {
    try {
      const user = req.currentUser!;
      checkUploadHalt(state, user.id);
      const body = req.body ?? {};
      const prepared = prepareUpload(state, user, {
        encryptionMode: body.encryption_mode || "none",
        compress: !!body.compress,
        isPermanent: body.is_permanent !== false,
        tempDays: body.temp_days ?? null,
        randomizeFilename: !!body.randomize_filename,
        directoryId: body.directory_id ?? null,
      });
      const hasLifecycleOptions =
        !prepared.isPermanent ||
        prepared.tempDays !== null ||
        body.delete_if_idle_days != null ||
        body.archive_after_idle_days != null ||
        (body.auto_unarchive_on_download ?? true) !== true;
      if (hasLifecycleOptions && !prepared.perm.can_manage_lifecycle) {
        res.status(403).json({ detail: "lifecycle options not permitted" });
        return;
      }
      const totalSize = Number(body.total_size ?? 0);
      precheckDeclaredSize(state, user, prepared.perm, totalSize);

      const chunkSize = chunkUploadSize();
      const n = numChunks(totalSize, chunkSize);
      const rand = randomBytes(32).toString("hex");
      const relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
      mkdirSync(join(storageRoot(), rand.slice(0, 2), rand.slice(2, 4)), { recursive: true });
      mkdirSync(partsDir(relPath), { recursive: true });

      const meta: ChunkMeta = {
        v: 1,
        uid: user.id,
        rel: relPath,
        total: totalSize,
        cs: chunkSize,
        n,
        fn: String(body.original_filename ?? "upload"),
        ct: body.content_type ?? null,
        enc: prepared.encryptionMode,
        cmp: prepared.compress,
        perm: prepared.isPermanent,
        td: prepared.tempDays,
        did: body.delete_if_idle_days ?? null,
        aaid: body.archive_after_idle_days ?? null,
        auod: body.auto_unarchive_on_download ?? true,
        rnd: prepared.randomizeFilename,
        dir: prepared.directory ? prepared.directory.id : null,
        mu: body.max_uses ?? null,
        eis: body.expires_in_seconds ?? null,
        exp: Math.floor(Date.now() / 1000) + CHUNK_SESSION_TTL,
      };
      log.info(
        `chunked upload initialized user_id=${user.id} total_bytes=${totalSize} chunks=${n} chunk_size=${chunkSize} encryption=${prepared.encryptionMode} directory_id=${meta.dir}`,
      );
      res.json({
        upload_id: sealChunkToken(state, meta),
        chunk_size: chunkSize,
        num_chunks: n,
        total: totalSize,
        received: [],
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.get("/upload/status", getUploadUser(state), (req, res) => {
    try {
      const user = req.currentUser!;
      const meta = openChunkToken(state, String(req.query.upload_id ?? ""), user);
      const parts = partsDir(meta.rel);
      if (!existsSync(parts)) {
        res.status(410).json({ detail: "upload session gone" });
        return;
      }
      res.json({
        upload_id: req.query.upload_id,
        total: meta.total,
        chunk_size: meta.cs,
        num_chunks: meta.n,
        received: receivedIndices(parts, meta.n),
      });
    } catch (err) {
      respondError(res, err);
    }
  });

  router.post("/upload/chunk", getUploadUser(state), (req, res, next) => {
    let meta: ChunkMeta;
    try {
      const user = req.currentUser!;
      meta = openChunkToken(state, String(req.query.upload_id ?? ""), user);
    } catch (err) {
      respondError(res, err);
      return;
    }
    const parts = partsDir(meta.rel);
    if (!existsSync(parts)) {
      res.status(410).json({ detail: "upload session gone" });
      return;
    }
    const index = Number(req.query.index);
    const expected = expectedChunkLen(index, meta.total, meta.cs, meta.n);
    if (expected < 0) {
      res.status(400).json({ detail: "invalid chunk index" });
      return;
    }
    const tmp = join(parts, `${index}.${randomBytes(8).toString("hex")}.tmp`);
    const out = createWriteStream(tmp);
    let written = 0;
    let handled = false;
    req.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (written > expected) {
        handled = true;
        out.destroy();
        try {
          unlinkSync(tmp);
        } catch {
          // best-effort
        }
        res.status(413).json({ detail: "chunk exceeds expected size" });
        req.destroy();
        return;
      }
      out.write(chunk);
    });
    req.on("end", () => {
      if (handled) return;
      out.end(() => {
        if (handled) return;
        if (written !== expected) {
          try {
            unlinkSync(tmp);
          } catch {
            // best-effort
          }
          res.status(400).json({ detail: "incomplete chunk" });
          return;
        }
        renameSync(tmp, join(parts, String(index)));
        res.json({ index, num_chunks: meta.n });
      });
    });
    req.on("error", (err) => {
      handled = true;
      out.destroy();
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
      next(err);
    });
  });

  router.post("/upload/finalize", getUploadUser(state), async (req, res) => {
    try {
      const user = req.currentUser!;
      const uploadId = String(req.body?.upload_id ?? "");
      const meta = openChunkToken(state, uploadId, user);
      const relPath = meta.rel;
      const parts = partsDir(relPath);
      if (!existsSync(parts)) {
        res.status(410).json({ detail: "upload session gone" });
        return;
      }
      const received = new Set(receivedIndices(parts, meta.n));
      const missing: number[] = [];
      for (let i = 0; i < meta.n; i++) if (!received.has(i)) missing.push(i);
      if (missing.length) {
        log.info(`chunked upload finalize incomplete user_id=${user.id} missing_count=${missing.length}`);
        res.status(409).json({ detail: { error: "upload incomplete", missing: missing.slice(0, 512) } });
        return;
      }

      const work = `${join(storageRoot(), relPath)}.part`;
      const out = createWriteStream(work);
      for (let i = 0; i < meta.n; i++) {
        const chunkPath = join(parts, String(i));
        await new Promise<void>((resolve, reject) => {
          const rs = createReadStream(chunkPath);
          rs.on("error", reject);
          rs.on("end", resolve);
          rs.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve) => out.end(resolve));
      const stored = statSync(work).size;
      if (stored !== meta.total) {
        unlinkSync(work);
        res.status(400).json({ detail: "assembled size mismatch" });
        return;
      }

      let directory: DirRow | null = null;
      if (meta.dir !== null) {
        directory = db.get<DirRow>("SELECT * FROM directories WHERE id = $id", { $id: meta.dir }) ?? null;
        if (!directory) {
          unlinkSync(work);
          res.status(404).json({ detail: "directory not found" });
          return;
        }
        if (!canEditDirectory(state, directory.id, user)) {
          unlinkSync(work);
          res.status(403).json({ detail: "not your directory" });
          return;
        }
      }

      const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
      const result = await finalizeStoredFile({
        state,
        req,
        user,
        perm,
        directory,
        workPath: work,
        relPath,
        stored,
        contentType: meta.ct,
        encryptionMode: meta.enc,
        compress: meta.cmp,
        randomizeFilename: meta.rnd,
        originalFilename: meta.fn,
        isPermanent: meta.perm,
        tempDays: meta.td,
        deleteIfIdleDays: meta.did,
        archiveAfterIdleDays: meta.aaid,
        autoUnarchiveOnDownload: meta.auod,
        maxUses: meta.mu,
        expiresInSeconds: meta.eis,
      });
      await rm(parts, { recursive: true, force: true });
      log.info(`chunked upload finalized user_id=${user.id} total_bytes=${meta.total} chunks=${meta.n}`);
      res.json(result);
    } catch (err) {
      respondError(res, err);
    }
  });

  router.delete("/upload", getUploadUser(state), (req, res) => {
    try {
      const user = req.currentUser!;
      const meta = openChunkToken(state, String(req.query.upload_id ?? ""), user);
      rmSync(partsDir(meta.rel), { recursive: true, force: true });
      try {
        unlinkSync(`${join(storageRoot(), meta.rel)}.part`);
      } catch {
        // best-effort
      }
      log.info(`chunked upload aborted user_id=${user.id} total_bytes=${meta.total}`);
      res.json({ status: "aborted" });
    } catch (err) {
      respondError(res, err);
    }
  });

  // ── save / list / delete / links ────────────────────────────────────
  router.post("/:slug/save", requireSession(state), requireCsrf, requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const link = resolveActiveLink(db, req.params.slug);
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const source = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!source) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (source.owner_id === user.id) {
      res.status(409).json({ detail: "you own this file" });
      return;
    }
    const already = db.get<FileRow>("SELECT * FROM files WHERE owner_id = $uid AND saved_from_file_id = $fid", {
      $uid: user.id,
      $fid: source.id,
    });
    if (already) {
      res.status(409).json({ detail: "already saved" });
      return;
    }
    const ek = typeof req.query.ek === "string" ? req.query.ek : null;
    if (!verifyFileAccessKey(state, source, ek)) {
      res.status(401).json({ detail: "missing or invalid access key (?ek=)" });
      return;
    }
    const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
    if (usedBytes(state, user.id) + source.size_bytes > perm.quota_bytes) {
      res.status(413).json({ detail: "save would exceed your quota" });
      return;
    }
    if (!consumeUse(db, req.params.slug)) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (source.blob_id) {
      db.run("UPDATE content_blobs SET ref_count = ref_count + 1 WHERE id = $id", { $id: source.blob_id });
    }
    db.run(
      `INSERT INTO files (
         owner_id, directory_id, blob_id, storage_path, original_filename, source_type,
         saved_from_file_id, size_bytes, stored_size_bytes, content_type, encryption_mode,
         enc_key_blob, enc_access_blob, compressed, archived, archive_codec,
         archive_original_stored_size_bytes, archive_saved_bytes, archive_after_idle_days,
         lifecycle_state, is_permanent, delete_if_idle_days, auto_unarchive_on_download, created_at
       ) VALUES ($ownerId, NULL, $blobId, $path, $filename, 'saved', $savedFrom, $size, $storedSize, $ct, $enc,
         $encKey, $encAccess, $compressed, $archived, $archiveCodec, $archiveOrigStored, $archiveSaved,
         $archiveAfterIdle, $lifecycle, 1, $deleteIfIdle, $autoUnarchive, $now)`,
      {
        $ownerId: user.id,
        $blobId: source.blob_id,
        $path: source.storage_path,
        $filename: source.original_filename,
        $savedFrom: source.id,
        $size: source.size_bytes,
        $storedSize: source.stored_size_bytes,
        $ct: source.content_type,
        $enc: source.encryption_mode,
        $encKey: source.enc_key_blob ? Buffer.from(source.enc_key_blob) : null,
        $encAccess: source.enc_access_blob ? Buffer.from(source.enc_access_blob) : null,
        $compressed: source.compressed,
        $archived: source.archived,
        $archiveCodec: source.archive_codec,
        $archiveOrigStored: source.archive_original_stored_size_bytes,
        $archiveSaved: source.archive_saved_bytes,
        $archiveAfterIdle: source.archive_after_idle_days,
        $lifecycle: source.lifecycle_state,
        $deleteIfIdle: source.delete_if_idle_days,
        $autoUnarchive: source.auto_unarchive_on_download,
        $now: nowIso(),
      },
    );
    const saved = db.get<FileRow>("SELECT * FROM files WHERE id = last_insert_rowid()")!;
    const newLinkSlug = newSlug();
    db.run("INSERT INTO links (file_id, slug, use_count, active, created_at) VALUES ($fid, $slug, 0, 1, $now)", {
      $fid: saved.id,
      $slug: newLinkSlug,
      $now: nowIso(),
    });
    recordAudit(db, {
      actor: user.username,
      action: "file.saved",
      target: `file:${source.id}->file:${saved.id}`,
      ip: clientIp(state, req),
    });
    log.info(`shared file saved source_file_id=${source.id} saved_file_id=${saved.id} owner_id=${user.id} blob_id=${saved.blob_id}`);
    const base = fileUrl(req, newLinkSlug);
    res.json({
      file_id: saved.id,
      slug: newLinkSlug,
      url: base,
      raw_url: `${base}/raw`,
      saved_from_file_id: source.id,
      source_type: "saved",
      blob_id: saved.blob_id,
      encryption_mode: saved.encryption_mode,
      access_key: recoverAccessKey(state, saved),
    });
  });

  router.get("/", requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const files = db.all<FileRow>(
      "SELECT * FROM files WHERE directory_id IS NULL AND owner_id = $id ORDER BY created_at DESC",
      { $id: user.id },
    );
    res.json({ files: serializeFiles(state, req, files) });
  });

  router.get("/batch-zip", requireActiveUser(state), async (req, res) => {
    const user = req.currentUser!;
    const rawIds = req.query.ids;
    const ids = (Array.isArray(rawIds) ? rawIds : rawIds !== undefined ? [rawIds] : [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    if (!ids.length) {
      res.status(400).json({ detail: "no file ids given" });
      return;
    }
    const wanted = [...new Set(ids)];
    if (wanted.length > 500) {
      res.status(400).json({ detail: "too many files in one batch (max 500)" });
      return;
    }
    const files = db.all<FileRow>(`SELECT * FROM files WHERE id IN (${wanted.map((_, i) => `$id${i}`).join(",")})`, Object.fromEntries(wanted.map((id, i) => [`$id${i}`, id])));
    const byId = new Map(files.map((f) => [f.id, f]));
    const isMaster = user.role === "master";
    const selected: FileRow[] = [];
    for (const fid of wanted) {
      const f = byId.get(fid);
      if (!f) continue;
      if (!isMaster && f.owner_id !== user.id) {
        res.status(403).json({ detail: `not your file: ${fid}` });
        return;
      }
      if (f.encryption_mode === "client") continue;
      selected.push(f);
    }
    if (!selected.length) {
      res.status(404).json({ detail: "no downloadable files in selection" });
      return;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="files.zip"');
    const archive = new ZipArchive({ store: true });
    archive.on("error", (err: Error) => {
      if (!res.headersSent) res.status(500).json({ detail: "zip failed" });
      else res.destroy();
      log.error(`batch-zip failed: ${err.message}`);
    });
    archive.pipe(res);

    const masterKey = getMasterKey(state.settings);
    const seen = new Set<string>();
    const cleanup: string[] = [];
    try {
      for (const f of selected) {
        const name = safeArcname(f.original_filename, seen);
        const [src, isTemp] = await memberSource(masterKey, f);
        if (isTemp) cleanup.push(src);
        archive.file(src, { name });
      }
      recordAudit(db, {
        actor: user.username,
        action: "files.batch_downloaded",
        target: `files:${selected.length}`,
        ip: clientIp(state, req),
      });
      await archive.finalize();
    } finally {
      for (const p of cleanup) {
        try {
          unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    }
  });

  router.get("/disk-stats", requireMaster(state), (_req, res) => {
    const totalBytes = usedStorageBytes(db);
    const totalFiles = db.get<{ n: number }>("SELECT COUNT(*) as n FROM files")!.n;
    const totalLinks = db.get<{ n: number }>("SELECT COUNT(*) as n FROM links WHERE active = 1")!.n;
    const totalUsers = db.get<{ n: number }>("SELECT COUNT(*) as n FROM users")!.n;
    res.json({ total_bytes: totalBytes, total_files: totalFiles, total_links: totalLinks, total_users: totalUsers });
  });

  router.get("/usage", requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
    res.json({
      used_bytes: usedBytes(state, user.id),
      quota_bytes: perm.quota_bytes,
      max_file_bytes: perm.max_file_bytes,
    });
  });

  router.delete("/:fileId(\\d+)", requireSession(state), requireCsrf, requirePermission(state, "can_delete"), (req, res) => {
    const user = req.currentUser!;
    const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: req.params.fileId });
    if (!fileObj) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (user.role !== "master" && fileObj.owner_id !== user.id) {
      res.status(403).json({ detail: "not your file" });
      return;
    }
    db.run("DELETE FROM links WHERE file_id = $id", { $id: fileObj.id });
    if (fileObj.directory_id !== null) {
      db.run("UPDATE directories SET total_bytes = MAX(0, COALESCE(total_bytes, 0) - $dec) WHERE id = $id", {
        $dec: fileObj.size_bytes ?? 0,
        $id: fileObj.directory_id,
      });
    }
    const unlinkAfterCommit = [releaseBlob(db, fileObj)];
    db.run("DELETE FROM files WHERE id = $id", { $id: fileObj.id });
    recordAudit(db, { actor: user.username, action: "file.deleted", target: `file:${fileObj.id}`, ip: clientIp(state, req) });
    unlinkQueued(unlinkAfterCommit);
    res.json({ status: "deleted" });
  });

  router.post("/:fileId(\\d+)/links", requireSession(state), requireCsrf, requirePermission(state, "can_regenerate_links"), (req, res) => {
    const user = req.currentUser!;
    const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: req.params.fileId });
    if (!fileObj) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (user.role !== "master" && fileObj.owner_id !== user.id) {
      res.status(403).json({ detail: "not your file" });
      return;
    }
    const body = req.body ?? {};
    let expiresAt: string | null = null;
    if (body.expires_in_seconds !== undefined && body.expires_in_seconds !== null) {
      expiresAt = new Date(Date.now() + Number(body.expires_in_seconds) * 1000).toISOString();
    }
    const slug = newSlug();
    db.run(
      `INSERT INTO links (file_id, slug, max_uses, expires_at, use_count, active, hide_uploader, created_at)
       VALUES ($fileId, $slug, $maxUses, $expiresAt, 0, 1, $hideUploader, $now)`,
      {
        $fileId: fileObj.id,
        $slug: slug,
        $maxUses: body.max_uses ?? null,
        $expiresAt: expiresAt,
        $hideUploader: body.hide_uploader ? 1 : 0,
        $now: nowIso(),
      },
    );
    const link = db.get<LinkRow>("SELECT * FROM links WHERE id = last_insert_rowid()")!;
    recordAudit(db, { actor: user.username, action: "link.created", target: `link:${link.id}`, ip: clientIp(state, req) });
    const base = fileUrl(req, slug);
    res.json({
      slug,
      url: base,
      raw_url: `${base}/raw`,
      encryption_mode: fileObj.encryption_mode,
      access_key: recoverAccessKey(state, fileObj),
    });
  });

  return router;
}

/** Mounted separately at /admin/files in app.ts. */
export function adminFilesRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.get("/", requireMaster(state), (req, res) => {
    const files = db.all<FileRow>("SELECT * FROM files WHERE directory_id IS NULL ORDER BY created_at DESC");
    res.json({ files: serializeFiles(state, req, files) });
  });

  return router;
}

/** Mounted separately at /links in app.ts for /links/:linkId edit + delete. */
export function linksRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.delete("/:linkId", requireSession(state), requireCsrf, requirePermission(state, "can_delete_links"), (req, res) => {
    const user = req.currentUser!;
    const link = db.get<LinkRow>("SELECT * FROM links WHERE id = $id", { $id: req.params.linkId });
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!fileObj || (user.role !== "master" && fileObj.owner_id !== user.id)) {
      res.status(403).json({ detail: "not your file" });
      return;
    }
    db.run("DELETE FROM links WHERE id = $id", { $id: link.id });
    recordAudit(db, { actor: user.username, action: "link.deleted", target: `link:${link.id}`, ip: clientIp(state, req) });
    res.json({ status: "deleted" });
  });

  router.patch("/:linkId", requireSession(state), requireCsrf, requirePermission(state, "can_regenerate_links"), (req, res) => {
    const user = req.currentUser!;
    const link = db.get<LinkRow>("SELECT * FROM links WHERE id = $id", { $id: req.params.linkId });
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!fileObj || (user.role !== "master" && fileObj.owner_id !== user.id)) {
      res.status(403).json({ detail: "not your file" });
      return;
    }
    const body = req.body ?? {};
    if (Object.prototype.hasOwnProperty.call(body, "max_uses")) {
      db.run("UPDATE links SET max_uses = $v WHERE id = $id", { $v: body.max_uses, $id: link.id });
    }
    if (body.expires_in_seconds !== undefined && body.expires_in_seconds !== null) {
      db.run("UPDATE links SET expires_at = $v WHERE id = $id", {
        $v: new Date(Date.now() + Number(body.expires_in_seconds) * 1000).toISOString(),
        $id: link.id,
      });
    }
    if (body.active !== undefined && body.active !== null) {
      db.run("UPDATE links SET active = $v WHERE id = $id", { $v: body.active ? 1 : 0, $id: link.id });
    }
    if (body.hide_uploader !== undefined && body.hide_uploader !== null) {
      db.run("UPDATE links SET hide_uploader = $v WHERE id = $id", { $v: body.hide_uploader ? 1 : 0, $id: link.id });
    }
    recordAudit(db, { actor: user.username, action: "link.edited", target: `link:${link.id}`, ip: clientIp(state, req) });
    res.json({ status: "updated" });
  });

  return router;
}

function respondError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.detail });
    return;
  }
  log.error(`unhandled route error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  res.status(500).json({ detail: "internal server error" });
}
