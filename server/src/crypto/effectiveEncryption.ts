/**
 * Effective-encryption resolver.
 *
 * Folders nest, and a nested folder (or a file inside one) does not have to
 * carry its own key: `encryption_overridden = 0` means "whatever protects my
 * nearest overridden ancestor protects me too". Every read path has to ask
 * *this* module which key actually decrypts a row's bytes rather than reading
 * `enc_key_blob` off the row -- an inheriting row's key columns are NULL.
 *
 * Two things are deliberately split:
 *
 *  - **Key material is authoritative here.** `enc_key_blob` / `enc_access_blob`
 *    only ever live on the break point that owns them (see
 *    `routes/directories.ts`'s create handler, which leaves an inheriting
 *    child's columns NULL). There is exactly one copy, so re-keying a folder
 *    can never leave a stale duplicate behind on a descendant.
 *  - **`encryption_mode` is a denormalized mirror.** An inheriting row still
 *    stores the mode it resolves to, so plain SQL filters keep working
 *    (`jobs/lifecycle.ts`'s archive sweep, `routes/admin.ts`'s bulk actions and
 *    `storage/mediaProbe.ts` all select on `encryption_mode` and must not have
 *    to walk a tree per row). Anything that changes an effective mode is
 *    responsible for rewriting descendants' mirrors as it re-encrypts them.
 *    The resolver's `mode` is still the authority when the two disagree.
 */

import { timingSafeEqual } from "node:crypto";
import { openBox } from "../crypto/secretbox.ts";
import type { DirectoryRow, FileRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getDirectory, nearestOverride } from "../directoryTree.ts";

export interface EffectiveEncryption {
	/** `none` | `server` | `client` (| `sealed`, once phase 8 lands). */
	mode: string;
	keyBlob: Uint8Array | null;
	accessBlob: Uint8Array | null;
	/** The `?ek=` secret is a human-chosen password, not a random token, so
	 * verifying it publicly has to be rate limited (security/lockout.ts). */
	passwordLocked: boolean;
	/** Directories only -- the client-mode key verifier. Always null for files. */
	keyCheckBlob: string | null;
	/** The directory this state was inherited from, or null when the node holds
	 * its own key. Drives the "Inherited from <folder>" affordance in the UI. */
	sourceDirectoryId: number | null;
	/** The directory whose columns these actually are, or null when the answer
	 * came off the file's own row.
	 *
	 * Distinct from `sourceDirectoryId`, which is only set when the resolver had
	 * to *walk*: a file inheriting straight from its own break-point folder has
	 * no ancestor to name, but its key still belongs to that folder. Anything
	 * asking "which secret opens this?" -- the public folder viewer's key
	 * scopes, the zip's entitlement check -- has to use this one. */
	ownerDirectoryId: number | null;
}

/**
 * Which secret opens a node, as an opaque string.
 *
 * A folder link covers a subtree that can contain break points with keys of
 * their own, so "the folder's key" is not a single thing. This names the *owner*
 * of the key rather than the node presenting it -- which is what lets the public
 * page ask for exactly the secret it is missing, and what the guess counter has
 * to be keyed on so that N members of one folder are not N independent budgets
 * against the same password.
 */
export function keyScopeOf(
	eff: EffectiveEncryption,
	ownFallback: string,
): string {
	return eff.ownerDirectoryId === null
		? ownFallback
		: `dir:${eff.ownerDirectoryId}`;
}

function fromDirectory(
	d: DirectoryRow,
	inherited: boolean,
): EffectiveEncryption {
	return {
		mode: d.encryption_mode,
		keyBlob: d.enc_key_blob,
		accessBlob: d.enc_access_blob,
		passwordLocked: !!d.access_is_password,
		keyCheckBlob: d.key_check_blob,
		sourceDirectoryId: inherited ? d.id : null,
		ownerDirectoryId: d.id,
	};
}

/** What actually protects this folder's contents: its own columns when it is a
 * break point, otherwise the nearest overridden ancestor's. */
export function resolveDirectoryEncryption(
	db: Db,
	directory: DirectoryRow,
): EffectiveEncryption {
	if (directory.encryption_overridden) return fromDirectory(directory, false);
	return fromDirectory(nearestOverride(db, directory), true);
}

/** What actually protects this file's bytes. `client` and `sealed` files are
 * always their own break point, so they never reach the directory chain. */
export function resolveFileEncryption(
	db: Db,
	file: FileRow,
): EffectiveEncryption {
	const own: EffectiveEncryption = {
		mode: file.encryption_mode,
		keyBlob: file.enc_key_blob,
		accessBlob: file.enc_access_blob,
		passwordLocked: !!file.access_is_password,
		keyCheckBlob: null,
		sourceDirectoryId: null,
		ownerDirectoryId: null,
	};
	if (file.encryption_overridden) return own;
	// A root-level file has nothing above it to inherit from; treating it as its
	// own break point is the same answer the schema default would have given.
	if (file.directory_id === null) return own;
	const dir = getDirectory(db, file.directory_id);
	if (!dir) return own;
	return resolveDirectoryEncryption(db, dir);
}

/** The plaintext access secret behind `?ek=` for a server-mode node, or null
 * when the node needs none (or its blob can't be opened under the master key). */
export function recoverAccessSecret(
	masterKey: Buffer,
	eff: EffectiveEncryption,
): string | null {
	if (eff.mode !== "server" || !eff.accessBlob) return null;
	try {
		return openBox(masterKey, Buffer.from(eff.accessBlob)).toString("utf-8");
	} catch {
		return null;
	}
}

/** Constant-time compare of a presented access secret against the expected one. */
export function accessSecretMatches(
	expected: string | null,
	presented: string | null,
): boolean {
	if (expected === null || !presented) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
