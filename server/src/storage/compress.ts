import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/** Mirrors app/storage/compress.py: zstd level 3, skip already-compressed
 * MIME types, zip-bomb guards on decompression. */

const NO_COMPRESS = new Set([
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"video/mp4",
	"video/webm",
	"video/ogg",
	"video/quicktime",
	"audio/mpeg",
	"audio/ogg",
	"audio/aac",
	"audio/flac",
	"application/zip",
	"application/gzip",
	"application/x-bzip2",
	"application/x-xz",
	"application/zstd",
	"application/x-7z-compressed",
	"application/x-rar-compressed",
	"application/vnd.rar",
	"font/woff",
	"font/woff2",
]);

const LEVEL = 3;
const BOMB_RATIO = 50;
const BOMB_MAX = 10 * 1024 * 1024 * 1024; // 10 GiB
const READ_SIZE = 256 * 1024;

/** How much of a file is sampled to decide whether compressing it is futile. */
const PROBE_BYTES = 256 * 1024;

/** The share of the input compression has to remove to be worth keeping.
 *
 * Storing a barely-smaller copy is not free: a compressed blob can never be
 * served with `Accept-Ranges` (storage/streaming.ts::isDirectlyStreamable), so
 * every future read pays a full decompress from byte zero and loses seeking.
 * 5% is the point where that trade stops paying for itself. */
const MIN_SAVING = 0.05;

export function shouldCompress(contentType: string): boolean {
	const base = contentType.split(";")[0]!.trim().toLowerCase();
	return !NO_COMPRESS.has(base);
}

export async function compressFile(src: string, dst: string): Promise<number> {
	await pipeline(
		createReadStream(src, { highWaterMark: READ_SIZE }),
		zlib.createZstdCompress({
			params: { [zlib.constants.ZSTD_c_compressionLevel]: LEVEL },
		}),
		createWriteStream(dst),
	);
	return (await stat(dst)).size;
}

/** Compresses the head of `src` to see whether the whole file is worth a pass.
 *
 * `shouldCompress` only knows MIME types, and the ones that lie are common:
 * `application/octet-stream`, an office document (a zip by another name), a
 * pre-compressed `.tar.gz` uploaded as a tarball. Sampling costs one 256 KiB
 * read and a few milliseconds against a full read+write of the whole file.
 *
 * Deliberately one-sided: a promising sample still has to survive the real
 * size check afterwards, so the only thing a wrong guess here can cost is a
 * missed compression on a file whose first 256 KiB is unrepresentative. */
async function probeWorthCompressing(src: string): Promise<boolean> {
	const fh = await open(src, "r");
	try {
		const buf = Buffer.alloc(PROBE_BYTES);
		const { bytesRead } = await fh.read(buf, 0, PROBE_BYTES, 0);
		// Too small to judge; let the full pass and its size check decide.
		if (bytesRead < 4096) return true;
		const sample = buf.subarray(0, bytesRead);
		const packed = zlib.zstdCompressSync(sample, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: LEVEL },
		});
		return packed.length < bytesRead * (1 - MIN_SAVING);
	} finally {
		await fh.close();
	}
}

/**
 * Compress `src` to `dst`, keeping the result only if it is actually smaller.
 *
 * Returns the compressed size, or `null` when compression wasn't worth it --
 * in which case `dst` has been removed and the caller should go on storing the
 * original bytes untouched.
 *
 * This check used to be missing entirely, and the failure was silent both
 * ways: incompressible input runs *through* zstd at about 1.00006x, so the
 * file was stored fractionally larger than it arrived **and** permanently lost
 * `Accept-Ranges`, because `compressed = 1` forces every read to reproduce it
 * from byte zero. Paying more disk for a slower read is the wrong end of both
 * goals.
 */
export async function compressIfWorthwhile(
	src: string,
	dst: string,
	originalSize: number,
): Promise<number | null> {
	if (!(await probeWorthCompressing(src))) return null;
	const size = await compressFile(src, dst);
	if (size < originalSize * (1 - MIN_SAVING)) return size;
	await unlink(dst).catch(() => {
		// best-effort; a leftover .work file is swept with the rest
	});
	return null;
}

/** Decompress a zstd byte stream, refusing an implausible expansion ratio.
 *
 * Takes a source rather than a path so `ENC(ZSTD(x))` can be read as one
 * composed pipeline -- the decrypt feeds straight in. Staging the intermediate
 * to a temp file first meant a whole extra copy of the file written and read
 * per download, and no byte could go out until the last one had landed. */
export async function* decompressGuarded(
	source: AsyncIterable<Buffer>,
	originalSize: number,
): AsyncGenerator<Buffer> {
	let produced = 0;
	// When originalSize is unknown (0), the per-file ratio check can't apply —
	// fall back to a conservative absolute budget (~13 MiB) instead of only the
	// 10 GiB cap, so a tiny file can't expand massively before being caught.
	const fallbackBudget = READ_SIZE * BOMB_RATIO;
	const input = Readable.from(source);
	const out = zlib.createZstdDecompress();
	// `.pipe()` does not forward errors, so a source that fails mid-stream
	// would otherwise leave the consumer waiting on a decompressor nothing is
	// going to end. Destroying each side with the other's fate makes the
	// failure surface at the `for await` below, and closes the source when a
	// consumer abandons the download.
	input.on("error", (err) => out.destroy(err));
	out.on("close", () => input.destroy());
	input.pipe(out);
	for await (const chunk of out as AsyncIterable<Buffer>) {
		produced += chunk.length;
		if (originalSize > 0) {
			if (produced > originalSize * BOMB_RATIO)
				throw new Error("decompression bomb detected");
		} else if (produced > fallbackBudget) {
			throw new Error("decompression bomb detected");
		}
		if (produced > BOMB_MAX) throw new Error("decompression exceeded size cap");
		yield chunk;
	}
}

export function decompressStream(
	path: string,
	originalSize: number,
): AsyncGenerator<Buffer> {
	return decompressGuarded(
		createReadStream(path, { highWaterMark: READ_SIZE }),
		originalSize,
	);
}
