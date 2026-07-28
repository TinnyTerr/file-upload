/**
 * FUPL v1 cryptographic primitives, byte-compatible with app/crypto/aead.py.
 * Pure (no DOM/worker globals) so the same code runs in the browser worker and
 * in a Node verification harness. Relies only on the WebCrypto `crypto.subtle`
 * global, available in both environments.
 */

export const FUPL = {
	MAGIC: new Uint8Array([0x46, 0x55, 0x50, 0x4c]), // "FUPL"
	VERSION: 0x01,
	HEADER_SIZE: 21, // 4 + 1 + 12 + 4
	NONCE_SIZE: 12,
	TAG_SIZE: 16,
	PLAINTEXT_CHUNK: 2 * 1024 * 1024, // 2 MiB
};

/**
 * TS 5.7+ types `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which WebCrypto's
 * `BufferSource` (wanting `ArrayBuffer`-backed views) rejects. Our arrays are
 * always ArrayBuffer-backed at runtime, so coerce at the crypto boundary.
 */
const bs = (v: Uint8Array | ArrayBuffer): BufferSource => v as BufferSource;

export function u32be(n: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n >>> 0, false);
	return b;
}

export function chunkNonce(
	base: Uint8Array,
	idx: number,
	isLast: boolean,
): Uint8Array {
	const delta = new Uint8Array(12); // 7 zero bytes, u32be(idx), flag
	delta.set(u32be(idx), 7);
	delta[11] = isLast ? 0x01 : 0x00;
	const out = new Uint8Array(12);
	for (let i = 0; i < 12; i++) out[i] = base[i] ^ delta[i];
	return out;
}

export function chunkAad(idx: number, isLast: boolean): Uint8Array {
	const aad = new Uint8Array(21); // 16 zero bytes, u32be(idx), flag
	aad.set(u32be(idx), 16);
	aad[20] = isLast ? 0x01 : 0x00;
	return aad;
}

export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.byteLength !== 32) throw new Error("key must be 32 bytes");
	return crypto.subtle.importKey("raw", bs(raw), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export function buildHeader(baseNonce: Uint8Array, total: number): Uint8Array {
	const header = new Uint8Array(FUPL.HEADER_SIZE);
	header.set(FUPL.MAGIC, 0);
	header[4] = FUPL.VERSION;
	header.set(baseNonce, 5);
	header.set(u32be(total), 17);
	return header;
}

export interface ParsedHeader {
	baseNonce: Uint8Array;
	total: number;
}

export function parseHeader(header: Uint8Array): ParsedHeader {
	if (header.byteLength < FUPL.HEADER_SIZE) throw new Error("truncated header");
	for (let i = 0; i < 4; i++)
		if (header[i] !== FUPL.MAGIC[i]) throw new Error("not a FUPL file");
	if (header[4] !== FUPL.VERSION) throw new Error("unsupported version");
	const baseNonce = header.slice(5, 17);
	const total = new DataView(
		header.buffer,
		header.byteOffset,
		header.byteLength,
	).getUint32(17, false);
	if (total <= 0) throw new Error("invalid chunk count");
	return { baseNonce, total };
}

export async function encryptChunk(
	key: CryptoKey,
	baseNonce: Uint8Array,
	idx: number,
	isLast: boolean,
	plaintext: Uint8Array,
): Promise<ArrayBuffer> {
	return crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: bs(chunkNonce(baseNonce, idx, isLast)),
			additionalData: bs(chunkAad(idx, isLast)),
			tagLength: 128,
		},
		key,
		bs(plaintext),
	);
}

export async function decryptChunk(
	key: CryptoKey,
	baseNonce: Uint8Array,
	idx: number,
	isLast: boolean,
	ciphertext: ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
	return crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bs(chunkNonce(baseNonce, idx, isLast)),
			additionalData: bs(chunkAad(idx, isLast)),
			tagLength: 128,
		},
		key,
		bs(ciphertext),
	);
}

export function totalChunks(size: number): number {
	return Math.max(1, Math.ceil(size / FUPL.PLAINTEXT_CHUNK));
}

/** Whole-buffer encrypt (used by the Node verifier; the worker streams Blobs). */
export async function encryptBytes(
	rawKey: Uint8Array,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const key = await importKey(rawKey);
	const baseNonce = crypto.getRandomValues(new Uint8Array(FUPL.NONCE_SIZE));
	const total = totalChunks(plaintext.length);
	const out: Uint8Array[] = [buildHeader(baseNonce, total)];
	for (let idx = 0; idx < total; idx++) {
		const start = idx * FUPL.PLAINTEXT_CHUNK;
		const slice = plaintext.subarray(
			start,
			Math.min(start + FUPL.PLAINTEXT_CHUNK, plaintext.length),
		);
		const ct = await encryptChunk(
			key,
			baseNonce,
			idx,
			idx === total - 1,
			slice,
		);
		out.push(new Uint8Array(ct));
	}
	return concat(out);
}

/** Whole-buffer decrypt (used by the Node verifier). */
export async function decryptBytes(
	rawKey: Uint8Array,
	data: Uint8Array,
): Promise<Uint8Array> {
	const key = await importKey(rawKey);
	const { baseNonce, total } = parseHeader(data.subarray(0, FUPL.HEADER_SIZE));
	const out: Uint8Array[] = [];
	let offset = FUPL.HEADER_SIZE;
	for (let idx = 0; idx < total; idx++) {
		const isLast = idx === total - 1;
		const end = isLast
			? data.length
			: offset + FUPL.PLAINTEXT_CHUNK + FUPL.TAG_SIZE;
		if (end > data.length) throw new Error(`truncated at chunk ${idx}`);
		const pt = await decryptChunk(
			key,
			baseNonce,
			idx,
			isLast,
			data.subarray(offset, end),
		);
		out.push(new Uint8Array(pt));
		offset = end;
	}
	return concat(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const len = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(len);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
}
