import { Router, type Request, type Response } from "express";
import { createReadStream, existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { AppState } from "../appState.ts";
import { clientIp } from "../middleware/auth.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { getMasterKey } from "../config.ts";
import { recordAudit } from "../audit.ts";
import { getLogger } from "../logging.ts";
import { resolveActiveLink, consumeUse } from "../links.ts";
import { fileHashes } from "../storage/blobs.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";
import { decompressStream } from "../storage/compress.ts";
import { decryptStream } from "../crypto/aead.ts";
import { openBox } from "../crypto/secretbox.ts";
import { renderSpa } from "../spa.ts";
import { nowIso, type FileRow, type UserRow } from "../db/rows.ts";
import { fetchBlobFromPeers } from "../cluster/blobs.ts";
import { touchBlobAccess } from "../cluster/cacheEviction.ts";
import { getOrCreateThumbnail } from "../storage/thumbnail.ts";

const log = getLogger("app.public");
const CHUNK = 256 * 1024;

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

/** Read-time cluster failover: if this file is a deduped, content-addressed
 * blob (blob_id set) and the local bytes are missing, try pulling them from
 * any active peer that still has them (see server/src/cluster/blobs.ts).
 * Best-effort and silent on failure -- the caller re-checks existsSync and
 * falls back to its usual "file missing from storage" 500. */
async function ensureBlobAvailable(state: AppState, f: FileRow, fullPath: string): Promise<void> {
  if (!f.blob_id) return;
  const blob = state.db.get<{ stored_sha256: string; transform_key: string }>(
    "SELECT stored_sha256, transform_key FROM content_blobs WHERE id = $id",
    { $id: f.blob_id },
  );
  if (!blob) return;
  try {
    await fetchBlobFromPeers(state, { storedSha256: blob.stored_sha256, transformKey: blob.transform_key, dest: fullPath, blobId: f.blob_id ?? undefined });
  } catch {
    // best-effort -- caller falls back to a 500 if this didn't help
  }
}

function contentDisposition(filename: string): string {
  const cleaned = [...filename].filter((c) => c.codePointAt(0)! >= 0x20).join("");
  const asciiFallback = cleaned
    .replace(/[^\x00-\x7F]/g, "?")
    .replace(/"/g, "_")
    .replace(/\\/g, "_");
  const encoded = encodeURIComponent(cleaned);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function verifyAccessKey(state: AppState, f: FileRow, ek: string | null): boolean {
  if (!f.enc_access_blob) return true; // legacy server-encrypted file — no credential required
  if (!ek) return false;
  try {
    const expected = openBox(getMasterKey(state.settings), Buffer.from(f.enc_access_blob)).toString("utf-8");
    const a = Buffer.from(ek);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseRange(header: string, fileSize: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  let start: number;
  let end: number;
  if (s) {
    start = Number(s);
    end = e ? Number(e) : fileSize - 1;
    if (end >= fileSize) end = fileSize - 1;
  } else if (e) {
    const suffix = Number(e);
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    return null;
  }
  if (start > end || start >= fileSize) return null;
  return [start, end];
}

function streamRange(res: Response, path: string, start: number, end: number): void {
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fileMetaTags(req: Request, state: AppState, slug: string): string {
  const link = resolveActiveLink(state.db, slug);
  if (!link) return "";
  const f = state.db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
  if (!f) return "";
  const title = escapeHtml(f.original_filename || "Shared file");
  const desc = escapeHtml(`${f.size_bytes} bytes`);
  const url = escapeHtml(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
  const tags = [
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:url" content="${url}">`,
    '<meta property="og:type" content="website">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${desc}">`,
  ];
  const eligible = link.max_uses === null && f.encryption_mode === "none" && !f.compressed && !f.archived;
  const previewUrl = escapeHtml(`${req.protocol}://${req.get("host")}/file/${slug}/preview`);
  if (eligible && f.content_type.startsWith("image/")) {
    tags.push(`<meta property="og:image" content="${previewUrl}">`);
    tags.push('<meta name="twitter:card" content="summary_large_image">');
  } else if (eligible && f.content_type.startsWith("video/")) {
    tags.push(`<meta property="og:video" content="${previewUrl}">`);
    tags.push(`<meta property="og:video:type" content="${escapeHtml(f.content_type)}">`);
  } else if (eligible && f.content_type.startsWith("audio/")) {
    tags.push(`<meta property="og:audio" content="${previewUrl}">`);
    tags.push(`<meta property="og:audio:type" content="${escapeHtml(f.content_type)}">`);
  }
  return tags.join("\n");
}

/** Mirrors app/routes/public.py -- no auth required (link slug is the credential). */
export function publicRouter(state: AppState): Router {
  const router = Router();
  const { db } = state;

  router.get("/file/:slug/info", (req, res) => {
    const link = resolveActiveLink(db, req.params.slug);
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!f) {
      res.status(404).json({ detail: "not found" });
      return;
    }

    let uploader: { username: string; has_avatar: boolean; user_id: number } | null = null;
    if (!link.hide_uploader) {
      const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", { $id: f.owner_id });
      if (owner) {
        uploader = { username: owner.username, has_avatar: owner.avatar_data !== null, user_id: owner.id };
      }
    }

    let alreadySaved = false;
    const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (cookie) {
      const sessionRow = state.sessionManager.resolve(db, cookie);
      if (sessionRow) {
        const existing = db.get<FileRow>("SELECT * FROM files WHERE owner_id = $uid AND saved_from_file_id = $fid", {
          $uid: sessionRow.user_id,
          $fid: f.id,
        });
        alreadySaved = !!existing || f.owner_id === sessionRow.user_id;
      }
    }

    res.json({
      filename: f.original_filename,
      size_bytes: f.size_bytes,
      content_type: f.content_type,
      encryption_mode: f.encryption_mode,
      compressed: !!f.compressed,
      archived: !!f.archived,
      lifecycle_state: f.lifecycle_state,
      max_uses: link.max_uses,
      use_count: link.use_count,
      expires_at: link.expires_at,
      hashes: fileHashes(db, f),
      uploader,
      already_saved: alreadySaved,
    });
  });

  router.get("/file/:slug/raw", async (req, res) => {
    const link = resolveActiveLink(db, req.params.slug);
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!f) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const ek = typeof req.query.ek === "string" ? req.query.ek : null;
    if (f.encryption_mode === "server" && !verifyAccessKey(state, f, ek)) {
      res.status(401).json({ detail: "missing or invalid access key (?ek=)" });
      return;
    }
    if (!consumeUse(db, req.params.slug)) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    db.run("UPDATE files SET last_downloaded_at = $now WHERE id = $id", { $now: nowIso(), $id: f.id });
    recordAudit(db, { actor: "anonymous", action: "file.downloaded", target: `file:${f.id}`, ip: clientIp(state, req) });

    let fullPath: string;
    try {
      fullPath = safeJoin(storageRoot(), f.storage_path);
    } catch {
      res.status(500).json({ detail: "invalid storage path" });
      return;
    }
    if (!existsSync(fullPath)) {
      // Cluster read-time failover: this node's copy is missing (e.g. a
      // cache-mode node that never held it, or local disk loss) -- try
      // pulling it from any active peer before giving up. No-op / cheap
      // when unclustered (fetchBlobFromPeers iterates zero rows).
      await ensureBlobAvailable(state, f, fullPath);
    }
    if (!existsSync(fullPath)) {
      res.status(500).json({ detail: "file missing from storage" });
      return;
    }
    touchBlobAccess(db, f.blob_id);

    const needsDecrypt = f.encryption_mode === "server";
    const needsDecompress = !!(f.compressed || f.archived);

    const baseHeaders: Record<string, string> = {
      ...SECURITY_HEADERS,
      "Content-Disposition": contentDisposition(f.original_filename),
      ...(!needsDecrypt && !needsDecompress ? { "Accept-Ranges": "bytes" } : {}),
    };

    if (needsDecrypt) {
      if (!f.enc_key_blob) {
        res.status(500).json({ detail: "encryption key not stored" });
        return;
      }
      let perFileKey: Buffer;
      try {
        perFileKey = openBox(getMasterKey(state.settings), Buffer.from(f.enc_key_blob));
      } catch {
        res.status(500).json({ detail: "failed to recover encryption key" });
        return;
      }

      if (needsDecompress) {
        if (f.archived && !f.auto_unarchive_on_download) {
          res.status(503).json({ detail: "file is archived; contact admin to unarchive" });
          return;
        }
        res.writeHead(200, { ...baseHeaders, "Content-Type": f.content_type || "application/octet-stream" });
        // Compression order mirrors the two possible producers: upload-time
        // compression wraps ENC(ZSTD(x)); the archive job produces ZSTD(ENC(x)).
        const source =
          f.archived && !f.compressed
            ? decryptFromDecompressed(fullPath, f.size_bytes, perFileKey)
            : decompressFromDecrypted(fullPath, f.size_bytes, perFileKey);
        try {
          for await (const chunk of source) {
            if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
          }
          res.end();
        } catch (err) {
          log.error(`raw download decrypt/decompress failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`);
          res.destroy();
        }
        return;
      }

      res.writeHead(200, { ...baseHeaders, "Content-Type": f.content_type || "application/octet-stream" });
      try {
        for await (const chunk of decryptStream(perFileKey, fullPath)) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
        }
        res.end();
      } catch (err) {
        log.error(`raw download decrypt failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`);
        res.destroy();
      }
      return;
    }

    if (needsDecompress) {
      if (f.archived && !f.auto_unarchive_on_download) {
        res.status(503).json({ detail: "file is archived; contact admin to unarchive" });
        return;
      }
      res.writeHead(200, { ...baseHeaders, "Content-Type": f.content_type, "Content-Length": String(f.size_bytes) });
      try {
        for await (const chunk of decompressStream(fullPath, f.size_bytes)) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
        }
        res.end();
      } catch (err) {
        log.error(`raw download decompress failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`);
        res.destroy();
      }
      return;
    }

    const fileSize = f.stored_size_bytes;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, fileSize);
      if (!parsed) {
        res.status(416).set({ ...SECURITY_HEADERS, "Accept-Ranges": "bytes", "Content-Range": `bytes */${fileSize}` }).end();
        return;
      }
      const [start, end] = parsed;
      res.writeHead(206, {
        ...baseHeaders,
        "Content-Type": f.content_type,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": String(end - start + 1),
      });
      streamRange(res, fullPath, start, end);
      return;
    }

    res.writeHead(200, { ...baseHeaders, "Content-Type": f.content_type, "Content-Length": String(fileSize) });
    createReadStream(fullPath, { highWaterMark: CHUNK }).pipe(res);
  });

  router.get("/file/:slug/preview", async (req, res) => {
    const link = resolveActiveLink(db, req.params.slug);
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    if (link.max_uses !== null) {
      res.status(403).json({ detail: "limited-use links do not expose previews" });
      return;
    }
    const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!f) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const ct = f.content_type || "";
    if (
      !(
        ct.startsWith("image/") ||
        ct.startsWith("video/") ||
        ct.startsWith("audio/") ||
        ct === "application/pdf" ||
        ct.startsWith("text/")
      )
    ) {
      res.status(403).json({ detail: "preview unavailable" });
      return;
    }
    if (f.encryption_mode !== "none" || f.compressed || f.archived) {
      res.status(403).json({ detail: "preview unavailable" });
      return;
    }
    let fullPath: string;
    try {
      fullPath = safeJoin(storageRoot(), f.storage_path);
    } catch {
      res.status(500).json({ detail: "invalid storage path" });
      return;
    }
    if (!existsSync(fullPath)) {
      await ensureBlobAvailable(state, f, fullPath);
    }
    if (!existsSync(fullPath)) {
      res.status(500).json({ detail: "file missing from storage" });
      return;
    }
    touchBlobAccess(db, f.blob_id);
    const fileSize = statSync(fullPath).size;
    const headers: Record<string, string> = { ...SECURITY_HEADERS, "Accept-Ranges": "bytes" };
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, fileSize);
      if (!parsed) {
        res.status(416).set({ ...SECURITY_HEADERS, "Accept-Ranges": "bytes", "Content-Range": `bytes */${fileSize}` }).end();
        return;
      }
      const [start, end] = parsed;
      res.writeHead(206, {
        ...headers,
        "Content-Type": f.content_type,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": String(end - start + 1),
      });
      streamRange(res, fullPath, start, end);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Type": f.content_type, "Content-Length": String(fileSize) });
    createReadStream(fullPath, { highWaterMark: CHUNK }).pipe(res);
  });

  /** Small, size-capped JPEG for og:image -- unlike /preview this never streams the
   * raw original, so link-preview crawlers (which cap fetch size, e.g. ~8MB on
   * Discord) can always render it regardless of how large the source file is. */
  router.get("/file/:slug/thumbnail", async (req, res) => {
    const link = resolveActiveLink(db, req.params.slug);
    if (!link) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", { $id: link.file_id });
    if (!f) {
      res.status(404).json({ detail: "not found" });
      return;
    }
    const ct = f.content_type || "";
    if ((!ct.startsWith("image/") && !ct.startsWith("video/")) || f.encryption_mode !== "none" || f.compressed || f.archived) {
      res.status(403).json({ detail: "thumbnail unavailable" });
      return;
    }
    let fullPath: string;
    try {
      fullPath = safeJoin(storageRoot(), f.storage_path);
    } catch {
      res.status(500).json({ detail: "invalid storage path" });
      return;
    }
    if (!existsSync(fullPath)) {
      res.status(500).json({ detail: "file missing from storage" });
      return;
    }
    const thumbPath = await getOrCreateThumbnail(f.id, fullPath, ct);
    if (!thumbPath) {
      res.status(403).json({ detail: "thumbnail unavailable" });
      return;
    }
    const size = statSync(thumbPath).size;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "image/jpeg",
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=86400",
    });
    createReadStream(thumbPath, { highWaterMark: CHUNK }).pipe(res);
  });

  router.get("/file/:slug", (req, res) => {
    const content = renderSpa(fileMetaTags(req, state, req.params.slug));
    res.set({ ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    res.send(content);
  });

  return router;
}

async function* decompressFromDecrypted(path: string, originalSize: number, key: Buffer): AsyncGenerator<Buffer> {
  // upload-time compression: stored as ENC(ZSTD(x)) -> decrypt, then decompress.
  // decryptStream reads from disk directly; we can't decompress a live async
  // generator with node:zlib's stream API, so buffer through a temp file.
  const { mkdtemp, writeFile, unlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fu-raw-"));
  const tmp1 = join(dir, "step1");
  try {
    const chunks: Buffer[] = [];
    for await (const c of decryptStream(key, path)) chunks.push(c);
    await writeFile(tmp1, Buffer.concat(chunks));
    for await (const c of decompressStream(tmp1, originalSize)) yield c;
  } finally {
    await unlink(tmp1).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function* decryptFromDecompressed(path: string, originalSize: number, key: Buffer): AsyncGenerator<Buffer> {
  // archive job: stored as ZSTD(ENC(x)) -> decompress, then decrypt.
  const { mkdtemp, writeFile, unlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "fu-raw-"));
  const tmp1 = join(dir, "step1");
  try {
    const chunks: Buffer[] = [];
    for await (const c of decompressStream(path, originalSize)) chunks.push(c);
    await writeFile(tmp1, Buffer.concat(chunks));
    for await (const c of decryptStream(key, tmp1)) yield c;
  } finally {
    await unlink(tmp1).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
