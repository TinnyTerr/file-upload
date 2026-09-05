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
import { decryptStream, decryptStreamFrom } from "../crypto/aead.ts";
import { resolveFileEncryption } from "../crypto/effectiveEncryption.ts";
import { openBox } from "../crypto/secretbox.ts";
import type { FileRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { decompressGuarded, decompressStream } from "./compress.ts";

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
export function isDirectlyStreamable(db: Db, f: FileRow): boolean {
	return (
		resolveFileEncryption(db, f).mode === "none" && !f.compressed && !f.archived
	);
}

/** `ENC(ZSTD(x))` -- the upload-time producer. Decrypt, then decompress.
 *
 * Composed as streams, so nothing is staged on disk and the first plaintext
 * byte leaves as soon as the first ciphertext chunk has been opened. This used
 * to decrypt the whole file into a temp directory before decompressing any of
 * it: a full extra write and read of the file per download, and a time to
 * first byte that scaled with the file rather than being constant. */
export function decompressFromDecrypted(
	path: string,
	originalSize: number,
	key: Buffer,
): AsyncGenerator<Buffer> {
	return decompressGuarded(decryptStream(key, path), originalSize);
}

/** `ZSTD(ENC(x))` -- the archive job's producer. Decompress, then decrypt.
 *
 * The mirror image of the above, and temp-file-free for the same reason:
 * `decryptStreamFrom` reads the container off a byte stream instead of
 * needing it to exist as a file first. */
export function decryptFromDecompressed(
	path: string,
	originalSize: number,
	key: Buffer,
): AsyncGenerator<Buffer> {
	return decryptStreamFrom(key, decompressStream(path, originalSize));
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
	// The key may live on an ancestor folder rather than on this row -- see
	// crypto/effectiveEncryption.ts.
	const eff = resolveFileEncryption(state.db, f);
	const needsDecrypt = eff.mode === "server";
	const needsDecompress = !!(f.compressed || f.archived);

	if (f.archived && !f.auto_unarchive_on_download) {
		throw new PlaintextUnavailable(
			"file is archived; contact admin to unarchive",
		);
	}

	if (needsDecrypt) {
		if (!eff.keyBlob) {
			throw new PlaintextUnavailable("encryption key not stored");
		}
		let perFileKey: Buffer;
		try {
			perFileKey = openBox(
				getMasterKey(state.settings),
				Buffer.from(eff.keyBlob),
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
