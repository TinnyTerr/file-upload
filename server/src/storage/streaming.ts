/**
 * Shared read-path helpers for serving a stored file's plaintext bytes.
 *
 * Extracted from routes/public.ts so the media library (routes/media.ts)
 * streams through exactly the same decrypt/decompress logic. The transform
 * order rule (CLAUDE.md "Decrypt/decompress order depends on the producer")
 * lives here and in storage/zip.ts -- keep the two in sync.
 */

import { type Stats, statSync } from "node:fs";
import type { AppState } from "../appState.ts";
import { fetchBlobFromPeers } from "../cluster/blobs.ts";
import { getMasterKey } from "../config.ts";
import { decryptStream } from "../crypto/aead.ts";
import { openBox } from "../crypto/secretbox.ts";
import type { FileRow } from "../db/rows.ts";
import { decompressStream } from "./compress.ts";
import { writeStreamToFile } from "./zip.ts";

/** Read-time cluster failover: if this file is a deduped, content-addressed
 * blob (blob_id set) and the local bytes are missing, try pulling them from
 * any active peer that still has them (see server/src/cluster/blobs.ts).
 * Best-effort and silent on failure -- the caller re-checks existsSync and
 * falls back to its usual "file missing from storage" 500. */
export async function ensureBlobAvailable(
	state: AppState,
	f: FileRow,
	fullPath: string,
): Promise<void> {
	if (!f.blob_id) return;
	const blob = state.db.get<{ stored_sha256: string; transform_key: string }>(
		"SELECT stored_sha256, transform_key FROM content_blobs WHERE id = $id",
		{ $id: f.blob_id },
	);
	if (!blob) return;
	try {
		await fetchBlobFromPeers(state, {
			storedSha256: blob.stored_sha256,
			transformKey: blob.transform_key,
			dest: fullPath,
			blobId: f.blob_id ?? undefined,
		});
	} catch {
		// best-effort -- caller falls back to a 500 if this didn't help
	}
}

/** True when the bytes on disk are already the bytes to send, so the response
 * can advertise `Accept-Ranges` and serve seeks with a plain read at an offset.
 * Anything else has to be decrypted and/or decompressed from byte zero. */
export function isDirectlyStreamable(f: FileRow): boolean {
	return f.encryption_mode === "none" && !f.compressed && !f.archived;
}

export async function* decompressFromDecrypted(
	path: string,
	originalSize: number,
	key: Buffer,
): AsyncGenerator<Buffer> {
	// upload-time compression: stored as ENC(ZSTD(x)) -> decrypt, then decompress.
	// decryptStream reads from disk directly; we can't decompress a live async
	// generator with node:zlib's stream API, so stream through a temp file --
	// writeStreamToFile honors backpressure instead of buffering the whole
	// (potentially huge) file in memory before writing it out.
	const { mkdtemp, unlink, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "fu-raw-"));
	const tmp1 = join(dir, "step1");
	try {
		await writeStreamToFile(decryptStream(key, path), tmp1);
		for await (const c of decompressStream(tmp1, originalSize)) yield c;
	} finally {
		await unlink(tmp1).catch(() => {});
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function* decryptFromDecompressed(
	path: string,
	originalSize: number,
	key: Buffer,
): AsyncGenerator<Buffer> {
	// archive job: stored as ZSTD(ENC(x)) -> decompress, then decrypt. Same
	// streamed-through-a-temp-file approach as decompressFromDecrypted above.
	const { mkdtemp, unlink, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "fu-raw-"));
	const tmp1 = join(dir, "step1");
	try {
		await writeStreamToFile(decompressStream(path, originalSize), tmp1);
		for await (const c of decryptStream(key, tmp1)) yield c;
	} finally {
		await unlink(tmp1).catch(() => {});
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export class PlaintextUnavailable extends Error {}

/** Yields a file's plaintext bytes whatever combination of server-side
 * encryption, upload compression and archival it was stored under. Always
 * starts at byte zero -- callers that need seeking must check
 * `isDirectlyStreamable` first and read the file at an offset instead. */
export function plaintextStream(
	state: AppState,
	f: FileRow,
	fullPath: string,
): AsyncGenerator<Buffer> {
	const needsDecrypt = f.encryption_mode === "server";
	const needsDecompress = !!(f.compressed || f.archived);

	if (f.archived && !f.auto_unarchive_on_download) {
		throw new PlaintextUnavailable(
			"file is archived; contact admin to unarchive",
		);
	}

	if (needsDecrypt) {
		if (!f.enc_key_blob) {
			throw new PlaintextUnavailable("encryption key not stored");
		}
		let perFileKey: Buffer;
		try {
			perFileKey = openBox(
				getMasterKey(state.settings),
				Buffer.from(f.enc_key_blob),
			);
		} catch {
			throw new PlaintextUnavailable("failed to recover encryption key");
		}
		if (!needsDecompress) return decryptStream(perFileKey, fullPath);
		// Compression order mirrors the two possible producers: upload-time
		// compression wraps ENC(ZSTD(x)); the archive job produces ZSTD(ENC(x)).
		return f.archived && !f.compressed
			? decryptFromDecompressed(fullPath, f.size_bytes, perFileKey)
			: decompressFromDecrypted(fullPath, f.size_bytes, perFileKey);
	}

	if (needsDecompress) return decompressStream(fullPath, f.size_bytes);

	// Client-encrypted files reach here too: the ciphertext IS what the client
	// asked for, since only the browser holds the key.
	return plainFileStream(fullPath);
}

async function* plainFileStream(path: string): AsyncGenerator<Buffer> {
	const { createReadStream } = await import("node:fs");
	const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
	for await (const chunk of stream) yield chunk as Buffer;
}

export function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}
