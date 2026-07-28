import { Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import type { Request, Response } from "express";
import { ZipArchive } from "archiver";
import type { AppState } from "../appState.ts";
import type { Db } from "../db/types.ts";
import { requireCsrf } from "../security/csrf.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { requireActiveUser, requireMaster } from "../middleware/deps.ts";
import { requireSession, clientIp } from "../middleware/auth.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { getMasterKey } from "../config.ts";
import { recordAudit } from "../audit.ts";
import { getLogger } from "../logging.ts";
import { HttpError } from "../httpError.ts";
import { newSlug } from "../links.ts";
import { releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";
import { safeArcname, memberSource } from "../storage/zip.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";
import { seal, openBox } from "../crypto/secretbox.ts";
import { ensurePermissions } from "../permissions.ts";
import { usedStorageBytesForUser } from "../storage/accounting.ts";
import { renderSpa } from "../spa.ts";
import {
  nowIso,
  type DirectoryLinkRow,
  type DirectoryRow,
  type FileRow,
  type LinkRow,
  type UserRow,
} from "../db/rows.ts";

const log = getLogger("app.routes.directories");

const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; " +
  "media-src 'self' blob:; " +
  "frame-src 'self'; " +
  "worker-src 'self' blob:; " +
  "connect-src 'self'; " +
  "object-src 'none'";
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CSP,
};

const MAX_EPOCH_MS = 8640000000000000; // Date's max representable instant.

interface FileCountRow {
  n: number;
}
interface RoleRow {
  role: string;
}
interface CollabIdRow {
  id: number;
}

function dirUrl(req: Request, slug: string): string {
  return `${req.protocol}://${req.get("host")}/d/${slug}`;
}

function recoverDirAccessKey(state: AppState, d: DirectoryRow): string | null {
  if (d.encryption_mode !== "server" || !d.enc_access_blob) return null;
  try {
    return openBox(getMasterKey(state.settings), Buffer.from(d.enc_access_blob)).toString("utf-8");
  } catch {
    return null;
  }
}

function verifyDirAccessKey(state: AppState, d: DirectoryRow, ek: string | null): boolean {
  if (d.encryption_mode !== "server") return true;
  const expected = recoverDirAccessKey(state, d);
  if (expected === null || !ek) return false;
  const a = Buffer.from(ek);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isEditor(db: Db, d: DirectoryRow, user: UserRow): boolean {
  if (user.role === "master" || d.owner_id === user.id) return true;
  return !!db.get<CollabIdRow>(
    "SELECT id FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user AND role = 'editor'",
    { $dir: d.id, $user: user.id },
  );
}

function directoryRole(db: Db, d: DirectoryRow, user: UserRow): string | null {
  if (user.role === "master" || d.owner_id === user.id) return "owner";
  const collab = db.get<RoleRow>(
    "SELECT role FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user",
    { $dir: d.id, $user: user.id },
  );
  return collab ? collab.role : null;
}

/** Mirrors app/routes/directories.py::_resolve, but -- unlike the Python
 * reference, which only checks DirectoryLink.active and ignores its own
 * max_uses/expires_at fields even though the model defines them -- this also
 * enforces the link's own limits, mirroring links.ts::resolveActiveLink for
 * file links (same DirectoryLink/Link column shapes per CLAUDE.md's "Share
 * links (folders)" section). */
function resolveActiveDirLink(db: Db, slug: string): DirectoryLinkRow | null {
  const link = db.get<DirectoryLinkRow>("SELECT * FROM directory_links WHERE slug = $slug", { $slug: slug });
  if (!link || !link.active) return null;
  const now = new Date().toISOString();
  if (link.expires_at !== null && link.expires_at <= now) return null;
  if (link.max_uses !== null && link.use_count >= link.max_uses) return null;
  return link;
}

/** Atomically claims one use, mirrors links.ts::consumeUse for directory_links. */
function consumeDirUse(db: Db, slug: string): boolean {
  const now = new Date().toISOString();
  const claimed = db.get<{ id: number }>(
    `UPDATE directory_links SET use_count = use_count + 1
     WHERE slug = $slug AND active = 1
       AND (expires_at IS NULL OR expires_at > $now)
       AND (max_uses IS NULL OR use_count < max_uses)
     RETURNING id`,
    { $slug: slug, $now: now },
  );
  return !!claimed;
}

interface ResolvedDirectory {
  directory: DirectoryRow;
  link: DirectoryLinkRow;
}

function resolveDirectory(db: Db, slug: string): ResolvedDirectory | null {
  const link = resolveActiveDirLink(db, slug);
  if (!link) return null;
  const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: link.directory_id });
  if (!d) return null;
  const now = new Date().toISOString();
  if (d.expires_at !== null && d.expires_at <= now) return null;
  return { directory: d, link };
}

function serializeDirectories(
  state: AppState,
  req: Request,
  dirs: DirectoryRow[],
  user?: UserRow,
): Record<string, unknown>[] {
  const { db } = state;
  return dirs.map((d) => {
    const fileCount = db.get<FileCountRow>("SELECT COUNT(*) as n FROM files WHERE directory_id = $id", {
      $id: d.id,
    })!.n;
    return {
      id: d.id,
      owner_id: d.owner_id,
      slug: d.slug,
      title: d.title,
      url: dirUrl(req, d.slug),
      encryption_mode: d.encryption_mode,
      key_check_blob: d.key_check_blob,
      access_key: recoverDirAccessKey(state, d),
      file_count: fileCount,
      total_bytes: d.total_bytes,
      expires_at: d.expires_at,
      created_at: d.created_at,
      role: user ? directoryRole(db, d, user) : null,
    };
  });
}

function serializeDirLink(lk: DirectoryLinkRow, req: Request): Record<string, unknown> {
  return {
    id: lk.id,
    slug: lk.slug,
    url: dirUrl(req, lk.slug),
    max_uses: lk.max_uses,
    use_count: lk.use_count,
    expires_at: lk.expires_at,
    active: !!lk.active,
    hide_uploader: !!lk.hide_uploader,
    created_at: lk.created_at,
  };
}

/** Member files paired with their most-recent active link, mirrors
 * app/routes/directories.py::_public_files. Batch-fetches every member's
 * links in one query instead of one query per file (N+1). */
function publicFiles(db: Db, dirId: number): Array<{ file: FileRow; link: LinkRow }> {
  const members = db.all<FileRow>("SELECT * FROM files WHERE directory_id = $id ORDER BY created_at ASC", {
    $id: dirId,
  });
  if (!members.length) return [];
  const fileIds = members.map((f) => f.id);
  const linkRows = db.all<LinkRow>(
    `SELECT * FROM links WHERE active = 1 AND file_id IN (${fileIds.map((_, i) => `$fid${i}`).join(",")}) ORDER BY created_at DESC`,
    Object.fromEntries(fileIds.map((id, i) => [`$fid${i}`, id])),
  );
  // First row per file_id wins -- rows are ordered created_at DESC, matching
  // the single-file query's "most recent active link" semantics.
  const latestByFile = new Map<number, LinkRow>();
  for (const lk of linkRows) {
    if (!latestByFile.has(lk.file_id)) latestByFile.set(lk.file_id, lk);
  }
  const out: Array<{ file: FileRow; link: LinkRow }> = [];
  for (const f of members) {
    const link = latestByFile.get(f.id);
    if (link) out.push({ file: f, link });
  }
  return out;
}

function previewGroup(contentType: string, filename: string): string {
  const ct = (contentType || "application/octet-stream").toLowerCase();
  const name = filename.toLowerCase();
  if (ct.startsWith("image/")) return "images";
  if (ct.startsWith("video/")) return "videos";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("text/") || /\.(txt|md|json|csv|log)$/.test(name)) return "text";
  if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdfs";
  if (ct === "application/zip" || ct === "application/x-zip-compressed" || name.endsWith(".zip")) return "archives";
  return "other";
}

/** Reads just the ZIP End-Of-Central-Directory record plus the central
 * directory itself (not the whole file) to list member names and detect
 * per-entry encryption (general-purpose bit flag 0). No zip-reading library
 * is vendored in server/ (only `archiver` for writing) so this is a minimal
 * hand-rolled parser -- sufficient for the preview feature's namelist/flag
 * needs, mirrors Python's zipfile.ZipFile inspection in _archive_preview. */
function readZipManifest(path: string): { entries: string[]; entryCount: number; encrypted: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const EOCD_SIG = 0x06054b50;
    const MIN_EOCD = 22;
    const MAX_COMMENT = 65535;
    const tailLen = Math.min(size, MIN_EOCD + MAX_COMMENT);
    if (tailLen < MIN_EOCD) return null;
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocdOffset = -1;
    for (let i = tail.length - MIN_EOCD; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return null;
    const totalEntries = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);
    if (cdOffset + cdSize > size) return null; // zip64 or corrupt -- bail rather than misparse
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    const entries: string[] = [];
    let encrypted = false;
    let pos = 0;
    for (let i = 0; i < totalEntries && pos + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(pos + 8);
      if (flags & 0x1) encrypted = true;
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      entries.push(cd.toString("utf-8", pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, entryCount: totalEntries, encrypted };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function archivePreview(f: FileRow): Record<string, unknown> {
  if (f.encryption_mode !== "none" || f.compressed || f.archived) {
    return { status: "unreadable", reason: "encrypted or transformed archive" };
  }
  let full: string;
  try {
    full = safeJoin(storageRoot(), f.storage_path);
  } catch {
    return { status: "unreadable", reason: "corrupt or unsupported archive" };
  }
  const manifest = readZipManifest(full);
  if (!manifest) return { status: "unreadable", reason: "corrupt or unsupported archive" };
  if (manifest.encrypted) return { status: "unreadable", reason: "encrypted archive" };
  return { status: "readable", entries: manifest.entries.slice(0, 100), entry_count: manifest.entryCount };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function directoryPageMeta(req: Request, db: Db, d: DirectoryRow): string {
  const pairs = publicFiles(db, d.id);
  const totalBytes = pairs.reduce((sum, { file }) => sum + file.size_bytes, 0);
  const title = escapeHtml(d.title || "Shared folder");
  const desc = escapeHtml(`${pairs.length} files, ${totalBytes} bytes`);
  const url = escapeHtml(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
  return [
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:url" content="${url}">`,
    '<meta property="og:type" content="website">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${desc}">`,
  ].join("\n");
}

function expiresAtFromSeconds(res: Response, seconds: unknown): { ok: true; value: string | null } | { ok: false } {
  if (seconds === undefined || seconds === null || Number(seconds) < 1) return { ok: true, value: null };
  const ms = Date.now() + Number(seconds) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) {
    res.status(400).json({ detail: "expires_in_seconds is too large" });
    return { ok: false };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}

/** Mirrors app/routes/directories.py -- folder CRUD, collaborators, and
 * per-folder link CRUD. Mounted at /api with no further prefix -- every path
 * in this router already spells out its own /directories segment. */
export function directoriesRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.post("/directories", requireSession(state), requireCsrf, requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const body = req.body ?? {};
    const encryptionMode = body.encryption_mode || "none";
    if (!["none", "server", "client"].includes(encryptionMode)) {
      res.status(400).json({ detail: "invalid encryption_mode" });
      return;
    }
    const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
    if (!perm.can_create_directories) {
      res.status(403).json({ detail: "directory creation not permitted" });
      return;
    }
    if (encryptionMode === "client") {
      if (!perm.can_upload_client_encrypted) {
        res.status(403).json({ detail: "client-side encryption not permitted" });
        return;
      }
      if (!body.key_check_blob) {
        res.status(400).json({ detail: "client directories require key_check_blob" });
        return;
      }
    }

    const title = (typeof body.title === "string" ? body.title : "Untitled folder").trim().slice(0, 512) || "Untitled folder";
    const expires = expiresAtFromSeconds(res, body.expires_in_seconds);
    if (!expires.ok) return;

    let encKeyBlob: Buffer | null = null;
    let encAccessBlob: Buffer | null = null;
    let accessKey: string | null = null;
    if (encryptionMode === "server") {
      const masterKey = getMasterKey(state.settings);
      const dirKey = randomBytes(32);
      accessKey = randomBytes(18).toString("base64url");
      encKeyBlob = seal(masterKey, dirKey);
      encAccessBlob = seal(masterKey, Buffer.from(accessKey));
    }

    const slug = newSlug();
    db.run(
      `INSERT INTO directories (
         owner_id, slug, title, encryption_mode, enc_key_blob, enc_access_blob,
         key_check_blob, expires_at, created_at
       ) VALUES ($ownerId, $slug, $title, $enc, $encKey, $encAccess, $keyCheck, $expiresAt, $now)`,
      {
        $ownerId: user.id,
        $slug: slug,
        $title: title,
        $enc: encryptionMode,
        $encKey: encKeyBlob,
        $encAccess: encAccessBlob,
        $keyCheck: encryptionMode === "client" ? (body.key_check_blob ?? null) : null,
        $expiresAt: expires.value,
        $now: nowIso(),
      },
    );
    const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = last_insert_rowid()")!;
    // Default DirectoryLink so /d/{slug} resolves via the link system, mirrors
    // the directory-links auto-create noted in CLAUDE.md's "Share links (folders)".
    db.run(
      "INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
      { $dirId: d.id, $slug: slug, $now: nowIso() },
    );
    recordAudit(db, { actor: user.username, action: "directory.created", target: `directory:${d.id}`, ip: clientIp(state, req) });
    log.info(`directory created directory_id=${d.id} owner_id=${user.id} encryption=${encryptionMode}`);

    res.json({
      id: d.id,
      slug,
      url: dirUrl(req, slug),
      encryption_mode: d.encryption_mode,
      key_check_blob: d.key_check_blob,
      access_key: accessKey,
    });
  });

  router.get("/directories/", requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const owned = db.all<DirectoryRow>("SELECT * FROM directories WHERE owner_id = $id", { $id: user.id });
    const collaborated = db.all<DirectoryRow>(
      `SELECT d.* FROM directories d
       JOIN directory_collaborators dc ON dc.directory_id = d.id
       WHERE dc.user_id = $id`,
      { $id: user.id },
    );
    const byId = new Map<number, DirectoryRow>();
    for (const d of owned) byId.set(d.id, d);
    for (const d of collaborated) if (!byId.has(d.id)) byId.set(d.id, d);
    const dirs = [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    res.json({ directories: serializeDirectories(state, req, dirs, user) });
  });

  router.get("/directories/:dirId(\\d+)/files", requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
    if (!d) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (!isEditor(db, d, user)) {
      res.status(403).json({ detail: "not your directory" });
      return;
    }
    const members = db.all<FileRow>("SELECT * FROM files WHERE directory_id = $id ORDER BY created_at ASC", { $id: d.id });
    const files = members.map((f) => {
      const link = db.get<LinkRow>(
        "SELECT * FROM links WHERE file_id = $id AND active = 1 ORDER BY created_at DESC LIMIT 1",
        { $id: f.id },
      );
      return {
        id: f.id,
        slug: link ? link.slug : null,
        filename: f.original_filename,
        size_bytes: f.size_bytes,
        stored_size_bytes: f.stored_size_bytes,
        content_type: f.content_type,
        encryption_mode: f.encryption_mode,
        created_at: f.created_at,
      };
    });
    res.json({ files });
  });

  router.delete(
    "/directories/:dirId(\\d+)/files/:fileId(\\d+)",
    requireSession(state),
    requireCsrf,
    requireActiveUser(state),
    (req, res) => {
      const user = req.currentUser!;
      const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
      if (!d) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      if (!isEditor(db, d, user)) {
        res.status(403).json({ detail: "not your directory" });
        return;
      }
      // DELETE /files/:fileId requires can_delete -- without this check a
      // user denied deletion could route around it through a folder instead.
      const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
      if (!perm.can_delete) {
        res.status(403).json({ detail: "deletion not permitted" });
        return;
      }
      const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: req.params.fileId });
      if (!fileObj || fileObj.directory_id !== d.id) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      db.run("DELETE FROM links WHERE file_id = $id", { $id: fileObj.id });
      db.run("UPDATE directories SET total_bytes = MAX(0, COALESCE(total_bytes, 0) - $dec) WHERE id = $id", {
        $dec: fileObj.size_bytes ?? 0,
        $id: d.id,
      });
      const unlinkAfterCommit = [releaseBlob(db, fileObj)];
      db.run("DELETE FROM files WHERE id = $id", { $id: fileObj.id });
      deleteThumbnail(fileObj.id);
      recordAudit(db, {
        actor: user.username,
        action: "directory.file_deleted",
        target: `file:${fileObj.id}`,
        ip: clientIp(state, req),
      });
      unlinkQueued(unlinkAfterCommit);
      res.json({ status: "deleted" });
    },
  );

  router.post(
    "/directories/:dirId(\\d+)/collaborators",
    requireSession(state),
    requireCsrf,
    requireActiveUser(state),
    (req, res) => {
      const user = req.currentUser!;
      const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
      if (!d) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      if (user.role !== "master" && d.owner_id !== user.id) {
        res.status(403).json({ detail: "not your directory" });
        return;
      }
      const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
      const target = db.get<UserRow>("SELECT * FROM users WHERE username = $u", { $u: username });
      if (!target) {
        res.status(404).json({ detail: "user not found" });
        return;
      }
      if (target.id === d.owner_id) {
        res.status(400).json({ detail: "owner is already a collaborator" });
        return;
      }
      let existing = db.get<{ id: number; role: string }>(
        "SELECT id, role FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user",
        { $dir: d.id, $user: target.id },
      );
      if (!existing) {
        db.run(
          `INSERT INTO directory_collaborators (directory_id, user_id, invited_by_id, role, created_at)
           VALUES ($dir, $user, $invitedBy, 'editor', $now)`,
          { $dir: d.id, $user: target.id, $invitedBy: user.id, $now: nowIso() },
        );
        existing = db.get<{ id: number; role: string }>("SELECT id, role FROM directory_collaborators WHERE id = last_insert_rowid()")!;
      }
      recordAudit(db, {
        actor: user.username,
        action: "directory.collaborator_added",
        target: `directory:${d.id}:user:${target.id}`,
        ip: clientIp(state, req),
      });
      res.json({ id: existing.id, directory_id: d.id, user_id: target.id, username: target.username, role: existing.role });
    },
  );

  router.delete(
    "/directories/:dirId(\\d+)/collaborators/:userId(\\d+)",
    requireSession(state),
    requireCsrf,
    requireActiveUser(state),
    (req, res) => {
      const user = req.currentUser!;
      const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
      if (!d) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      if (user.role !== "master" && d.owner_id !== user.id) {
        res.status(403).json({ detail: "not your directory" });
        return;
      }
      const row = db.get<CollabIdRow>(
        "SELECT id FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user",
        { $dir: d.id, $user: req.params.userId },
      );
      if (!row) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      db.run("DELETE FROM directory_collaborators WHERE id = $id", { $id: row.id });
      recordAudit(db, {
        actor: user.username,
        action: "directory.collaborator_removed",
        target: `directory:${d.id}:user:${req.params.userId}`,
        ip: clientIp(state, req),
      });
      res.json({ status: "removed" });
    },
  );

  router.delete("/directories/:dirId(\\d+)", requireSession(state), requireCsrf, requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
    if (!d) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (user.role !== "master" && d.owner_id !== user.id) {
      res.status(403).json({ detail: "not your directory" });
      return;
    }
    // Same can_delete gate as the single-file route above and DELETE /files/:fileId.
    const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
    if (!perm.can_delete) {
      res.status(403).json({ detail: "deletion not permitted" });
      return;
    }

    const members = db.all<FileRow>("SELECT * FROM files WHERE directory_id = $id", { $id: d.id });
    const unlinkAfterCommit: Array<string | null> = [];
    for (const f of members) {
      db.run("DELETE FROM links WHERE file_id = $id", { $id: f.id });
      unlinkAfterCommit.push(releaseBlob(db, f));
      db.run("DELETE FROM files WHERE id = $id", { $id: f.id });
      deleteThumbnail(f.id);
    }
    db.run("DELETE FROM dropbox_upload_links WHERE target_directory_id = $id", { $id: d.id });
    db.run("DELETE FROM directory_collaborators WHERE directory_id = $id", { $id: d.id });
    db.run("DELETE FROM directory_links WHERE directory_id = $id", { $id: d.id });
    db.run("DELETE FROM directories WHERE id = $id", { $id: d.id });
    recordAudit(db, { actor: user.username, action: "directory.deleted", target: `directory:${d.id}`, ip: clientIp(state, req) });
    unlinkQueued(unlinkAfterCommit);
    res.json({ status: "deleted", files_removed: members.length });
  });

  router.get("/directories/:dirId(\\d+)/links", requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
    if (!d) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (user.role !== "master" && d.owner_id !== user.id) {
      res.status(403).json({ detail: "not your directory" });
      return;
    }
    const links = db.all<DirectoryLinkRow>("SELECT * FROM directory_links WHERE directory_id = $id ORDER BY created_at ASC", {
      $id: d.id,
    });
    res.json({ links: links.map((lk) => serializeDirLink(lk, req)) });
  });

  router.post("/directories/:dirId(\\d+)/links", requireSession(state), requireCsrf, requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
    if (!perm.can_regenerate_links) {
      res.status(403).json({ detail: "link creation not permitted" });
      return;
    }
    const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
    if (!d) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (user.role !== "master" && d.owner_id !== user.id) {
      res.status(403).json({ detail: "not your directory" });
      return;
    }
    const body = req.body ?? {};
    const expires = expiresAtFromSeconds(res, body.expires_in_seconds);
    if (!expires.ok) return;
    const slug = newSlug();
    db.run(
      `INSERT INTO directory_links (directory_id, slug, max_uses, expires_at, use_count, active, hide_uploader, created_at)
       VALUES ($dirId, $slug, $maxUses, $expiresAt, 0, 1, $hideUploader, $now)`,
      {
        $dirId: d.id,
        $slug: slug,
        $maxUses: body.max_uses ?? null,
        $expiresAt: expires.value,
        $hideUploader: body.hide_uploader ? 1 : 0,
        $now: nowIso(),
      },
    );
    const lk = db.get<DirectoryLinkRow>("SELECT * FROM directory_links WHERE id = last_insert_rowid()")!;
    recordAudit(db, { actor: user.username, action: "directory_link.created", target: `directory:${d.id}`, ip: clientIp(state, req) });
    res.json(serializeDirLink(lk, req));
  });

  router.patch(
    "/directories/:dirId(\\d+)/links/:linkId(\\d+)",
    requireSession(state),
    requireCsrf,
    requireActiveUser(state),
    (req, res) => {
      const user = req.currentUser!;
      const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
      if (!perm.can_regenerate_links) {
        res.status(403).json({ detail: "link creation not permitted" });
        return;
      }
      const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
      if (!d) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      if (user.role !== "master" && d.owner_id !== user.id) {
        res.status(403).json({ detail: "not your directory" });
        return;
      }
      const lk = db.get<DirectoryLinkRow>("SELECT * FROM directory_links WHERE id = $id", { $id: req.params.linkId });
      if (!lk || lk.directory_id !== d.id) {
        res.status(404).json({ detail: "link not found" });
        return;
      }
      const body = req.body ?? {};
      if (body.max_uses !== undefined && body.max_uses !== null) {
        db.run("UPDATE directory_links SET max_uses = $v WHERE id = $id", {
          $v: Number(body.max_uses) > 0 ? Number(body.max_uses) : null,
          $id: lk.id,
        });
      }
      if (body.active !== undefined && body.active !== null) {
        db.run("UPDATE directory_links SET active = $v WHERE id = $id", { $v: body.active ? 1 : 0, $id: lk.id });
      }
      if (body.hide_uploader !== undefined && body.hide_uploader !== null) {
        db.run("UPDATE directory_links SET hide_uploader = $v WHERE id = $id", { $v: body.hide_uploader ? 1 : 0, $id: lk.id });
      }
      if (body.expires_in_seconds !== undefined && body.expires_in_seconds !== null) {
        const expires = expiresAtFromSeconds(res, body.expires_in_seconds);
        if (!expires.ok) return;
        db.run("UPDATE directory_links SET expires_at = $v WHERE id = $id", { $v: expires.value, $id: lk.id });
      }
      recordAudit(db, {
        actor: user.username,
        action: "directory_link.updated",
        target: `directory_link:${lk.id}`,
        ip: clientIp(state, req),
      });
      const updated = db.get<DirectoryLinkRow>("SELECT * FROM directory_links WHERE id = $id", { $id: lk.id })!;
      res.json(serializeDirLink(updated, req));
    },
  );

  router.delete(
    "/directories/:dirId(\\d+)/links/:linkId(\\d+)",
    requireSession(state),
    requireCsrf,
    requireActiveUser(state),
    (req, res) => {
      const user = req.currentUser!;
      const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
      if (!perm.can_delete_links) {
        res.status(403).json({ detail: "link deletion not permitted" });
        return;
      }
      const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", { $id: req.params.dirId });
      if (!d) {
        res.status(404).json({ detail: "not found" });
        return;
      }
      if (user.role !== "master" && d.owner_id !== user.id) {
        res.status(403).json({ detail: "not your directory" });
        return;
      }
      const lk = db.get<DirectoryLinkRow>("SELECT * FROM directory_links WHERE id = $id", { $id: req.params.linkId });
      if (!lk || lk.directory_id !== d.id) {
        res.status(404).json({ detail: "link not found" });
        return;
      }
      db.run("DELETE FROM directory_links WHERE id = $id", { $id: lk.id });
      recordAudit(db, {
        actor: user.username,
        action: "directory_link.deleted",
        target: `directory_link:${lk.id}`,
        ip: clientIp(state, req),
      });
      res.json({ status: "deleted" });
    },
  );

  return router;
}

/** Mounted separately at /admin/directories in app.ts, mirrors adminFilesRouter
 * in files.ts / GET /admin/directories in app/routes/directories.py. */
export function adminDirectoriesRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.get("/", requireMaster(state), (req, res) => {
    const dirs = db.all<DirectoryRow>("SELECT * FROM directories ORDER BY created_at DESC");
    res.json({ directories: serializeDirectories(state, req, dirs) });
  });

  return router;
}

/** Mirrors the /d/{slug}* endpoints of app/routes/directories.py -- no auth
 * required (link slug is the credential), same shape as public.ts for files.
 * Mounted at root. */
export function publicDirectoriesRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.get("/d/:slug/info", (req, res) => {
    const resolved = resolveDirectory(db, req.params.slug);
    if (!resolved) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const { directory: d, link } = resolved;
    const pairs = publicFiles(db, d.id);

    let uploader: { username: string; has_avatar: boolean; user_id: number } | null = null;
    if (!link.hide_uploader) {
      const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: d.owner_id });
      if (owner) uploader = { username: owner.username, has_avatar: owner.avatar_data !== null, user_id: owner.id };
    }

    let alreadySaved = false;
    const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (cookie) {
      const sessionRow = state.sessionManager.resolve(db, cookie);
      if (sessionRow) {
        const existing = db.get<DirectoryRow>(
          "SELECT * FROM directories WHERE owner_id = $uid AND saved_from_directory_id = $did",
          { $uid: sessionRow.user_id, $did: d.id },
        );
        alreadySaved = !!existing || d.owner_id === sessionRow.user_id;
      }
    }

    res.json({
      title: d.title,
      encryption_mode: d.encryption_mode,
      key_check_blob: d.key_check_blob,
      file_count: pairs.length,
      total_bytes: pairs.reduce((sum, { file }) => sum + file.size_bytes, 0),
      uploader,
      already_saved: alreadySaved,
      files: pairs.map(({ file, link: lk }) => ({
        slug: lk.slug,
        filename: file.original_filename,
        size_bytes: file.size_bytes,
        content_type: file.content_type,
      })),
    });
  });

  router.get("/d/:slug/preview-manifest", (req, res) => {
    const resolved = resolveDirectory(db, req.params.slug);
    if (!resolved) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const { directory: d } = resolved;
    const groups: Record<string, Record<string, unknown>[]> = {
      images: [],
      videos: [],
      audio: [],
      text: [],
      pdfs: [],
      archives: [],
      other: [],
    };
    for (const { file: f, link } of publicFiles(db, d.id)) {
      const row: Record<string, unknown> = {
        id: f.id,
        slug: link.slug,
        filename: f.original_filename,
        size_bytes: f.size_bytes,
        content_type: f.content_type,
        encryption_mode: f.encryption_mode,
        preview_url: `/file/${link.slug}/preview`,
        download_url: `/file/${link.slug}/raw`,
      };
      const group = previewGroup(f.content_type, f.original_filename);
      if (group === "archives") row.preview = archivePreview(f);
      groups[group]!.push(row);
    }
    res.json({
      id: d.id,
      title: d.title,
      slug: d.slug,
      encryption_mode: d.encryption_mode,
      file_count: Object.values(groups).reduce((sum, g) => sum + g.length, 0),
      groups,
    });
  });

  router.post("/d/:slug/save", requireSession(state), requireCsrf, requireActiveUser(state), (req, res) => {
    const user = req.currentUser!;
    const resolved = resolveDirectory(db, req.params.slug);
    if (!resolved) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const { directory: sourceDir } = resolved;
    if (sourceDir.owner_id === user.id) {
      res.status(409).json({ detail: "you own this directory" });
      return;
    }
    const already = db.get<DirectoryRow>(
      "SELECT * FROM directories WHERE owner_id = $uid AND saved_from_directory_id = $did",
      { $uid: user.id, $did: sourceDir.id },
    );
    if (already) {
      res.status(409).json({ detail: "already saved" });
      return;
    }
    const ek = typeof req.query.ek === "string" ? req.query.ek : null;
    if (!verifyDirAccessKey(state, sourceDir, ek)) {
      res.status(401).json({ detail: "missing or invalid access key (?ek=)" });
      return;
    }
    const pairs = publicFiles(db, sourceDir.id);
    const logicalBytes = pairs.reduce((sum, { file }) => sum + file.size_bytes, 0);
    const perm = ensurePermissions(db, user.id, { master: user.role === "master" });
    if (usedStorageBytesForUser(db, user.id) + logicalBytes > perm.quota_bytes) {
      res.status(413).json({ detail: "save would exceed your quota" });
      return;
    }
    if (!consumeDirUse(db, req.params.slug)) {
      res.status(404).json({ detail: "not found" });
      return;
    }

    const newDirSlug = newSlug();
    db.run(
      `INSERT INTO directories (
         owner_id, slug, title, encryption_mode, enc_key_blob, enc_access_blob,
         key_check_blob, total_bytes, saved_from_directory_id, created_at
       ) VALUES ($ownerId, $slug, $title, $enc, $encKey, $encAccess, $keyCheck, $totalBytes, $savedFrom, $now)`,
      {
        $ownerId: user.id,
        $slug: newDirSlug,
        $title: sourceDir.title,
        $enc: sourceDir.encryption_mode,
        $encKey: sourceDir.enc_key_blob ? Buffer.from(sourceDir.enc_key_blob) : null,
        $encAccess: sourceDir.enc_access_blob ? Buffer.from(sourceDir.enc_access_blob) : null,
        $keyCheck: sourceDir.key_check_blob,
        $totalBytes: logicalBytes,
        $savedFrom: sourceDir.id,
        $now: nowIso(),
      },
    );
    const newDir = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = last_insert_rowid()")!;
    db.run(
      "INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
      { $dirId: newDir.id, $slug: newDirSlug, $now: nowIso() },
    );

    let savedFiles = 0;
    for (const { file: source } of pairs) {
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
         ) VALUES ($ownerId, $dirId, $blobId, $path, $filename, 'saved', $savedFrom, $size, $storedSize, $ct, $enc,
           $encKey, $encAccess, $compressed, $archived, $archiveCodec, $archiveOrigStored, $archiveSaved,
           $archiveAfterIdle, $lifecycle, 1, $deleteIfIdle, $autoUnarchive, $now)`,
        {
          $ownerId: user.id,
          $dirId: newDir.id,
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
      const copied = db.get<FileRow>("SELECT * FROM files WHERE id = last_insert_rowid()")!;
      db.run("INSERT INTO links (file_id, slug, use_count, active, created_at) VALUES ($fid, $slug, 0, 1, $now)", {
        $fid: copied.id,
        $slug: newSlug(),
        $now: nowIso(),
      });
      savedFiles += 1;
    }

    recordAudit(db, {
      actor: user.username,
      action: "directory.saved",
      target: `directory:${sourceDir.id}->directory:${newDir.id}`,
      ip: clientIp(state, req),
    });
    log.info(`directory saved source_directory_id=${sourceDir.id} saved_directory_id=${newDir.id} owner_id=${user.id} saved_files=${savedFiles}`);

    res.json({
      id: newDir.id,
      slug: newDir.slug,
      url: dirUrl(req, newDir.slug),
      saved_files: savedFiles,
      source_type: "saved",
      access_key: recoverDirAccessKey(state, newDir),
    });
  });

  router.get("/d/:slug/zip", asyncHandler(async (req, res) => {
    const resolved = resolveDirectory(db, req.params.slug);
    if (!resolved) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const { directory: d } = resolved;
    if (d.encryption_mode === "client") {
      res.status(400).json({ detail: "end-to-end encrypted bundle — download from the directory page" });
      return;
    }
    const ek = typeof req.query.ek === "string" ? req.query.ek : null;
    if (!verifyDirAccessKey(state, d, ek)) {
      res.status(401).json({ detail: "missing or invalid access key (?ek=)" });
      return;
    }
    const pairs = publicFiles(db, d.id);
    if (!pairs.length) {
      res.status(404).json({ detail: "directory is empty" });
      return;
    }
    if (!consumeDirUse(db, req.params.slug)) {
      res.status(404).json({ detail: "not found" });
      return;
    }

    const zipName = (d.title || "bundle").trim().replace(/"/g, "") || "bundle";
    res.set(SECURITY_HEADERS);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}.zip"`);
    const archive = new ZipArchive({ store: true });
    archive.on("error", (err: Error) => {
      if (!res.headersSent) res.status(500).json({ detail: "zip failed" });
      else res.destroy();
      log.error(`directory zip failed directory_id=${d.id}: ${err.message}`);
    });
    archive.pipe(res);

    const masterKey = getMasterKey(state.settings);
    const seen = new Set<string>();
    const cleanup: string[] = [];
    try {
      for (const { file: f } of pairs) {
        const name = safeArcname(f.original_filename, seen);
        const [src, isTemp] = await memberSource(masterKey, f);
        if (isTemp) cleanup.push(src);
        archive.file(src, { name });
      }
      recordAudit(db, { actor: "anonymous", action: "directory.downloaded", target: `directory:${d.id}`, ip: clientIp(state, req) });
      await archive.finalize();
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof HttpError) res.status(err.status).json({ detail: err.detail });
        else res.status(500).json({ detail: "zip failed" });
      } else {
        res.destroy();
      }
      log.error(`directory zip failed directory_id=${d.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const p of cleanup) {
        try {
          unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    }
  }));

  router.get("/d/:slug", (req, res) => {
    const resolved = resolveDirectory(db, req.params.slug);
    const meta = resolved ? directoryPageMeta(req, db, resolved.directory) : "";
    const content = renderSpa(meta);
    res.set({ ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    res.send(content);
  });

  return router;
}
