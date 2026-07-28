/// <reference lib="webworker" />
/**
 * FUPL v1 chunked AES-256-GCM encryption/decryption worker. Streams the source
 * Blob chunk-by-chunk to keep memory ~O(chunk). The wire-format primitives are
 * shared with the Node verifier via ./fuplCore (kept byte-compatible with
 * app/crypto/aead.py).
 */

import type { AeadRequest, AeadResponse } from "./aeadTypes";
import {
	buildHeader,
	decryptChunk,
	encryptChunk,
	FUPL,
	importKey,
	parseHeader,
	totalChunks,
} from "./fuplCore";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: AeadResponse) {
	ctx.postMessage(msg);
}

async function encrypt(
	blob: Blob,
	rawKey: Uint8Array,
	id: number,
): Promise<Blob> {
	const key = await importKey(rawKey);
	const baseNonce = crypto.getRandomValues(new Uint8Array(FUPL.NONCE_SIZE));
	const total = totalChunks(blob.size);
	const parts: BlobPart[] = [buildHeader(baseNonce, total) as BlobPart];

	for (let idx = 0; idx < total; idx++) {
		const start = idx * FUPL.PLAINTEXT_CHUNK;
		const end = Math.min(start + FUPL.PLAINTEXT_CHUNK, blob.size);
		const plaintext = new Uint8Array(
			await blob.slice(start, end).arrayBuffer(),
		);
		parts.push(
			await encryptChunk(key, baseNonce, idx, idx === total - 1, plaintext),
		);
		post({
			type: "progress",
			id,
			percent: Math.round(((idx + 1) / total) * 100),
		});
	}

	return new Blob(parts, { type: "application/octet-stream" });
}

async function decrypt(
	blob: Blob,
	rawKey: Uint8Array,
	id: number,
): Promise<Blob> {
	const key = await importKey(rawKey);
	const header = new Uint8Array(
		await blob.slice(0, FUPL.HEADER_SIZE).arrayBuffer(),
	);
	const { baseNonce, total } = parseHeader(header);

	const parts: BlobPart[] = [];
	let offset = FUPL.HEADER_SIZE;

	for (let idx = 0; idx < total; idx++) {
		const isLast = idx === total - 1;
		const end = isLast
			? blob.size
			: offset + FUPL.PLAINTEXT_CHUNK + FUPL.TAG_SIZE;
		if (end > blob.size) throw new Error(`truncated at chunk ${idx}`);
		const ct = await blob.slice(offset, end).arrayBuffer();
		if (ct.byteLength < FUPL.TAG_SIZE)
			throw new Error(`truncated at chunk ${idx}`);
		parts.push(await decryptChunk(key, baseNonce, idx, isLast, ct));
		offset = end;
		post({
			type: "progress",
			id,
			percent: Math.round(((idx + 1) / total) * 100),
		});
	}

	return new Blob(parts);
}

ctx.onmessage = async (e: MessageEvent<AeadRequest>) => {
	const msg = e.data;
	try {
		const result =
			msg.type === "encrypt"
				? await encrypt(msg.blob, msg.key, msg.id)
				: await decrypt(msg.blob, msg.key, msg.id);
		post({ type: "result", id: msg.id, blob: result });
	} catch (err) {
		post({
			type: "error",
			id: msg.id,
			message: err instanceof Error ? err.message : String(err),
		});
	}
};
