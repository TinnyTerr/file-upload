import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

export async function* decryptStream(
	key: Buffer,
	path: string,
): AsyncGenerator<Buffer> {
	const fh = await open(path, "r");
	try {
		const header = await readExact(fh, HEADER_SIZE, 0);
		if (header.length < HEADER_SIZE || !header.subarray(0, 4).equals(MAGIC)) {
			throw new Error("not a FUPL file");
		}
		if (header[4] !== VERSION) throw new Error("unsupported version");
		const baseNonce = header.subarray(5, 17);
		const total = header.readUInt32BE(17);
		// encrypt_file always writes at least one chunk; total == 0 means a
		// corrupted/forged header. Don't silently decrypt to an empty result.
		if (total <= 0) throw new Error("invalid chunk count");

		const { size } = await fh.stat();
		let pos = HEADER_SIZE;
		for (let idx = 0; idx < total; idx++) {
			const isLast = idx === total - 1;
			const want = isLast ? size - pos : PLAINTEXT_CHUNK + TAG_LEN;
			const ct = await readExact(fh, want, pos);
			pos += ct.length;
			if (ct.length < (isLast ? TAG_LEN : PLAINTEXT_CHUNK + TAG_LEN)) {
				throw new Error(`truncated at chunk ${idx}`);
			}
			const plaintext = openChunk(key, idx, isLast, Buffer.from(baseNonce), ct);
			if (plaintext.length > 0) yield plaintext;
		}
	} finally {
		await fh.close();
	}
}
