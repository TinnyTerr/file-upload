import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

/**
 * Streaming AES-256-GCM file container, byte-compatible with
 * app/crypto/aead.py so files encrypted by the Python backend still decrypt.
 *
 * Layout: "FUPL" | 0x01 | 12-byte base nonce | uint32be chunk count | chunks…
 * Each chunk is AESGCM(nonce=base^delta, aad)(2 MiB plaintext) || 16-byte tag.
 */

export const MAGIC = Buffer.from("FUPL");
const VERSION = 0x01;
const PLAINTEXT_CHUNK = 2 * 1024 * 1024;
const TAG_LEN = 16;
const HEADER_SIZE = 21; // 4 + 1 + 12 + 4

function delta(idx: number, isLast: boolean): Buffer {
	const buf = Buffer.alloc(12);
	buf.writeUInt32BE(idx, 7);
	buf[11] = isLast ? 0x01 : 0x00;
	return buf;
}

function nonce(base: Buffer, idx: number, isLast: boolean): Buffer {
	const d = delta(idx, isLast);
	const out = Buffer.alloc(12);
	for (let i = 0; i < 12; i++) out[i] = base[i]! ^ d[i]!;
	return out;
}

function aad(idx: number, isLast: boolean): Buffer {
	const buf = Buffer.alloc(21);
	buf.writeUInt32BE(idx, 16);
	buf[20] = isLast ? 0x01 : 0x00;
	return buf;
}

function sealChunk(
	key: Buffer,
	idx: number,
	isLast: boolean,
	base: Buffer,
	plaintext: Buffer,
): Buffer {
	const cipher = createCipheriv("aes-256-gcm", key, nonce(base, idx, isLast));
	cipher.setAAD(aad(idx, isLast));
	const ct = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return ct;
}

function openChunk(
	key: Buffer,
	idx: number,
	isLast: boolean,
	base: Buffer,
	blob: Buffer,
): Buffer {
	if (blob.length < TAG_LEN) throw new Error(`truncated at chunk ${idx}`);
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		nonce(base, idx, isLast),
	);
	decipher.setAAD(aad(idx, isLast));
	decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
	return Buffer.concat([
		decipher.update(blob.subarray(0, blob.length - TAG_LEN)),
		decipher.final(),
	]);
}

async function readExact(
	fh: FileHandle,
	size: number,
	position: number,
): Promise<Buffer> {
	const buf = Buffer.alloc(size);
	const { bytesRead } = await fh.read(buf, 0, size, position);
	return buf.subarray(0, bytesRead);
}

export async function encryptFile(
	key: Buffer,
	src: string,
	dst: string,
): Promise<void> {
	const baseNonce = randomBytes(12);
	const fin = await open(src, "r");
	const fout = await open(dst, "w");
	try {
		const header = Buffer.alloc(HEADER_SIZE);
		MAGIC.copy(header, 0);
		header[4] = VERSION;
		baseNonce.copy(header, 5);
		await fout.write(header);

		let total = 0;
		let pos = 0;
		let buf = await readExact(fin, PLAINTEXT_CHUNK, pos);
		pos += buf.length;
		while (buf.length > 0) {
			const nxt = await readExact(fin, PLAINTEXT_CHUNK, pos);
			pos += nxt.length;
			const isLast = nxt.length === 0;
			await fout.write(sealChunk(key, total, isLast, baseNonce, buf));
			total += 1;
			buf = nxt;
		}
		if (total === 0) {
			await fout.write(sealChunk(key, 0, true, baseNonce, Buffer.alloc(0)));
			total = 1;
		}
		const count = Buffer.alloc(4);
		count.writeUInt32BE(total);
		await fout.write(count, 0, 4, 17);
	} finally {
		await fin.close();
		await fout.close();
	}
}

/**
 * Pulls exact-length runs of bytes off a byte stream, buffering the remainder.
 *
 * The container is fixed-stride (`PLAINTEXT_CHUNK + TAG_LEN` per chunk, short
 * final chunk), so reading it needs "give me exactly N bytes" over a source
 * that hands out arbitrary chunk sizes. Reads are large relative to a stream's
 * own chunks, so at most a couple of buffers are ever joined per read.
 */
class ByteReader {
	private pending: Buffer[] = [];
	private buffered = 0;
	private ended = false;

	constructor(private readonly it: AsyncIterator<Buffer>) {}

	/** Up to `size` bytes; shorter only when the source is exhausted. */
	async read(size: number): Promise<Buffer> {
		while (this.buffered < size && !this.ended) {
			const { value, done } = await this.it.next();
			if (done) {
				this.ended = true;
				break;
			}
			if (!value || value.length === 0) continue;
			this.pending.push(value);
			this.buffered += value.length;
		}
		if (this.buffered === 0) return Buffer.alloc(0);
		const joined =
			this.pending.length === 1
				? this.pending[0]!
				: Buffer.concat(this.pending, this.buffered);
		const take = Math.min(size, joined.length);
		const rest = joined.subarray(take);
		this.pending = rest.length ? [rest] : [];
		this.buffered = rest.length;
		return joined.subarray(0, take);
	}

	/** Releases the underlying source (closing a file descriptor, etc.). */
	async close(): Promise<void> {
		await this.it.return?.();
	}
}

/**
 * Decrypt a FUPL container arriving as a byte stream rather than a file.
 *
 * The stream form is what lets `ZSTD(ENC(x))` be read as one composed
 * pipeline: the archive job's output decompresses straight into this instead
 * of being staged to a temp file first (storage/streaming.ts). Sequential
 * reads are equivalent to the positioned reads this replaced -- the container
 * was only ever consumed front to back.
 */
export async function* decryptStreamFrom(
	key: Buffer,
	source: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
	const reader = new ByteReader(source[Symbol.asyncIterator]());
	try {
		const header = await reader.read(HEADER_SIZE);
		if (header.length < HEADER_SIZE || !header.subarray(0, 4).equals(MAGIC)) {
			throw new Error("not a FUPL file");
		}
		if (header[4] !== VERSION) throw new Error("unsupported version");
		const baseNonce = Buffer.from(header.subarray(5, 17));
		const total = header.readUInt32BE(17);
		// encrypt_file always writes at least one chunk; total == 0 means a
		// corrupted/forged header. Don't silently decrypt to an empty result.
		if (total <= 0) throw new Error("invalid chunk count");

		const stride = PLAINTEXT_CHUNK + TAG_LEN;
		for (let idx = 0; idx < total; idx++) {
			const isLast = idx === total - 1;
			const ct = await reader.read(stride);
			if (ct.length < (isLast ? TAG_LEN : stride)) {
				throw new Error(`truncated at chunk ${idx}`);
			}
			const plaintext = openChunk(key, idx, isLast, baseNonce, ct);
			if (plaintext.length > 0) yield plaintext;
		}
		// Anything past the declared chunk count is not part of the container.
		// The positioned-read version folded trailing bytes into the final
		// chunk, where GCM rejected them; refuse them explicitly instead of
		// decrypting a valid prefix out of a padded file.
		if ((await reader.read(1)).length > 0) {
			throw new Error("trailing data after final chunk");
		}
	} finally {
		await reader.close();
	}
}

export function decryptStream(
	key: Buffer,
	path: string,
): AsyncGenerator<Buffer> {
	return decryptStreamFrom(
		key,
		createReadStream(path, { highWaterMark: PLAINTEXT_CHUNK }),
	);
}
