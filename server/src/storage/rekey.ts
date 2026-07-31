/**
 * Re-encrypting stored bytes in place.
 *
 * Changing a folder's or a file's encryption is a real byte rewrite, not a
 * metadata flip: storage is content-addressed, the old blob may be shared
 * (`ref_count > 1`), and the ciphertext is keyed. So each affected file is
 * decrypted to plaintext, re-encrypted under the new key, written as a fresh
 * blob, and the old blob reference released.
 *
 * The rewrite always lands the file **untransformed** (`compressed = 0`,
 * `archived = 0`): plaintext is what comes back out of `memberSource`, and
 * re-deriving the original zstd layering would mean reproducing whichever of
 * the two transform orders the file happened to be stored in. The archive
 * sweep re-compresses it the next time it goes idle, so this costs disk
 * temporarily, never correctness.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppState } from "../appState.ts";
import { getMasterKey } from "../config.ts";
import { encryptFile } from "../crypto/aead.ts";
import type { EffectiveEncryption } from "../crypto/effectiveEncryption.ts";
import { resolveFileEncryption } from "../crypto/effectiveEncryption.ts";
import type { DirectoryRow, FileRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { childDirectories } from "../directoryTree.ts";
import { attachBlob, hashFile, releaseBlob, unlinkQueued } from "./blobs.ts";
import { newInternalRelPath, safeJoin, storageRoot } from "./paths.ts";
import { ensureBlobAvailable } from "./streaming.ts";
import { deleteThumbnail } from "./thumbnail.ts";
import { memberSource } from "./zip.ts";

/** The state a file is being moved *to*. `key` is the raw AES key its bytes get
 * encrypted under; `keyBlob`/`accessBlob` are what the row stores, and stay
 * null when the file inherits them from the folder above it instead. */
export interface TargetEncryption {
	mode: string;
	key: Buffer | null;
	keyBlob: Buffer | null;
	accessBlob: Buffer | null;
	/** 1 when `accessBlob` seals a human-chosen password (security/accessLock.ts). */
	accessIsPassword: number;
	overridden: number;
}

export function blobsEqual(
	a: Uint8Array | null,
	b: Uint8Array | null,
): boolean {
	if (a === null || b === null) return a === b;
	if (a.length !== b.length) return false;
	return Buffer.from(a).equals(Buffer.from(b));
}

/** Every file below `dir` that the folder's encryption currently governs, i.e.
 * the set a re-key of `dir` has to rewrite.
 *
 * The walk descends only through subfolders that inherit -- a subfolder that
 * holds its own key is a wall, which is the whole point of a break point.
 * Within those, a file counts when its effective state *is* the folder's
 * current state (same mode, same key bytes). That deliberately includes files
 * that pin the key on their own row rather than inheriting it: every file
 * predating the inheritance model carries a copy of its folder's key, and
 * skipping those would make "encrypt this folder" a no-op on all existing
 * data. The trade is that a file explicitly pinned to the state the folder is
 * leaving gets carried along with it -- which is also what "re-key this whole
 * folder" reads as.
 *
 * `client` and `sealed` files are never touched: the server cannot decrypt
 * them, so they are left exactly as they are. */
export function filesFollowingDirectory(
	db: Db,
	dir: DirectoryRow,
	current: EffectiveEncryption,
): FileRow[] {
	const out: FileRow[] = [];
	const stack: DirectoryRow[] = [dir];
	const seen = new Set<number>([dir.id]);
	while (stack.length) {
		const node = stack.pop()!;
		for (const f of db.all<FileRow>(
			"SELECT * FROM files WHERE directory_id = $id",
			{ $id: node.id },
		)) {
			const eff = resolveFileEncryption(db, f);
			if (eff.mode === "client" || eff.mode === "sealed") continue;
			if (eff.mode !== current.mode) continue;
			if (!blobsEqual(eff.keyBlob, current.keyBlob)) continue;
			out.push(f);
		}
		for (const child of childDirectories(db, node.id)) {
			if (child.encryption_overridden || seen.has(child.id)) continue;
			seen.add(child.id);
			stack.push(child);
		}
	}
	return out;
}

/** The inheriting subfolders a re-key of `dir` also covers -- their
 * `encryption_mode` mirror has to follow (see crypto/effectiveEncryption.ts on
 * why the mirror exists). */
export function directoriesFollowingDirectory(
	db: Db,
	dir: DirectoryRow,
): DirectoryRow[] {
	const out: DirectoryRow[] = [];
	const stack: DirectoryRow[] = [dir];
	const seen = new Set<number>([dir.id]);
	while (stack.length) {
		for (const child of childDirectories(db, stack.pop()!.id)) {
			if (child.encryption_overridden || seen.has(child.id)) continue;
			seen.add(child.id);
			out.push(child);
			stack.push(child);
		}
	}
	return out;
}

/** Freeze a file's current effective encryption onto its own row.
 *
 * Called on every file a folder-level re-key is about to touch, *before*
 * anything changes. From that moment nothing under the folder depends on the
 * folder's own columns, so the operation can fail halfway through and every
 * file it hasn't reached yet is still readable with exactly the key it was
 * already using -- it has simply stopped following the folder. */
export function pinFileEncryption(db: Db, f: FileRow): void {
	if (f.encryption_overridden) return;
	const eff = resolveFileEncryption(db, f);
	db.run(
		`UPDATE files SET encryption_overridden = 1, encryption_mode = $mode,
       enc_key_blob = $key, enc_access_blob = $access,
       access_is_password = $isPassword WHERE id = $id`,
		{
			$mode: eff.mode,
			$key: eff.keyBlob ? Buffer.from(eff.keyBlob) : null,
			$access: eff.accessBlob ? Buffer.from(eff.accessBlob) : null,
			$isPassword: eff.passwordLocked ? 1 : 0,
			$id: f.id,
		},
	);
}

/** Rewrites one file's stored bytes into `next`, updating its row and
 * releasing the old blob. The file row must still describe the *current*
 * bytes when this is called -- that is what tells it how to read them. */
export async function rewriteFileEncryption(
	state: AppState,
	f: FileRow,
	next: TargetEncryption,
): Promise<void> {
	const { db } = state;
	const masterKey = getMasterKey(state.settings);
	// `sealed` encrypts exactly like `server` -- the only difference is that its
	// key is never stored (routes/files.ts's seal handler).
	if ((next.mode === "server" || next.mode === "sealed") && !next.key) {
		throw new Error(`${next.mode} mode needs a key to encrypt with`);
	}

	// `memberSource` reads straight off local disk and throws a bare 500 when the
	// bytes aren't there. On a `REPLICATION_MODE=cache` node whose blob has been
	// evicted that is every seal and every encryption change, while the
	// browser-side conversion path -- which goes through GET /files/:id/content,
	// and *does* fetch on miss -- keeps working. Pull the blob back first.
	const localPath = safeJoin(storageRoot(), f.storage_path);
	if (!existsSync(localPath)) {
		await ensureBlobAvailable(state, f, localPath);
	}

	const [plain, isTemp] = await memberSource(db, masterKey, f);
	const relPath = newInternalRelPath();
	const basePath = join(storageRoot(), relPath);
	mkdirSync(join(basePath, ".."), { recursive: true });
	try {
		const plainHashes = await hashFile(plain);
		if (next.key) {
			await encryptFile(next.key, plain, basePath);
		} else {
			await copyFile(plain, basePath);
		}
		const storedHashes = await hashFile(basePath);
		const blob = attachBlob(db, {
			finalPath: basePath,
			relPath,
			logicalSize: f.size_bytes,
			contentType: f.content_type,
			hashes: plainHashes,
			storedHashes,
			transformKey: `${next.mode}:compressed=0`,
		});
		// Release before repointing: releaseBlob reads f.blob_id (still the old
		// one) and nulls the column itself when the last reference goes.
		const stale = releaseBlob(db, f);
		db.run(
			`UPDATE files SET blob_id = $blobId, storage_path = $path,
         stored_size_bytes = $stored, encryption_mode = $mode,
         enc_key_blob = $key, enc_access_blob = $access,
         access_is_password = $isPassword,
         encryption_overridden = $overridden, compressed = 0, archived = 0,
         archive_codec = NULL, archive_original_stored_size_bytes = 0,
         archive_saved_bytes = 0, lifecycle_state = 'active' WHERE id = $id`,
			{
				$blobId: blob.id,
				$path: blob.storage_path,
				$stored: blob.stored_size_bytes,
				$mode: next.mode,
				$key: next.keyBlob,
				$access: next.accessBlob,
				$isPassword: next.accessIsPassword,
				$overridden: next.overridden,
				$id: f.id,
			},
		);
		// The thumbnail cache is keyed by file id and is not reference-counted, so
		// nothing else will invalidate it. A plaintext file that just became
		// `server`/`sealed` would otherwise keep a cached JPEG of its contents
		// sitting on disk under the old mode's assumptions.
		deleteThumbnail(f.id);
		unlinkQueued([stale]);
	} catch (err) {
		try {
			if (existsSync(basePath)) unlinkSync(basePath);
		} catch {
			// best-effort
		}
		throw err;
	} finally {
		if (isTemp) {
			try {
				unlinkSync(plain);
			} catch {
				// best-effort
			}
		}
	}
}
