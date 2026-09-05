/**
 * The stored-bytes pipeline: the AEAD container, zstd, and the two composed
 * orders a read path has to undo (`ENC(ZSTD(x))` from upload, `ZSTD(ENC(x))`
 * from the archive job).
 *
 * This is the code where a bug is silent and permanent -- it doesn't fail a
 * request, it hands back the wrong bytes for a file already on disk -- so the
 * round trips here run over sizes chosen to straddle the container's 2 MiB
 * chunk stride, including the exact boundaries where an off-by-one lives.
 */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decryptStream,
	decryptStreamFrom,
	encryptFile,
} from "../src/crypto/aead.ts";
import {
	compressFile,
	compressIfWorthwhile,
	decompressGuarded,
	decompressStream,
	shouldCompress,
} from "../src/storage/compress.ts";
import {
	decompressFromDecrypted,
	decryptFromDecompressed,
} from "../src/storage/streaming.ts";

const CHUNK = 2 * 1024 * 1024;

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "fu-transform-"));
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of source) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts);
}

/** Text-shaped bytes, so zstd actually has something to remove. */
function compressible(size: number): Buffer {
	const unit = Buffer.from("the quick brown fox jumps over the lazy dog\n");
	return Buffer.alloc(size).map((_, i) => unit[i % unit.length]!);
}

describe("aead container round trip", () => {
	// 0 is the empty-file case encryptFile special-cases into one empty chunk;
	// CHUNK and 2 * CHUNK are the boundaries where "is this the last chunk?"
	// and the short-final-read both have to be exactly right.
	const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 2 * CHUNK + 7];

	for (const size of sizes) {
		test(`decrypts ${size} bytes back to the original`, async () => {
			const dir = tmpDir();
			const src = join(dir, "plain");
			const enc = join(dir, "enc");
			const key = randomBytes(32);
			const data = randomBytes(size);
			writeFileSync(src, data);

			await encryptFile(key, src, enc);
			expect(readFileSync(enc).subarray(0, 4).toString()).toBe("FUPL");
			expect(await collect(decryptStream(key, enc))).toEqual(data);
		});
	}

	test("reads a container arriving as a byte stream, not a file", async () => {
		// The stream form is what removes the temp file from the archive read
		// path, so it has to agree with the file form byte for byte -- including
		// when the source hands out chunks that straddle the container's stride.
		const dir = tmpDir();
		const src = join(dir, "plain");
		const enc = join(dir, "enc");
		const key = randomBytes(32);
		const data = randomBytes(CHUNK + 4096);
		writeFileSync(src, data);
		await encryptFile(key, src, enc);

		const bytes = readFileSync(enc);
		async function* awkwardChunks(): AsyncGenerator<Buffer> {
			// Deliberately unaligned and uneven: 7 bytes, then 100 KiB at a time.
			yield bytes.subarray(0, 7);
			for (let at = 7; at < bytes.length; at += 102_400) {
				yield bytes.subarray(at, Math.min(at + 102_400, bytes.length));
			}
		}
		expect(await collect(decryptStreamFrom(key, awkwardChunks()))).toEqual(
			data,
		);
	});

	test("refuses a wrong key", async () => {
		const dir = tmpDir();
		const src = join(dir, "plain");
		const enc = join(dir, "enc");
		writeFileSync(src, randomBytes(4096));
		await encryptFile(randomBytes(32), src, enc);
		expect(collect(decryptStream(randomBytes(32), enc))).rejects.toThrow();
	});

	test("refuses a container cut short of its declared chunk count", async () => {
		// Two chunks declared, one and a bit present: the reader must notice the
		// short read rather than authenticating whatever it managed to get.
		const dir = tmpDir();
		const src = join(dir, "plain");
		const enc = join(dir, "enc");
		const key = randomBytes(32);
		writeFileSync(src, randomBytes(CHUNK + 4096));
		await encryptFile(key, src, enc);

		const cut = join(dir, "cut");
		writeFileSync(cut, readFileSync(enc).subarray(0, CHUNK));
		expect(collect(decryptStream(key, cut))).rejects.toThrow(/truncated/);
	});

	test("refuses a container truncated mid-chunk", async () => {
		// A single-chunk file cut in half is caught by GCM instead of by the
		// length check -- either way it must not yield a partial plaintext.
		const dir = tmpDir();
		const src = join(dir, "plain");
		const enc = join(dir, "enc");
		const key = randomBytes(32);
		writeFileSync(src, randomBytes(4096));
		await encryptFile(key, src, enc);

		const cut = join(dir, "cut");
		writeFileSync(cut, readFileSync(enc).subarray(0, 2048));
		expect(collect(decryptStream(key, cut))).rejects.toThrow();
	});

	test("refuses bytes appended past the declared chunk count", async () => {
		// A padded container must not decrypt to its valid prefix. When the final
		// chunk is short the padding lands inside it and GCM rejects it; when the
		// final chunk is exactly full the padding sits beyond every declared
		// chunk, and only the explicit end-of-stream check catches it.
		const dir = tmpDir();
		const src = join(dir, "plain");
		const enc = join(dir, "enc");
		const key = randomBytes(32);
		writeFileSync(src, randomBytes(2 * CHUNK));
		await encryptFile(key, src, enc);

		const padded = join(dir, "padded");
		writeFileSync(padded, Buffer.concat([readFileSync(enc), randomBytes(64)]));
		expect(collect(decryptStream(key, padded))).rejects.toThrow(/trailing/);
	});

	test("refuses a file that isn't a container at all", async () => {
		const dir = tmpDir();
		const bogus = join(dir, "bogus");
		writeFileSync(bogus, randomBytes(4096));
		expect(collect(decryptStream(randomBytes(32), bogus))).rejects.toThrow(
			/not a FUPL file/,
		);
	});
});

describe("compressIfWorthwhile", () => {
	test("keeps a compressed copy that actually saved space", async () => {
		const dir = tmpDir();
		const src = join(dir, "plain");
		const dst = join(dir, "packed");
		const data = compressible(512 * 1024);
		writeFileSync(src, data);

		const size = await compressIfWorthwhile(src, dst, data.length);
		expect(size).not.toBeNull();
		expect(size!).toBeLessThan(data.length);
		expect(existsSync(dst)).toBe(true);
		expect(await collect(decompressStream(dst, data.length))).toEqual(data);
	});

	test("declines incompressible bytes and leaves nothing behind", async () => {
		// The bug this guards: zstd runs random data through at ~1.00006x, so the
		// file was stored *larger* than it arrived and permanently lost
		// Accept-Ranges, because `compressed = 1` forces a read from byte zero.
		const dir = tmpDir();
		const src = join(dir, "plain");
		const dst = join(dir, "packed");
		const data = randomBytes(512 * 1024);
		writeFileSync(src, data);

		expect(await compressIfWorthwhile(src, dst, data.length)).toBeNull();
		expect(existsSync(dst)).toBe(false);
		// The source is untouched -- the caller goes on storing these bytes.
		expect(readFileSync(src)).toEqual(data);
	});

	test("declines a barely-compressible file rather than taking the trade", async () => {
		// Under the 5% threshold the saving doesn't pay for losing ranged reads.
		const dir = tmpDir();
		const src = join(dir, "plain");
		const dst = join(dir, "packed");
		// ~2% redundancy: mostly random, with a small repeated tail.
		const data = Buffer.concat([
			randomBytes(500 * 1024),
			Buffer.alloc(12 * 1024, 0x41),
		]);
		writeFileSync(src, data);

		expect(await compressIfWorthwhile(src, dst, data.length)).toBeNull();
		expect(existsSync(dst)).toBe(false);
	});

	test("declines ciphertext, which is what archiving an encrypted file is", async () => {
		// AES-GCM output is pseudorandom, so zstd has never been able to shrink
		// it. The idle-archive job compressed it anyway: a full read and write of
		// every idle server-encrypted file, to store it fractionally *larger* and
		// non-streamable, reporting `archive_saved_bytes = 0`. Declining is the
		// whole saving.
		const dir = tmpDir();
		const plain = join(dir, "plain");
		const enc = join(dir, "enc");
		const dst = join(dir, "packed");
		writeFileSync(plain, compressible(512 * 1024));
		await encryptFile(randomBytes(32), plain, enc);

		const encSize = readFileSync(enc).length;
		expect(await compressIfWorthwhile(enc, dst, encSize)).toBeNull();
		expect(existsSync(dst)).toBe(false);
	});

	test("still judges a file whose type was never a compression candidate", () => {
		expect(shouldCompress("image/jpeg")).toBe(false);
		expect(shouldCompress("text/plain; charset=utf-8")).toBe(true);
		// The type that lies most often, and the reason the size check exists.
		expect(shouldCompress("application/octet-stream")).toBe(true);
	});
});

describe("composed read paths", () => {
	test("ENC(ZSTD(x)) streams back to plaintext", async () => {
		const dir = tmpDir();
		const plain = join(dir, "plain");
		const packed = join(dir, "packed");
		const stored = join(dir, "stored");
		const key = randomBytes(32);
		// Larger than one container chunk, so the composition has to survive a
		// multi-chunk decrypt feeding a single decompress.
		const data = compressible(5 * 1024 * 1024);
		writeFileSync(plain, data);

		await compressIfWorthwhile(plain, packed, data.length);
		await encryptFile(key, packed, stored);

		expect(
			await collect(decompressFromDecrypted(stored, data.length, key)),
		).toEqual(data);
	});

	test("ZSTD(ENC(x)) streams back to plaintext", async () => {
		const dir = tmpDir();
		const plain = join(dir, "plain");
		const enc = join(dir, "enc");
		const stored = join(dir, "stored");
		const key = randomBytes(32);
		const data = compressible(5 * 1024 * 1024);
		writeFileSync(plain, data);

		// The archive job's order: encrypt first, then compress in place.
		// Built with the raw `compressFile` on purpose -- `compressIfWorthwhile`
		// now (correctly) declines ciphertext, so this shape only exists on disk
		// for files the old unconditional archive job already rewrote. They still
		// have to read back.
		await encryptFile(key, plain, enc);
		await compressFile(enc, stored);

		expect(
			await collect(decryptFromDecompressed(stored, data.length, key)),
		).toEqual(data);
	});

	test("neither path stages an intermediate on disk", async () => {
		// The whole point of composing these: the old versions wrote a full copy
		// of the file into a temp dir before yielding a byte. If one comes back,
		// this catches it -- the streams are consumed lazily, so a staged
		// intermediate would have to exist while the first chunk is read.
		const dir = tmpDir();
		const plain = join(dir, "plain");
		const packed = join(dir, "packed");
		const stored = join(dir, "stored");
		const key = randomBytes(32);
		const data = compressible(5 * 1024 * 1024);
		writeFileSync(plain, data);
		await compressIfWorthwhile(plain, packed, data.length);
		await encryptFile(key, packed, stored);

		const source = decompressFromDecrypted(stored, data.length, key);
		const first = await source.next();
		expect(first.done).toBe(false);
		// A staged intermediate would be the size of the whole file; a composed
		// pipeline has produced only its first chunk by now.
		expect(first.value.length).toBeLessThan(data.length);
		await source.return(undefined);
	});
});

describe("decompression guards", () => {
	test("refuses a stream that expands far past its declared size", async () => {
		const dir = tmpDir();
		const src = join(dir, "plain");
		const dst = join(dir, "packed");
		// Highly compressible, so the stored form is tiny relative to its output.
		const data = Buffer.alloc(8 * 1024 * 1024, 0x00);
		writeFileSync(src, data);
		await compressIfWorthwhile(src, dst, data.length);

		// Claiming a 1 KiB original makes the real 8 MiB output a 8000x expansion.
		expect(collect(decompressStream(dst, 1024))).rejects.toThrow(
			/decompression bomb/,
		);
	});

	test("surfaces a failing source instead of hanging", async () => {
		// `.pipe()` doesn't forward errors: without explicit wiring the consumer
		// waits forever on a decompressor nothing is going to end.
		async function* broken(): AsyncGenerator<Buffer> {
			yield Buffer.from("not zstd at all");
			throw new Error("source exploded");
		}
		expect(collect(decompressGuarded(broken(), 1024))).rejects.toThrow();
	});
});
