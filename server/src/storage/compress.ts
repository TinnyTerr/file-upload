import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/** Mirrors app/storage/compress.py: zstd level 3, skip already-compressed
 * MIME types, zip-bomb guards on decompression. */

const NO_COMPRESS = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "audio/mpeg", "audio/ogg", "audio/aac", "audio/flac",
  "application/zip", "application/gzip", "application/x-bzip2",
  "application/x-xz", "application/zstd", "application/x-7z-compressed",
  "application/x-rar-compressed", "application/vnd.rar",
  "font/woff", "font/woff2",
]);

const LEVEL = 3;
const BOMB_RATIO = 50;
const BOMB_MAX = 10 * 1024 * 1024 * 1024; // 10 GiB
const READ_SIZE = 256 * 1024;

export function shouldCompress(contentType: string): boolean {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return !NO_COMPRESS.has(base);
}

export async function compressFile(src: string, dst: string): Promise<number> {
  await pipeline(
    createReadStream(src, { highWaterMark: READ_SIZE }),
    zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: LEVEL } }),
    createWriteStream(dst),
  );
  return (await stat(dst)).size;
}

export async function* decompressStream(path: string, originalSize: number): AsyncGenerator<Buffer> {
  let produced = 0;
  // When originalSize is unknown (0), the per-file ratio check can't apply —
  // fall back to a conservative absolute budget (~13 MiB) instead of only the
  // 10 GiB cap, so a tiny file can't expand massively before being caught.
  const fallbackBudget = READ_SIZE * BOMB_RATIO;
  const stream = createReadStream(path, { highWaterMark: READ_SIZE }).pipe(zlib.createZstdDecompress());
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    produced += chunk.length;
    if (originalSize > 0) {
      if (produced > originalSize * BOMB_RATIO) throw new Error("decompression bomb detected");
    } else if (produced > fallbackBudget) {
      throw new Error("decompression bomb detected");
    }
    if (produced > BOMB_MAX) throw new Error("decompression exceeded size cap");
    yield chunk;
  }
}
