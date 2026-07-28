import { createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HttpError } from "../httpError.ts";
import type { FileRow } from "../db/rows.ts";
import { decompressStream } from "./compress.ts";
import { decryptStream } from "../crypto/aead.ts";
import { openBox } from "../crypto/secretbox.ts";
import { safeJoin, storageRoot } from "./paths.ts";

/** Mirrors app/routes/directories.py::_safe_arcname -- flatten to a safe
 * in-zip name and de-duplicate collisions against everything already emitted. */
export function safeArcname(name: string, seen: Set<string>): string {
  let base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  base = base
    .split("")
    .filter((c) => c.codePointAt(0)! >= 0x20)
    .join("")
    .trim();
  if (!base) base = "file";
  const dotIdx = base.indexOf(".");
  let stem = dotIdx === -1 ? base : base.slice(0, dotIdx);
  let dot = dotIdx === -1 ? "" : ".";
  let ext = dotIdx === -1 ? "" : base.slice(dotIdx + 1);
  if (!stem) {
    stem = base;
    dot = "";
    ext = "";
  }
  let candidate = base;
  let counter = 1;
  while (seen.has(candidate)) {
    candidate = dot ? `${stem} (${counter}).${ext}` : `${stem} (${counter})`;
    counter += 1;
  }
  seen.add(candidate);
  return candidate;
}

function newTempfile(suffix: string): string {
  return join(tmpdir(), `fu-${randomBytes(16).toString("hex")}${suffix}`);
}

/** Streams an async chunk generator into a file, honoring backpressure.
 * Exported for reuse by routes/public.ts's raw-download decompress/decrypt
 * helpers, which used to buffer the whole file in memory before this. */
export async function writeStreamToFile(stream: AsyncGenerator<Buffer>, dest: string): Promise<void> {
  const out = createWriteStream(dest);
  try {
    for await (const chunk of stream) {
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    throw err;
  }
}

/** Mirrors app/routes/directories.py::_member_source. Resolves a file row to a
 * path holding its plaintext bytes. Returns [path, isTemp] -- caller must
 * unlink when isTemp is true.
 *
 * Two different producers wrap a file's bytes in opposite transform orders:
 *  - finalizeStoredFile (upload-time, routes/files.ts) compresses THEN
 *    encrypts -> ENC(ZSTD(x)), and sets `compressed = 1`.
 *  - the archive job (jobs/lifecycle.ts) only ever recompresses a file that
 *    was NOT already compressed at upload time -- it wraps an already
 *    *encrypted* file -> ZSTD(ENC(x)), leaving `compressed = 0` (see
 *    archiveFileCore's early-out when `f.compressed` is already true).
 * So `archived && !compressed` is the only layout stored as ZSTD(ENC(x))
 * (decompress-then-decrypt); every other compressed+encrypted combination is
 * ENC(ZSTD(x)) (decrypt-then-decompress). Mirrors routes/public.ts's raw
 * handler (`f.archived && !f.compressed` branch). */
export async function memberSource(
  masterKey: Buffer,
  f: FileRow,
): Promise<[path: string, isTemp: boolean]> {
  const full = safeJoin(storageRoot(), f.storage_path);
  if (!existsSync(full)) throw new HttpError(500, "file missing from storage");

  const needsDecompress = !!(f.compressed || f.archived);
  const needsDecrypt = f.encryption_mode === "server";
  if (!needsDecompress && !needsDecrypt) return [full, false];

  const decompressFirst = !!(f.archived && !f.compressed);

  let src = full;
  let intermediate: string | null = null;
  try {
    if (decompressFirst) {
      // ZSTD(ENC(x)) -- decompress, then decrypt.
      if (needsDecompress) {
        const dec = newTempfile(".dec");
        intermediate = dec;
        await writeStreamToFile(decompressStream(src, f.size_bytes), dec);
        src = dec;
      }
      if (needsDecrypt) {
        if (!f.enc_key_blob) throw new HttpError(500, "encryption key not stored");
        const key = openBox(masterKey, Buffer.from(f.enc_key_blob));
        const plain = newTempfile(".plain");
        try {
          await writeStreamToFile(decryptStream(key, src), plain);
        } catch (err) {
          await unlink(plain).catch(() => {});
          throw err;
        }
        if (intermediate) await unlink(intermediate).catch(() => {});
        return [plain, true];
      }
      return [src, true];
    }

    // ENC(ZSTD(x)) -- decrypt, then decompress.
    if (needsDecrypt) {
      if (!f.enc_key_blob) throw new HttpError(500, "encryption key not stored");
      const key = openBox(masterKey, Buffer.from(f.enc_key_blob));
      const dec = newTempfile(".dec");
      intermediate = dec;
      await writeStreamToFile(decryptStream(key, src), dec);
      src = dec;
    }
    if (needsDecompress) {
      const plain = newTempfile(".plain");
      try {
        await writeStreamToFile(decompressStream(src, f.size_bytes), plain);
      } catch (err) {
        await unlink(plain).catch(() => {});
        throw err;
      }
      if (intermediate) await unlink(intermediate).catch(() => {});
      return [plain, true];
    }

    return [src, true];
  } catch (err) {
    if (intermediate) await unlink(intermediate).catch(() => {});
    throw err;
  }
}
