import { randomBytes } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ZipArchive } from "archiver";
import busboy from "busboy";
import type { Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { replicateFile } from "../cluster/replication.ts";
import { getMasterKey } from "../config.ts";
import { encryptFile } from "../crypto/aead.ts";
import {
	keyScopeOf,
	recoverAccessSecret,
	resolveDirectoryEncryption,
	resolveFileEncryption,
} from "../crypto/effectiveEncryption.ts";
import {
	deriveSealKey,
	SEAL_SALT_BYTES,
	sealKdfId,
} from "../crypto/passwordKey.ts";
import { openBox, seal } from "../crypto/secretbox.ts";
import {
	type DirectoryRow,
	type FileRow,
	type LinkRow,
	nowIso,
	type PermissionRow,
	type UserRow,
} from "../db/rows.ts";
import { buildPathIndex, getDirectory, isEditor } from "../directoryTree.ts";
import { HttpError } from "../httpError.ts";
import { consumeUse, newSlug, resolveActiveLink } from "../links.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import {
	getUploadUser,
	requireActiveUser,
	requireMaster,
	requirePermission,
} from "../middleware/deps.ts";
import { ensurePermissions } from "../permissions.ts";
import {
	type AccessCheck,
	checkLinkAccess,
	LINK_ACCESS_IDENTIFIER,
	validateAccessPassword,
} from "../security/accessLock.ts";
import { requireCsrf } from "../security/csrf.ts";
import {
	enforceGlobalUploadCapacity,
	usedStorageBytes,
} from "../storage/accounting.ts";
import {
	attachBlob,
	fileHashes,
	hashFile,
	releaseBlob,
	unlinkQueued,
} from "../storage/blobs.ts";
import { compressFile, shouldCompress } from "../storage/compress.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";
import {
	blobsEqual,
	rewriteFileEncryption,
	type TargetEncryption,
} from "../storage/rekey.ts";
import {
	ensureBlobAvailable,
	PlaintextUnavailable,
	plaintextStream,
} from "../storage/streaming.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";
import { memberSource, safeArcname } from "../storage/zip.ts";

const log = getLogger("app.routes.files");

const CHUNK = 256 * 1024;
const REQUEST_OVERHEAD_ALLOWANCE = 1024 * 1024;
const CHUNK_UPLOAD_SIZE = 16 * 1024 * 1024;
const CHUNK_SESSION_TTL = 12 * 3600;
const CHUNK_TOKEN_AAD = Buffer.from("chunked-upload-v1");

const UNSAFE_CT = new Set([
	"text/html",
	"text/xhtml",
	"text/xhtml+xml",
	"image/svg+xml",
	"application/xhtml+xml",
]);

interface SumRow {
	total: number | null;
}
/** Exported for reuse by dropbox.ts (owner-quota lookups on behalf of the
 * dropbox link's owner, mirroring app/routes/dropbox.py's import from
 * app/routes/files.py). */
export function usedBytes(state: AppState, userId: number): number {
	return (
		state.db.get<SumRow>(
			"SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id",
			{ $id: userId },
		)?.total ?? 0
	);
}

/** Exported for reuse by dropbox.ts. Ancestor-aware since folders nest: a
 * grant made on a parent folder carries into everything below it. */
export function canEditDirectory(
	state: AppState,
	directoryId: number,
	user: UserRow,
): boolean {
	const dir = getDirectory(state.db, directoryId);
	if (!dir) return false;
	return isEditor(state.db, dir, user);
}

function fileUrl(req: Request, slug: string): string {
	const proto = req.protocol;
	const host = req.get("host");
	return `${proto}://${host}/file/${slug}`;
}

function randomizedFilename(originalFilename: string): string {
	const base = basename(originalFilename.replace(/\\/g, "/")).trim();
	let ext = extname(base);
	if (!/^[a-z0-9]+$/i.test(ext.slice(1)) || ext.length > 17) ext = "";
	return `${randomBytes(16).toString("hex")}${ext.toLowerCase()}`;
}

interface PreparedUpload {
	encryptionMode: string;
	compress: boolean;
	isPermanent: boolean;
	tempDays: number | null;
	randomizeFilename: boolean;
	directory: DirectoryRow | null;
	perm: PermissionRow;
}

function prepareUpload(
	state: AppState,
	user: UserRow,
	opts: {
		encryptionMode: string;
		compress: boolean;
		isPermanent: boolean;
		tempDays: number | null;
		randomizeFilename: boolean;
		directoryId: number | null;
		/** The caller encrypted these bytes in the browser and says so. Only the
		 * two browser/API upload routes may claim it -- same rule and the same
		 * reasoning as `FinalizeOpts.clientCiphertext`. */
		clientCiphertext?: boolean;
	},
): PreparedUpload {
	let { encryptionMode, compress, isPermanent, tempDays, randomizeFilename } =
		opts;
	if (!["none", "server", "client"].includes(encryptionMode)) {
		throw new HttpError(400, "invalid encryption_mode");
	}

	let directory: DirectoryRow | null = null;
	if (opts.directoryId !== null) {
		directory =
			state.db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", {
				$id: opts.directoryId,
			}) ?? null;
		if (!directory) throw new HttpError(404, "directory not found");
		if (!canEditDirectory(state, directory.id, user))
			throw new HttpError(403, "not your directory");
		// A file placed in a folder takes the folder's *effective* encryption --
		// which may be defined several levels up (crypto/effectiveEncryption.ts).
		//
		// The exception is a caller that did the encrypting itself and says so:
		// `client` is never inheritable (finalizeStoredFile makes such a file its
		// own break point), so an explicit client-mode upload keeps its own key
		// rather than adopting the folder's. Without this, converting a file that
		// lives in a `none`/`server` folder to end-to-end stored real browser
		// ciphertext under a label that promised plaintext -- an unreadable file.
		const dirMode = resolveDirectoryEncryption(state.db, directory).mode;
		encryptionMode =
			opts.clientCiphertext && encryptionMode === "client" ? "client" : dirMode;
		compress = false;
		isPermanent = true;
		tempDays = null;
		randomizeFilename = false;
	}

	if (!isPermanent && !tempDays)
		throw new HttpError(
			400,
			"temp_days is required when is_permanent is false",
		);

	const perm = ensurePermissions(state.db, user.id, {
		master: user.role === "master",
	});
	// Deliberately after the directory resolution above: it tests the mode the
	// file will actually be stored under, which is the one that matters whether
	// it came from the request or from the destination folder.
	if (encryptionMode === "client" && !perm.can_upload_client_encrypted) {
		throw new HttpError(403, "client-side encryption not permitted");
	}

	return {
		encryptionMode,
		compress,
		isPermanent,
		tempDays,
		randomizeFilename,
		directory,
		perm,
	};
}

/** Rejects new uploads while a cluster-wide or per-user halt is active (see
 * server/src/cluster/halt.ts). Checked at the start of every upload entry
 * point -- single-shot and chunked-init -- so a storage-emergency halt
 * gossiped over the firehose takes effect immediately without needing to
 * touch each in-flight request individually. Exported for reuse by
 * dropbox.ts, mirroring precheckDeclaredSize below. */
export function checkUploadHalt(state: AppState, userId: number): void {
	const until = state.haltRegistry.activeUntil(userId);
	if (until !== null) {
		throw new HttpError(
			503,
			"uploads are temporarily halted on this cluster; try again shortly",
		);
	}
}

/** Exported for reuse by dropbox.ts. Mirrors
 * app/routes/dropbox.py's import of app/routes/files.py::_precheck_declared_size. */
export function precheckDeclaredSize(
	state: AppState,
	user: UserRow,
	perm: PermissionRow,
	declared: number,
): void {
	if (declared > perm.max_file_bytes + REQUEST_OVERHEAD_ALLOWANCE) {
		log.warning(
			`upload precheck rejected user_id=${user.id} reason=max_file declared_bytes=${declared}`,
		);
		throw new HttpError(413, "file exceeds max file size");
	}
	if (
		usedBytes(state, user.id) + declared >
		perm.quota_bytes + REQUEST_OVERHEAD_ALLOWANCE
	) {
		log.warning(
			`upload precheck rejected user_id=${user.id} reason=user_quota declared_bytes=${declared}`,
		);
		throw new HttpError(413, "upload would exceed your quota");
	}
}

interface FinalizeOpts {
	state: AppState;
	req: Request;
	user: UserRow;
	perm: PermissionRow;
	directory: DirectoryRow | null;
	workPath: string;
	relPath: string;
	stored: number;
	contentType: string | null;
	encryptionMode: string;
	compress: boolean;
	randomizeFilename: boolean;
	originalFilename: string;
	isPermanent: boolean;
	tempDays: number | null;
	deleteIfIdleDays: number | null;
	archiveAfterIdleDays: number | null;
	autoUnarchiveOnDownload: boolean;
	maxUses: number | null;
	expiresInSeconds: number | null;
	sourceType?: string;
	savedFromFileId?: number | null;
	/**
	 * The bytes in `workPath` are already ciphertext the caller encrypted.
	 *
	 * Only the two browser/API upload routes can honestly claim this, and only
	 * they may target an end-to-end folder. Saying `encryptionMode: "client"` is
	 * not the same claim: every server-side path copies its directory's mode
	 * into that field, so trusting it would let a dropbox link file an anonymous
	 * uploader's plaintext under a mode that promises ciphertext.
	 */
	clientCiphertext?: boolean;
}

/** Mirrors app/routes/files.py::_finalize_stored_file -- quota check, optional
 * compression, DB record, optional server-side encryption, link minting. */
export async function finalizeStoredFile(
	opts: FinalizeOpts,
): Promise<Record<string, unknown>> {
	const { state, req, user, perm, directory } = opts;
	const { db } = state;
	const basePath = join(storageRoot(), opts.relPath);
	const directoryId = directory ? directory.id : null;

	// A file dropped into a folder is encrypted with whatever protects that
	// folder -- resolved, because the key may sit several levels up. The caller's
	// `encryptionMode` only decides anything for a root-level upload. Callers
	// that pass a directory (dropbox, remote upload, torrent import) therefore
	// can't get this wrong, whatever they pass.
	const dirEff = directory ? resolveDirectoryEncryption(db, directory) : null;
	// End-to-end folders are the one destination the server cannot fill on
	// someone's behalf: it has no key, so it would file plaintext under a mode
	// that promises ciphertext. Only a browser holding the folder's key may
	// upload here, and it says so by passing `client` itself. Everything that
	// finalizes server-side (dropbox, remote upload, torrent import) is refused.
	if (
		dirEff &&
		(dirEff.mode === "client" || dirEff.mode === "sealed") &&
		!opts.clientCiphertext
	) {
		try {
			unlinkSync(opts.workPath);
		} catch {
			// best-effort
		}
		throw new HttpError(
			409,
			"this folder is end-to-end encrypted; it can only be uploaded to from a browser holding its key",
		);
	}
	// The folder's effective mode decides, *except* when the caller both
	// encrypted the bytes itself and said so. A client-mode file is always its
	// own break point (see `overridden` below) and carries no key material at
	// all, so it can legitimately sit inside a `none` or `server` folder without
	// that folder's key describing its bytes -- exactly the shape `POST
	// /files/:id/seal` has been producing all along.
	const requestedClient =
		!!opts.clientCiphertext && opts.encryptionMode === "client";
	const encryptionMode = requestedClient
		? "client"
		: dirEff
			? dirEff.mode
			: opts.encryptionMode;
	// A file in a folder follows that folder's chain rather than pinning its own
	// copy of the key, so re-keying the folder later reaches it. `client` is
	// never inheritable -- only the browser has that key.
	const overridden = directory && encryptionMode !== "client" ? 0 : 1;

	let plainHashes: Awaited<ReturnType<typeof hashFile>>;
	try {
		plainHashes = await hashFile(opts.workPath);
		enforceGlobalUploadCapacity(db, opts.stored);
	} catch (err) {
		try {
			unlinkSync(opts.workPath);
		} catch {
			// best-effort
		}
		log.warning(
			`upload finalize rejected user_id=${user.id} reason=global_storage stored_bytes=${opts.stored}`,
		);
		throw err;
	}

	if (usedBytes(state, user.id) + opts.stored > perm.quota_bytes) {
		try {
			unlinkSync(opts.workPath);
		} catch {
			// best-effort
		}
		log.warning(
			`upload finalize rejected user_id=${user.id} reason=user_quota stored_bytes=${opts.stored}`,
		);
		throw new HttpError(413, "upload would exceed your quota");
	}

	const sizeBytes = opts.stored;
	let fileCompressed = false;
	let current = opts.workPath;

	const cleanupPaths = [
		opts.workPath,
		`${basePath}.zst.work`,
		`${basePath}.fupl.work`,
		basePath,
	];

	try {
		let ct = (opts.contentType || "application/octet-stream")
			.toLowerCase()
			.split(";")[0]!
			.trim();
		if (UNSAFE_CT.has(ct)) ct = "application/octet-stream";

		if (opts.compress && encryptionMode !== "client" && shouldCompress(ct)) {
			const compressed = `${basePath}.zst.work`;
			await compressFile(current, compressed);
			unlinkSync(current);
			current = compressed;
			fileCompressed = true;
		}

		const displayName = opts.randomizeFilename
			? randomizedFilename(opts.originalFilename)
			: opts.originalFilename;
		let expiresAt: string | null = null;
		if (!opts.isPermanent && opts.tempDays) {
			expiresAt = new Date(
				Date.now() + opts.tempDays * 86400 * 1000,
			).toISOString();
		}

		db.run(
			`INSERT INTO files (
         owner_id, directory_id, storage_path, original_filename, source_type,
         saved_from_file_id, size_bytes, stored_size_bytes, content_type, encryption_mode,
         encryption_overridden, compressed, is_permanent, expires_at, delete_if_idle_days,
         archive_after_idle_days, auto_unarchive_on_download, created_at
       ) VALUES ($ownerId, $dirId, $relPath, $displayName, $sourceType, $savedFrom, $size, 0, $ct, $enc,
         $overridden, $compressed, $isPermanent, $expiresAt, $deleteIfIdle, $archiveAfterIdle, $autoUnarchive, $now)`,
			{
				$ownerId: user.id,
				$dirId: directoryId,
				$relPath: opts.relPath,
				$displayName: displayName,
				$sourceType: opts.sourceType ?? "upload",
				$savedFrom: opts.savedFromFileId ?? null,
				$size: sizeBytes,
				$ct: ct,
				$enc: encryptionMode,
				$overridden: overridden,
				$compressed: fileCompressed ? 1 : 0,
				$isPermanent: opts.isPermanent ? 1 : 0,
				$expiresAt: expiresAt,
				$deleteIfIdle: opts.deleteIfIdleDays,
				$archiveAfterIdle: opts.archiveAfterIdleDays,
				$autoUnarchive: opts.autoUnarchiveOnDownload ? 1 : 0,
				$now: nowIso(),
			},
		);
		const fileObj = db.get<FileRow>(
			"SELECT * FROM files WHERE id = last_insert_rowid()",
		)!;

		let encKeyBlobVal: Buffer | null = null;
		let encAccessBlobVal: Buffer | null = null;
		let accessKey: string | null = null;

		if (encryptionMode === "server") {
			const masterKey = getMasterKey(state.settings);
			let perFileKey: Buffer;
			if (dirEff) {
				if (!dirEff.keyBlob) throw new HttpError(500, "directory key missing");
				// Encrypted with the folder chain's key, but not carrying a copy of
				// it: the row inherits (`overridden = 0`) and reads resolve upward.
				perFileKey = openBox(masterKey, Buffer.from(dirEff.keyBlob));
			} else {
				perFileKey = randomBytes(32);
				accessKey = randomBytes(18).toString("base64url");
				encKeyBlobVal = seal(masterKey, perFileKey);
				encAccessBlobVal = seal(masterKey, Buffer.from(accessKey));
			}
			const encrypted = `${basePath}.fupl.work`;
			await encryptFile(perFileKey, current, encrypted);
			unlinkSync(current);
			current = encrypted;
		}

		mkdirSync(join(basePath, ".."), { recursive: true });
		renameSync(current, basePath);
		const storedHashes = await hashFile(basePath);
		const transformKey = `${encryptionMode}:compressed=${fileCompressed ? 1 : 0}`;
		const blob = attachBlob(db, {
			finalPath: basePath,
			relPath: opts.relPath,
			logicalSize: sizeBytes,
			contentType: ct,
			hashes: plainHashes,
			storedHashes,
			transformKey,
		});

		let expiresLink: string | null = null;
		let linkMaxUses = opts.maxUses;
		if (directory) {
			linkMaxUses = null;
			db.run(
				"UPDATE directories SET total_bytes = COALESCE(total_bytes, 0) + $inc WHERE id = $id",
				{
					$inc: sizeBytes,
					$id: directory.id,
				},
			);
		} else if (opts.expiresInSeconds !== null) {
			expiresLink = new Date(
				Date.now() + opts.expiresInSeconds * 1000,
			).toISOString();
		}

		const slug = newSlug();
		db.run(
			`UPDATE files SET blob_id = $blobId, storage_path = $path, stored_size_bytes = $stored,
         enc_key_blob = $encKey, enc_access_blob = $encAccess WHERE id = $id`,
			{
				$blobId: blob.id,
				$path: blob.storage_path,
				$stored: blob.stored_size_bytes,
				$encKey: encKeyBlobVal,
				$encAccess: encAccessBlobVal,
				$id: fileObj.id,
			},
		);
		db.run(
			`INSERT INTO links (file_id, slug, max_uses, use_count, expires_at, active, created_at)
       VALUES ($fileId, $slug, $maxUses, 0, $expiresAt, 1, $now)`,
			{
				$fileId: fileObj.id,
				$slug: slug,
				$maxUses: linkMaxUses,
				$expiresAt: expiresLink,
				$now: nowIso(),
			},
		);

		recordAudit(db, {
			actor: user.username,
			action: "file.uploaded",
			target: `file:${fileObj.id}`,
			ip: clientIp(state, req),
		});
		log.info(
			`upload finalized file_id=${fileObj.id} owner_id=${user.id} stored_bytes=${blob.stored_size_bytes} size_bytes=${sizeBytes} encryption=${encryptionMode} compressed=${fileCompressed} directory_id=${directoryId}`,
		);
		// Best-effort, fire-and-forget cluster replication -- never adds peer
		// round-trip latency to the upload response, and a no-op without any
		// linked peers (see cluster/replication.ts::replicateFile).
		void replicateFile(state, fileObj.id).catch((err) => {
			log.warning(
				`cluster replication failed file_id=${fileObj.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});

		const baseUrl = fileUrl(req, slug);
		return {
			file_id: fileObj.id,
			slug,
			url: baseUrl,
			raw_url: `${baseUrl}/raw`,
			access_key: accessKey,
			encryption_mode: encryptionMode,
			max_uses: opts.maxUses,
			expires_at: expiresLink,
			compressed: fileCompressed,
			source_type: opts.sourceType ?? "upload",
			saved_from_file_id: opts.savedFromFileId ?? null,
		};
	} catch (err) {
		for (const p of cleanupPaths) {
			try {
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort
			}
		}
		log.error(
			`upload finalize failed owner_id=${user.id} rel_path=${opts.relPath} stored_bytes=${opts.stored}`,
		);
		throw err;
	}
}

/** The `?ek=` secret for a server-mode file. Resolved, since a file inside a
 * folder normally has no access blob of its own -- the folder's is the one that
 * opens it (crypto/effectiveEncryption.ts). */
function recoverAccessKey(state: AppState, f: FileRow): string | null {
	return recoverAccessSecret(
		getMasterKey(state.settings),
		resolveFileEncryption(state.db, f),
	);
}

/** Throttled per slug when the file's secret is a password rather than a random
 * token (security/accessLock.ts). */
function verifyFileAccessKey(
	state: AppState,
	f: FileRow,
	ek: string | null,
): AccessCheck {
	const eff = resolveFileEncryption(state.db, f);
	return checkLinkAccess(state, keyScopeOf(eff, `file:${f.id}`), eff, ek, {
		allowMissingSecret: true,
	});
}

// ── chunked upload token helpers ────────────────────────────────────────────

interface ChunkMeta {
	v: number;
	uid: number;
	rel: string;
	total: number;
	cs: number;
	n: number;
	fn: string;
	ct: string | null;
	enc: string;
	cmp: boolean;
	perm: boolean;
	td: number | null;
	did: number | null;
	aaid: number | null;
	auod: boolean;
	rnd: boolean;
	dir: number | null;
	mu: number | null;
	eis: number | null;
	exp: number;
}

function sealChunkToken(state: AppState, meta: ChunkMeta): string {
	const raw = Buffer.from(JSON.stringify(meta));
	return seal(getMasterKey(state.settings), raw, CHUNK_TOKEN_AAD).toString(
		"base64url",
	);
}

function openChunkToken(
	state: AppState,
	token: string,
	user: UserRow,
): ChunkMeta {
	let meta: ChunkMeta;
	try {
		const blob = Buffer.from(token, "base64url");
		meta = JSON.parse(
			openBox(getMasterKey(state.settings), blob, CHUNK_TOKEN_AAD).toString(
				"utf-8",
			),
		);
	} catch {
		throw new HttpError(400, "invalid upload token");
	}
	if (meta.uid !== user.id) throw new HttpError(403, "not your upload");
	if (meta.exp < Date.now() / 1000) {
		try {
			rmSync(partsDir(meta.rel), { recursive: true, force: true });
			unlinkSync(`${join(storageRoot(), meta.rel)}.part`);
		} catch {
			// best-effort
		}
		throw new HttpError(410, "upload session expired");
	}
	return meta;
}

/** Exported for reuse by dropbox.ts. */
export function chunkUploadSize(): number {
	const raw = process.env.FILEUPLOAD_CHUNK_SIZE;
	if (raw) {
		const v = Number(raw);
		if (v > 0) return v;
	}
	return CHUNK_UPLOAD_SIZE;
}

/** Exported for reuse by dropbox.ts. */
export function partsDir(relPath: string): string {
	return `${join(storageRoot(), relPath)}.parts`;
}

/** Exported for reuse by dropbox.ts. */
export function numChunks(total: number, chunkSize: number): number {
	if (total <= 0 || chunkSize <= 0) return 0;
	return Math.ceil(total / chunkSize);
}

/** Exported for reuse by dropbox.ts. */
export function expectedChunkLen(
	index: number,
	total: number,
	chunkSize: number,
	n: number,
): number {
	if (index < 0 || index >= n) return -1;
	if (index < n - 1) return chunkSize;
	return total - (n - 1) * chunkSize;
}

/** Exported for reuse by dropbox.ts. */
export function receivedIndices(parts: string, n: number): number[] {
	const out: number[] = [];
	try {
		for (const entry of readdirSync(parts)) {
			if (/^\d+$/.test(entry)) {
				const i = Number(entry);
				if (i >= 0 && i < n) out.push(i);
			}
		}
	} catch {
		// best-effort
	}
	return out.sort((a, b) => a - b);
}

/** Serializes finalize/abort against each other for a given upload (keyed by
 * its storage rel path) so one request can't delete the `.parts` dir out from
 * under another that's mid-read — the ENOENT race that used to surface as an
 * unhandled 500 and leave an orphaned, unaccounted-for `.part` file on disk. */
const uploadLocks = new Map<string, "finalizing" | "aborting">();

/** Drops chunk dirs / assembly files left behind by abandoned uploads. Exported
 * so jobs/scheduler.ts can run it on an interval, mirroring the APScheduler job. */
export function sweepStaleParts(): void {
	const cutoff = Date.now() / 1000 - CHUNK_SESSION_TTL;
	const root = storageRoot();

	function walk(
		dir: string,
		onEntry: (path: string, isDir: boolean) => void,
	): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (entry.endsWith(".parts")) onEntry(p, true);
				else walk(p, onEntry);
			} else if (entry.endsWith(".part") || entry.endsWith(".work")) {
				onEntry(p, false);
			}
		}
	}

	walk(root, (p, isDir) => {
		try {
			const st = statSync(p);
			if (st.mtimeMs / 1000 < cutoff) {
				if (isDir) rmSync(p, { recursive: true, force: true });
				else unlinkSync(p);
			}
		} catch {
			// best-effort
		}
	});
}

/** Exported for reuse by the directory-children endpoint in directories.ts, so
 * the Drive explorer sees exactly the same file shape whichever level it asks
 * for. (The dependency only runs directories.ts -> files.ts; files.ts takes its
 * tree helpers from directoryTree.ts precisely so the two never import each
 * other.) */
export function serializeFiles(
	state: AppState,
	req: Request,
	files: FileRow[],
): Record<string, unknown>[] {
	const { db } = state;
	const ownerIds = [...new Set(files.map((f) => f.owner_id))];
	const usernameMap = new Map<number, string>();
	if (ownerIds.length) {
		for (const u of db.all<UserRow>(
			`SELECT * FROM users WHERE id IN (${ownerIds.map((_, i) => `$id${i}`).join(",")})`,
			Object.fromEntries(ownerIds.map((id, i) => [`$id${i}`, id])),
		)) {
			usernameMap.set(u.id, u.username);
		}
	}
	// Batch-fetch every file's links in one query instead of one query per file
	// (N+1 -- the admin "all files" listing calls this with every file in the
	// system).
	const fileIds = [...new Set(files.map((f) => f.id))];
	const linksByFile = new Map<number, LinkRow[]>();
	if (fileIds.length) {
		const linkRows = db.all<LinkRow>(
			`SELECT * FROM links WHERE file_id IN (${fileIds.map((_, i) => `$fid${i}`).join(",")})`,
			Object.fromEntries(fileIds.map((id, i) => [`$fid${i}`, id])),
		);
		for (const lk of linkRows) {
			const list = linksByFile.get(lk.file_id);
			if (list) list.push(lk);
			else linksByFile.set(lk.file_id, [lk]);
		}
	}
	return files.map((f) => {
		const links = linksByFile.get(f.id) ?? [];
		// Effective state -- an inheriting file's key lives on the folder above it
		// (crypto/effectiveEncryption.ts); `encryption_overridden` says which.
		const eff = resolveFileEncryption(db, f);
		return {
			id: f.id,
			owner_id: f.owner_id,
			owner_username: usernameMap.get(f.owner_id) ?? `user:${f.owner_id}`,
			blob_id: f.blob_id,
			directory_id: f.directory_id,
			original_filename: f.original_filename,
			source_type: f.source_type,
			saved_from_file_id: f.saved_from_file_id,
			size_bytes: f.size_bytes,
			stored_size_bytes: f.stored_size_bytes,
			hashes: fileHashes(db, f),
			content_type: f.content_type,
			encryption_mode: eff.mode,
			encryption_overridden: !!f.encryption_overridden,
			inherited_from_directory_id: eff.sourceDirectoryId,
			password_locked: eff.passwordLocked,
			// A sealed file's salt is not a secret, and the browser needs it (plus
			// the derivation parameters) to rebuild the key from the password it
			// was sealed with -- the server keeps nothing that could do it for us.
			seal_salt: f.seal_salt
				? Buffer.from(f.seal_salt).toString("base64url")
				: null,
			seal_kdf: f.seal_salt ? sealKdfId() : null,
			compressed: !!f.compressed,
			archived: !!f.archived,
			lifecycle_state: f.lifecycle_state,
			archive_original_stored_size_bytes: f.archive_original_stored_size_bytes,
			archive_saved_bytes: f.archive_saved_bytes,
			is_permanent: !!f.is_permanent,
			expires_at: f.expires_at,
			last_downloaded_at: f.last_downloaded_at,
			access_key: recoverAccessKey(state, f),
			created_at: f.created_at,
			links: links.map((lk) => ({
				id: lk.id,
				slug: lk.slug,
				max_uses: lk.max_uses,
				use_count: lk.use_count,
				expires_at: lk.expires_at,
				active: !!lk.active,
				hide_uploader: !!lk.hide_uploader,
			})),
		};
	});
}

/** Everything that has to happen when a file row goes away: its links, the
 * containing folder's byte tally, the blob reference, the thumbnail cache
 * (keyed by file id and *not* ref-counted -- see CLAUDE.md) and finally the
 * row. Returns nothing; the physical unlink is queued internally. */
export function purgeFile(state: AppState, fileObj: FileRow): void {
	const { db } = state;
	db.run("DELETE FROM links WHERE file_id = $id", { $id: fileObj.id });
	if (fileObj.directory_id !== null) {
		db.run(
			"UPDATE directories SET total_bytes = MAX(0, COALESCE(total_bytes, 0) - $dec) WHERE id = $id",
			{ $dec: fileObj.size_bytes ?? 0, $id: fileObj.directory_id },
		);
	}
	const unlinkAfterCommit = [releaseBlob(db, fileObj)];
	db.run("DELETE FROM files WHERE id = $id", { $id: fileObj.id });
	deleteThumbnail(fileObj.id);
	unlinkQueued(unlinkAfterCommit);
}

function boolField(v: unknown, dflt: boolean): boolean {
	if (v === undefined || v === null || v === "") return dflt;
	return v === "true" || v === "1" || v === true;
}
function intField(v: unknown): number | null {
	if (v === undefined || v === null || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Mirrors app/routes/files.py. */
export function filesRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	// ── single-shot multipart upload ──────────────────────────────────────
	// A generous streaming safety net -- the exact per-user max_file_bytes check
	// only runs once every form field has arrived (see below), which may be
	// after the file field for browser-built multipart bodies.
	const ABSOLUTE_UPLOAD_CEILING = 20 * 1024 * 1024 * 1024; // 20 GiB

	router.post("/upload", getUploadUser(state), (req, res, next) => {
		const user = req.currentUser!;
		if (state.haltRegistry.activeUntil(user.id) !== null) {
			res.status(503).json({
				detail:
					"uploads are temporarily halted on this cluster; try again shortly",
			});
			return;
		}
		const bb = busboy({
			headers: req.headers,
			limits: { fileSize: ABSOLUTE_UPLOAD_CEILING },
		});
		const fields: Record<string, string> = {};
		let handled = false;
		let fileSeen = false;

		let work: string | null = null;
		let relPath = "";
		let stored = 0;
		let contentType: string | null = null;
		let originalFilenameFromStream = "upload";
		let fileWriteDone: Promise<void> | null = null;
		let fileTruncated = false;

		bb.on("field", (name, value) => {
			fields[name] = value;
		});

		bb.on("file", (_name, stream, info) => {
			fileSeen = true;
			contentType = info.mimeType || null;
			originalFilenameFromStream = info.filename || "upload";

			const rand = randomBytes(32).toString("hex");
			relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
			const basePath = join(storageRoot(), relPath);
			mkdirSync(join(basePath, ".."), { recursive: true });
			work = `${basePath}.work`;
			const workPath = work;

			const out = createWriteStream(workPath);
			stream.on("data", (chunk: Buffer) => {
				stored += chunk.length;
				out.write(chunk);
			});
			stream.on("limit", () => {
				fileTruncated = true;
			});
			fileWriteDone = new Promise((resolve, reject) => {
				stream.on("end", () => out.end(() => resolve()));
				stream.on("error", (err) => {
					out.destroy();
					reject(err instanceof Error ? err : new Error(String(err)));
				});
			});
		});

		bb.on("close", () => {
			if (handled) return;
			if (!fileSeen || !work || !fileWriteDone) {
				res.status(400).json({ detail: "no file uploaded" });
				return;
			}
			handled = true;
			const workPath = work;

			fileWriteDone
				.then(async () => {
					if (fileTruncated)
						throw new HttpError(413, "file exceeds max file size");
					const prepared = prepareUpload(state, user, {
						encryptionMode: fields.encryption_mode || "none",
						compress: boolField(fields.compress, false),
						isPermanent: boolField(fields.is_permanent, true),
						tempDays: intField(fields.temp_days),
						randomizeFilename: boolField(fields.randomize_filename, false),
						directoryId: intField(fields.directory_id),
						// Matches the `clientCiphertext: true` this same route passes
						// to finalizeStoredFile below: whatever arrived here is what
						// the uploader produced.
						clientCiphertext: true,
					});
					const hasLifecycleOptions =
						!prepared.isPermanent ||
						prepared.tempDays !== null ||
						intField(fields.delete_if_idle_days) !== null ||
						intField(fields.archive_after_idle_days) !== null ||
						boolField(fields.auto_unarchive_on_download, true) !== true;
					if (hasLifecycleOptions && !prepared.perm.can_manage_lifecycle) {
						throw new HttpError(403, "lifecycle options not permitted");
					}
					if (stored > prepared.perm.max_file_bytes) {
						throw new HttpError(413, "file exceeds max file size");
					}
					precheckDeclaredSize(state, user, prepared.perm, stored);

					return finalizeStoredFile({
						state,
						req,
						user,
						perm: prepared.perm,
						directory: prepared.directory,
						// Whatever arrived on this route is what the uploader produced;
						// for an end-to-end folder that has to be ciphertext already.
						clientCiphertext: true,
						workPath,
						relPath,
						stored,
						contentType,
						encryptionMode: prepared.encryptionMode,
						compress: prepared.compress,
						randomizeFilename: prepared.randomizeFilename,
						originalFilename:
							fields.original_filename || originalFilenameFromStream,
						isPermanent: prepared.isPermanent,
						tempDays: prepared.tempDays,
						deleteIfIdleDays: intField(fields.delete_if_idle_days),
						archiveAfterIdleDays: intField(fields.archive_after_idle_days),
						autoUnarchiveOnDownload: boolField(
							fields.auto_unarchive_on_download,
							true,
						),
						maxUses: intField(fields.max_uses),
						expiresInSeconds: intField(fields.expires_in_seconds),
					});
				})
				.then((result) => res.json(result))
				.catch((err) => {
					try {
						if (existsSync(workPath)) unlinkSync(workPath);
					} catch {
						// best-effort
					}
					respondError(res, err);
				});
		});
		bb.on("error", (err) => next(err));
		req.pipe(bb);
	});

	// ── chunked uploads ──────────────────────────────────────────────────
	router.post("/upload/init", getUploadUser(state), (req, res) => {
		try {
			const user = req.currentUser!;
			checkUploadHalt(state, user.id);
			const body = req.body ?? {};
			const prepared = prepareUpload(state, user, {
				encryptionMode: body.encryption_mode || "none",
				compress: !!body.compress,
				isPermanent: body.is_permanent !== false,
				tempDays: body.temp_days ?? null,
				randomizeFilename: !!body.randomize_filename,
				directoryId: body.directory_id ?? null,
				// As above: the chunked route also finalizes with
				// `clientCiphertext: true`, so the two halves must agree.
				clientCiphertext: true,
			});
			const hasLifecycleOptions =
				!prepared.isPermanent ||
				prepared.tempDays !== null ||
				body.delete_if_idle_days != null ||
				body.archive_after_idle_days != null ||
				(body.auto_unarchive_on_download ?? true) !== true;
			if (hasLifecycleOptions && !prepared.perm.can_manage_lifecycle) {
				res.status(403).json({ detail: "lifecycle options not permitted" });
				return;
			}
			const totalSize = Number(body.total_size ?? 0);
			precheckDeclaredSize(state, user, prepared.perm, totalSize);

			const chunkSize = chunkUploadSize();
			const n = numChunks(totalSize, chunkSize);
			const rand = randomBytes(32).toString("hex");
			const relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
			mkdirSync(join(storageRoot(), rand.slice(0, 2), rand.slice(2, 4)), {
				recursive: true,
			});
			mkdirSync(partsDir(relPath), { recursive: true });

			const meta: ChunkMeta = {
				v: 1,
				uid: user.id,
				rel: relPath,
				total: totalSize,
				cs: chunkSize,
				n,
				fn: String(body.original_filename ?? "upload"),
				ct: body.content_type ?? null,
				enc: prepared.encryptionMode,
				cmp: prepared.compress,
				perm: prepared.isPermanent,
				td: prepared.tempDays,
				did: body.delete_if_idle_days ?? null,
				aaid: body.archive_after_idle_days ?? null,
				auod: body.auto_unarchive_on_download ?? true,
				rnd: prepared.randomizeFilename,
				dir: prepared.directory ? prepared.directory.id : null,
				mu: body.max_uses ?? null,
				eis: body.expires_in_seconds ?? null,
				exp: Math.floor(Date.now() / 1000) + CHUNK_SESSION_TTL,
			};
			log.info(
				`chunked upload initialized user_id=${user.id} total_bytes=${totalSize} chunks=${n} chunk_size=${chunkSize} encryption=${prepared.encryptionMode} directory_id=${meta.dir}`,
			);
			res.json({
				upload_id: sealChunkToken(state, meta),
				chunk_size: chunkSize,
				num_chunks: n,
				total: totalSize,
				received: [],
			});
		} catch (err) {
			respondError(res, err);
		}
	});

	router.get("/upload/status", getUploadUser(state), (req, res) => {
		try {
			const user = req.currentUser!;
			const meta = openChunkToken(
				state,
				String(req.query.upload_id ?? ""),
				user,
			);
			const parts = partsDir(meta.rel);
			if (!existsSync(parts)) {
				res.status(410).json({ detail: "upload session gone" });
				return;
			}
			res.json({
				upload_id: req.query.upload_id,
				total: meta.total,
				chunk_size: meta.cs,
				num_chunks: meta.n,
				received: receivedIndices(parts, meta.n),
			});
		} catch (err) {
			respondError(res, err);
		}
	});

	router.post("/upload/chunk", getUploadUser(state), (req, res, next) => {
		let meta: ChunkMeta;
		try {
			const user = req.currentUser!;
			meta = openChunkToken(state, String(req.query.upload_id ?? ""), user);
		} catch (err) {
			respondError(res, err);
			return;
		}
		const parts = partsDir(meta.rel);
		if (!existsSync(parts)) {
			res.status(410).json({ detail: "upload session gone" });
			return;
		}
		const index = Number(req.query.index);
		const expected = expectedChunkLen(index, meta.total, meta.cs, meta.n);
		if (expected < 0) {
			res.status(400).json({ detail: "invalid chunk index" });
			return;
		}
		const tmp = join(parts, `${index}.${randomBytes(8).toString("hex")}.tmp`);
		const out = createWriteStream(tmp);
		let written = 0;
		let handled = false;
		req.on("data", (chunk: Buffer) => {
			written += chunk.length;
			if (written > expected) {
				handled = true;
				out.destroy();
				try {
					unlinkSync(tmp);
				} catch {
					// best-effort
				}
				res.status(413).json({ detail: "chunk exceeds expected size" });
				req.destroy();
				return;
			}
			out.write(chunk);
		});
		req.on("end", () => {
			if (handled) return;
			out.end(() => {
				if (handled) return;
				if (written !== expected) {
					try {
						unlinkSync(tmp);
					} catch {
						// best-effort
					}
					res.status(400).json({ detail: "incomplete chunk" });
					return;
				}
				renameSync(tmp, join(parts, String(index)));
				res.json({ index, num_chunks: meta.n });
			});
		});
		req.on("error", (err) => {
			handled = true;
			out.destroy();
			try {
				unlinkSync(tmp);
			} catch {
				// best-effort
			}
			next(err);
		});
	});

	router.post(
		"/upload/finalize",
		getUploadUser(state),
		asyncHandler(async (req, res) => {
			let relPath: string | null = null;
			let work: string | null = null;
			try {
				const user = req.currentUser!;
				const uploadId = String(req.body?.upload_id ?? "");
				const meta = openChunkToken(state, uploadId, user);
				relPath = meta.rel;
				const parts = partsDir(relPath);
				if (!existsSync(parts)) {
					res.status(410).json({ detail: "upload session gone" });
					return;
				}
				if (uploadLocks.has(relPath)) {
					res.status(409).json({ detail: "upload busy, retry shortly" });
					return;
				}
				uploadLocks.set(relPath, "finalizing");

				const received = new Set(receivedIndices(parts, meta.n));
				const missing: number[] = [];
				for (let i = 0; i < meta.n; i++) if (!received.has(i)) missing.push(i);
				if (missing.length) {
					log.info(
						`chunked upload finalize incomplete user_id=${user.id} missing_count=${missing.length}`,
					);
					res.status(409).json({
						detail: {
							error: "upload incomplete",
							missing: missing.slice(0, 512),
						},
					});
					return;
				}

				work = `${join(storageRoot(), relPath)}.part`;
				const out = createWriteStream(work);
				try {
					for (let i = 0; i < meta.n; i++) {
						const chunkPath = join(parts, String(i));
						await new Promise<void>((resolve, reject) => {
							const rs = createReadStream(chunkPath);
							rs.on("error", reject);
							rs.on("end", resolve);
							rs.pipe(out, { end: false });
						});
					}
				} catch (err) {
					out.destroy();
					// The parts dir vanished mid-read — almost always a concurrent abort
					// won the race despite the lock above (e.g. an abort that slipped in
					// between the existsSync check and the lock being set). Report it as
					// a clean, expected failure rather than a 500.
					if (!existsSync(parts)) {
						res.status(410).json({ detail: "upload session gone" });
						return;
					}
					throw err;
				}
				await new Promise<void>((resolve) => out.end(resolve));
				const stored = statSync(work).size;
				if (stored !== meta.total) {
					unlinkSync(work);
					res.status(400).json({ detail: "assembled size mismatch" });
					return;
				}

				let directory: DirectoryRow | null = null;
				if (meta.dir !== null) {
					directory =
						db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", {
							$id: meta.dir,
						}) ?? null;
					if (!directory) {
						unlinkSync(work);
						res.status(404).json({ detail: "directory not found" });
						return;
					}
					if (!canEditDirectory(state, directory.id, user)) {
						unlinkSync(work);
						res.status(403).json({ detail: "not your directory" });
						return;
					}
				}

				const perm = ensurePermissions(db, user.id, {
					master: user.role === "master",
				});
				const result = await finalizeStoredFile({
					state,
					req,
					user,
					perm,
					directory,
					clientCiphertext: true,
					workPath: work,
					relPath,
					stored,
					contentType: meta.ct,
					encryptionMode: meta.enc,
					compress: meta.cmp,
					randomizeFilename: meta.rnd,
					originalFilename: meta.fn,
					isPermanent: meta.perm,
					tempDays: meta.td,
					deleteIfIdleDays: meta.did,
					archiveAfterIdleDays: meta.aaid,
					autoUnarchiveOnDownload: meta.auod,
					maxUses: meta.mu,
					expiresInSeconds: meta.eis,
				});
				await rm(parts, { recursive: true, force: true });
				log.info(
					`chunked upload finalized user_id=${user.id} total_bytes=${meta.total} chunks=${meta.n}`,
				);
				res.json(result);
			} catch (err) {
				// Never leave a partially-assembled `.part` file behind on failure —
				// that debris counts toward real disk usage but never becomes a
				// `content_blobs` row, so it silently inflates disk use past what
				// /api/files/usage reports until the (up to 12h-delayed) stale-part
				// sweep catches it.
				if (work) {
					try {
						unlinkSync(work);
					} catch {
						// best-effort
					}
				}
				respondError(res, err);
			} finally {
				if (relPath) uploadLocks.delete(relPath);
			}
		}),
	);

	router.delete("/upload", getUploadUser(state), (req, res) => {
		let relPath: string | null = null;
		try {
			const user = req.currentUser!;
			const meta = openChunkToken(
				state,
				String(req.query.upload_id ?? ""),
				user,
			);
			relPath = meta.rel;
			if (uploadLocks.get(relPath) === "finalizing") {
				res.status(409).json({ detail: "finalize in progress, retry shortly" });
				relPath = null; // don't clear a lock we don't own
				return;
			}
			uploadLocks.set(relPath, "aborting");
			rmSync(partsDir(meta.rel), { recursive: true, force: true });
			try {
				unlinkSync(`${join(storageRoot(), meta.rel)}.part`);
			} catch {
				// best-effort
			}
			log.info(
				`chunked upload aborted user_id=${user.id} total_bytes=${meta.total}`,
			);
			res.json({ status: "aborted" });
		} catch (err) {
			respondError(res, err);
		} finally {
			if (relPath) uploadLocks.delete(relPath);
		}
	});

	// ── save / list / delete / links ────────────────────────────────────
	router.post(
		"/:slug/save",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const link = resolveActiveLink(db, req.params.slug);
			if (!link) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const source = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: link.file_id,
			});
			if (!source) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (source.owner_id === user.id) {
				res.status(409).json({ detail: "you own this file" });
				return;
			}
			const already = db.get<FileRow>(
				"SELECT * FROM files WHERE owner_id = $uid AND saved_from_file_id = $fid",
				{
					$uid: user.id,
					$fid: source.id,
				},
			);
			if (already) {
				res.status(409).json({ detail: "already saved" });
				return;
			}
			const ek = typeof req.query.ek === "string" ? req.query.ek : null;
			const access = verifyFileAccessKey(state, source, ek);
			if (!access.ok) {
				res.status(access.status).json({ detail: access.detail });
				return;
			}
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (usedBytes(state, user.id) + source.size_bytes > perm.quota_bytes) {
				res.status(413).json({ detail: "save would exceed your quota" });
				return;
			}
			if (!consumeUse(db, req.params.slug)) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const sourceEff = resolveFileEncryption(db, source);
			if (source.blob_id) {
				db.run(
					"UPDATE content_blobs SET ref_count = ref_count + 1 WHERE id = $id",
					{ $id: source.blob_id },
				);
			}
			db.run(
				`INSERT INTO files (
         owner_id, directory_id, blob_id, storage_path, original_filename, source_type,
         saved_from_file_id, size_bytes, stored_size_bytes, content_type, encryption_mode,
         enc_key_blob, enc_access_blob, access_is_password, seal_salt, compressed, archived,
         archive_codec, archive_original_stored_size_bytes, archive_saved_bytes,
         archive_after_idle_days, lifecycle_state, is_permanent, delete_if_idle_days,
         auto_unarchive_on_download, created_at
       ) VALUES ($ownerId, NULL, $blobId, $path, $filename, 'saved', $savedFrom, $size, $storedSize, $ct, $enc,
         $encKey, $encAccess, $isPassword, $sealSalt, $compressed, $archived, $archiveCodec,
         $archiveOrigStored, $archiveSaved, $archiveAfterIdle, $lifecycle, 1, $deleteIfIdle,
         $autoUnarchive, $now)`,
				{
					$ownerId: user.id,
					$blobId: source.blob_id,
					$path: source.storage_path,
					$filename: source.original_filename,
					$savedFrom: source.id,
					$size: source.size_bytes,
					$storedSize: source.stored_size_bytes,
					$ct: source.content_type,
					// The copy lands at the root as its own break point, so it needs
					// the source's *resolved* key -- the source's own columns are NULL
					// whenever it inherits from the folder it sits in.
					$enc: sourceEff.mode,
					$encKey: sourceEff.keyBlob ? Buffer.from(sourceEff.keyBlob) : null,
					$encAccess: sourceEff.accessBlob
						? Buffer.from(sourceEff.accessBlob)
						: null,
					$isPassword: sourceEff.passwordLocked ? 1 : 0,
					// A password-sealed file's salt is how the recipient rederives the
					// key. It is not a secret, and without it the saved copy is
					// permanently unopenable even by someone who knows the password.
					$sealSalt: source.seal_salt ? Buffer.from(source.seal_salt) : null,
					$compressed: source.compressed,
					$archived: source.archived,
					$archiveCodec: source.archive_codec,
					$archiveOrigStored: source.archive_original_stored_size_bytes,
					$archiveSaved: source.archive_saved_bytes,
					$archiveAfterIdle: source.archive_after_idle_days,
					$lifecycle: source.lifecycle_state,
					$deleteIfIdle: source.delete_if_idle_days,
					$autoUnarchive: source.auto_unarchive_on_download,
					$now: nowIso(),
				},
			);
			const saved = db.get<FileRow>(
				"SELECT * FROM files WHERE id = last_insert_rowid()",
			)!;
			const newLinkSlug = newSlug();
			db.run(
				"INSERT INTO links (file_id, slug, use_count, active, created_at) VALUES ($fid, $slug, 0, 1, $now)",
				{
					$fid: saved.id,
					$slug: newLinkSlug,
					$now: nowIso(),
				},
			);
			recordAudit(db, {
				actor: user.username,
				action: "file.saved",
				target: `file:${source.id}->file:${saved.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`shared file saved source_file_id=${source.id} saved_file_id=${saved.id} owner_id=${user.id} blob_id=${saved.blob_id}`,
			);
			const base = fileUrl(req, newLinkSlug);
			res.json({
				file_id: saved.id,
				slug: newLinkSlug,
				url: base,
				raw_url: `${base}/raw`,
				saved_from_file_id: source.id,
				source_type: "saved",
				blob_id: saved.blob_id,
				encryption_mode: resolveFileEncryption(db, saved).mode,
				access_key: recoverAccessKey(state, saved),
			});
		},
	);

	/**
	 * Duplicate one of your own files into a folder (or the root).
	 *
	 * This is the same primitive `POST /:slug/save` is built on — bump the
	 * blob's `ref_count`, insert a row carrying the *resolved* encryption, mint
	 * a link — minus the "you may not own the source" rule that makes save a
	 * save. No bytes are written and no new disk is consumed, which is why the
	 * global capacity check `finalizeStoredFile` runs is deliberately absent
	 * here; only the per-user logical quota applies.
	 */
	router.post(
		"/:fileId(\\d+)/copy",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		requirePermission(state, "can_upload"),
		(req, res) => {
			const user = req.currentUser!;
			const source = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!source) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(source, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}

			const body = req.body ?? {};
			const rawTarget = body.directory_id;
			let target: DirectoryRow | null = null;
			if (rawTarget !== null && rawTarget !== "" && rawTarget !== undefined) {
				const parsed = Number(rawTarget);
				if (!Number.isInteger(parsed)) {
					res.status(400).json({ detail: "invalid directory_id" });
					return;
				}
				target = getDirectory(db, parsed);
				if (!target) {
					res.status(404).json({ detail: "target directory not found" });
					return;
				}
				if (!canEditDirectory(state, parsed, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
			}

			const targetEff = target ? resolveDirectoryEncryption(db, target) : null;
			// Same refusal as an upload into an end-to-end folder, for the same
			// reason: the server holds no key for it, so it cannot decide whether
			// the copy inherits or becomes a break point without lying about one of
			// them. Doing this properly is a browser-side operation.
			if (
				targetEff &&
				(targetEff.mode === "client" || targetEff.mode === "sealed")
			) {
				res.status(409).json({
					detail:
						"this folder is end-to-end encrypted; copying into it isn't supported",
				});
				return;
			}

			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (usedBytes(state, user.id) + source.size_bytes > perm.quota_bytes) {
				res.status(413).json({ detail: "copy would exceed your quota" });
				return;
			}

			// The copy carries the source's *resolved* key, because the source's own
			// columns are NULL whenever it inherits. It can only go on inheriting if
			// the destination resolves to byte-identical material; otherwise it
			// becomes its own break point, since inheriting would relabel bytes the
			// destination's key doesn't describe.
			const eff = resolveFileEncryption(db, source);
			const inherits =
				targetEff !== null &&
				targetEff.mode === eff.mode &&
				blobsEqual(targetEff.keyBlob, eff.keyBlob);

			const newLinkSlug = newSlug();
			let copyId = 0;
			db.transaction(() => {
				if (source.blob_id) {
					db.run(
						"UPDATE content_blobs SET ref_count = ref_count + 1 WHERE id = $id",
						{ $id: source.blob_id },
					);
				}
				db.run(
					`INSERT INTO files (
         owner_id, directory_id, blob_id, storage_path, original_filename, source_type,
         size_bytes, stored_size_bytes, content_type, encryption_mode, enc_key_blob,
         enc_access_blob, access_is_password, encryption_overridden, seal_salt, compressed,
         archived, archive_codec, archive_original_stored_size_bytes, archive_saved_bytes,
         archive_after_idle_days, lifecycle_state, is_permanent, delete_if_idle_days,
         auto_unarchive_on_download, created_at
       ) VALUES ($ownerId, $dirId, $blobId, $path, $filename, $sourceType, $size, $storedSize,
         $ct, $enc, $encKey, $encAccess, $isPassword, $overridden, $sealSalt, $compressed,
         $archived, $archiveCodec, $archiveOrigStored, $archiveSaved, $archiveAfterIdle,
         $lifecycle, $isPermanent, $deleteIfIdle, $autoUnarchive, $now)`,
					{
						$ownerId: user.id,
						$dirId: target ? target.id : null,
						$blobId: source.blob_id,
						$path: source.storage_path,
						$filename: source.original_filename,
						$sourceType: source.source_type,
						$size: source.size_bytes,
						$storedSize: source.stored_size_bytes,
						$ct: source.content_type,
						$enc: eff.mode,
						$encKey: inherits || !eff.keyBlob ? null : Buffer.from(eff.keyBlob),
						$encAccess:
							inherits || !eff.accessBlob ? null : Buffer.from(eff.accessBlob),
						$isPassword: !inherits && eff.passwordLocked ? 1 : 0,
						$overridden: inherits ? 0 : 1,
						// Not a secret, and without it a password-sealed copy is
						// permanently unopenable even by someone who knows the password.
						$sealSalt: source.seal_salt ? Buffer.from(source.seal_salt) : null,
						$compressed: source.compressed,
						$archived: source.archived,
						$archiveCodec: source.archive_codec,
						$archiveOrigStored: source.archive_original_stored_size_bytes,
						$archiveSaved: source.archive_saved_bytes,
						$archiveAfterIdle: source.archive_after_idle_days,
						$lifecycle: source.lifecycle_state,
						$isPermanent: source.is_permanent,
						$deleteIfIdle: source.delete_if_idle_days,
						$autoUnarchive: source.auto_unarchive_on_download,
						$now: nowIso(),
					},
				);
				copyId = db.get<FileRow>(
					"SELECT * FROM files WHERE id = last_insert_rowid()",
				)!.id;
				if (target) {
					db.run(
						"UPDATE directories SET total_bytes = COALESCE(total_bytes, 0) + $inc WHERE id = $id",
						{ $inc: source.size_bytes ?? 0, $id: target.id },
					);
				}
				db.run(
					"INSERT INTO links (file_id, slug, use_count, active, created_at) VALUES ($fid, $slug, 0, 1, $now)",
					{ $fid: copyId, $slug: newLinkSlug, $now: nowIso() },
				);
			});
			const copy = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: copyId,
			})!;

			recordAudit(db, {
				actor: user.username,
				action: "file.copied",
				target: `file:${source.id}->file:${copy.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`file copied source_file_id=${source.id} copy_file_id=${copy.id} owner_id=${user.id} directory_id=${copy.directory_id}`,
			);
			// Fire-and-forget, exactly as the upload path does it: a peer round-trip
			// must not sit in front of the response.
			void replicateFile(state, copy.id).catch((err) => {
				log.warning(
					`cluster replication failed file_id=${copy.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
			res.json(serializeFiles(state, req, [copy])[0]!);
		},
	);

	router.get("/", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const files = db.all<FileRow>(
			"SELECT * FROM files WHERE directory_id IS NULL AND owner_id = $id ORDER BY created_at DESC",
			{ $id: user.id },
		);
		res.json({ files: serializeFiles(state, req, files) });
	});

	router.get(
		"/batch-zip",
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const rawIds = req.query.ids;
			const ids = (
				Array.isArray(rawIds) ? rawIds : rawIds !== undefined ? [rawIds] : []
			)
				.map((v) => Number(v))
				.filter((n) => Number.isFinite(n));
			if (!ids.length) {
				res.status(400).json({ detail: "no file ids given" });
				return;
			}
			const wanted = [...new Set(ids)];
			if (wanted.length > 500) {
				res
					.status(400)
					.json({ detail: "too many files in one batch (max 500)" });
				return;
			}
			const files = db.all<FileRow>(
				`SELECT * FROM files WHERE id IN (${wanted.map((_, i) => `$id${i}`).join(",")})`,
				Object.fromEntries(wanted.map((id, i) => [`$id${i}`, id])),
			);
			const byId = new Map(files.map((f) => [f.id, f]));
			const isMaster = user.role === "master";
			const selected: FileRow[] = [];
			for (const fid of wanted) {
				const f = byId.get(fid);
				if (!f) continue;
				if (!isMaster && f.owner_id !== user.id) {
					res.status(403).json({ detail: `not your file: ${fid}` });
					return;
				}
				// Neither can be decrypted server-side, so zipping them would bundle
				// ciphertext nobody asked for.
				const zipMode = resolveFileEncryption(db, f).mode;
				if (zipMode === "client" || zipMode === "sealed") continue;
				selected.push(f);
			}
			if (!selected.length) {
				res.status(404).json({ detail: "no downloadable files in selection" });
				return;
			}

			res.setHeader("Content-Type", "application/zip");
			res.setHeader("Content-Disposition", 'attachment; filename="files.zip"');
			const archive = new ZipArchive({ store: true });
			archive.on("error", (err: Error) => {
				if (!res.headersSent) res.status(500).json({ detail: "zip failed" });
				else res.destroy();
				log.error(`batch-zip failed: ${err.message}`);
			});
			archive.pipe(res);

			const masterKey = getMasterKey(state.settings);
			const seen = new Set<string>();
			const cleanup: string[] = [];
			try {
				for (const f of selected) {
					const name = safeArcname(f.original_filename, seen);
					const [src, isTemp] = await memberSource(db, masterKey, f);
					if (isTemp) cleanup.push(src);
					archive.file(src, { name });
				}
				recordAudit(db, {
					actor: user.username,
					action: "files.batch_downloaded",
					target: `files:${selected.length}`,
					ip: clientIp(state, req),
				});
				await archive.finalize();
			} finally {
				for (const p of cleanup) {
					try {
						unlinkSync(p);
					} catch {
						// best-effort
					}
				}
			}
		}),
	);

	router.get("/disk-stats", requireMaster(state), (_req, res) => {
		const totalBytes = usedStorageBytes(db);
		const totalFiles = db.get<{ n: number }>(
			"SELECT COUNT(*) as n FROM files",
		)!.n;
		const totalLinks = db.get<{ n: number }>(
			"SELECT COUNT(*) as n FROM links WHERE active = 1",
		)!.n;
		const totalUsers = db.get<{ n: number }>(
			"SELECT COUNT(*) as n FROM users",
		)!.n;
		res.json({
			total_bytes: totalBytes,
			total_files: totalFiles,
			total_links: totalLinks,
			total_users: totalUsers,
		});
	});

	router.get("/usage", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const perm = ensurePermissions(db, user.id, {
			master: user.role === "master",
		});
		res.json({
			used_bytes: usedBytes(state, user.id),
			quota_bytes: perm.quota_bytes,
			max_file_bytes: perm.max_file_bytes,
		});
	});

	/** Whoever may edit a file's placement: its owner, a master, or an editor of
	 * the folder it currently sits in (which now includes editors of any folder
	 * above that one). */
	function canEditFile(f: FileRow, user: UserRow): boolean {
		if (user.role === "master" || f.owner_id === user.id) return true;
		if (f.directory_id === null) return false;
		return canEditDirectory(state, f.directory_id, user);
	}

	/** Rename. Only the display name changes -- storage is content-addressed and
	 * never named after the upload (see CLAUDE.md, "File storage"). */
	router.patch(
		"/:fileId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(fileObj, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const raw = req.body?.original_filename;
			if (typeof raw !== "string" || !raw.trim()) {
				res.status(400).json({ detail: "original_filename is required" });
				return;
			}
			// Strip any path the caller tried to smuggle in: this string ends up in
			// Content-Disposition and in zip member names.
			const name = basename(raw.replace(/\\/g, "/")).trim().slice(0, 512);
			if (!name || name === "." || name === "..") {
				res.status(400).json({ detail: "invalid filename" });
				return;
			}
			db.run("UPDATE files SET original_filename = $name WHERE id = $id", {
				$name: name,
				$id: fileObj.id,
			});
			recordAudit(db, {
				actor: user.username,
				action: "file.renamed",
				target: `file:${fileObj.id}`,
				ip: clientIp(state, req),
			});
			const updated = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: fileObj.id,
			})!;
			res.json(serializeFiles(state, req, [updated])[0]!);
		},
	);

	/** Move a file between folders. `directory_id: null` puts it at the root. */
	router.patch(
		"/:fileId(\\d+)/move",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(fileObj, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const body = req.body ?? {};
			if (!("directory_id" in body)) {
				res.status(400).json({ detail: "directory_id is required" });
				return;
			}
			const raw = body.directory_id;
			let targetId: number | null = null;
			if (raw !== null && raw !== "" && raw !== undefined) {
				const parsed = Number(raw);
				if (!Number.isInteger(parsed)) {
					res.status(400).json({ detail: "invalid directory_id" });
					return;
				}
				if (!getDirectory(db, parsed)) {
					res.status(404).json({ detail: "target directory not found" });
					return;
				}
				if (!canEditDirectory(state, parsed, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
				targetId = parsed;
			} else if (user.role !== "master" && fileObj.owner_id !== user.id) {
				// Moving to the root takes the file out of every folder the mover
				// has rights through, so only its owner may do that.
				res.status(403).json({ detail: "not your file" });
				return;
			}
			if (targetId === fileObj.directory_id) {
				res.json(serializeFiles(state, req, [fileObj])[0]!);
				return;
			}

			// The file keeps the key its bytes are already encrypted under, and
			// re-encrypting to match the destination folder is an explicit action
			// (PATCH /files/:id/encryption, phase 6), not a side effect of moving.
			// `encryption_overridden = 1` records that -- which means an inheriting
			// file has to materialize the key it was resolving to first, since the
			// move is precisely what cuts it off from the folder that held it.
			const eff = resolveFileEncryption(db, fileObj);
			db.transaction(() => {
				if (fileObj.directory_id !== null) {
					db.run(
						"UPDATE directories SET total_bytes = MAX(0, COALESCE(total_bytes, 0) - $dec) WHERE id = $id",
						{ $dec: fileObj.size_bytes ?? 0, $id: fileObj.directory_id },
					);
				}
				if (targetId !== null) {
					db.run(
						"UPDATE directories SET total_bytes = COALESCE(total_bytes, 0) + $inc WHERE id = $id",
						{ $inc: fileObj.size_bytes ?? 0, $id: targetId },
					);
				}
				db.run(
					`UPDATE files SET directory_id = $dir, encryption_overridden = 1,
             encryption_mode = $mode, enc_key_blob = $key, enc_access_blob = $access,
             access_is_password = $isPassword WHERE id = $id`,
					{
						$dir: targetId,
						$mode: eff.mode,
						$key: eff.keyBlob ? Buffer.from(eff.keyBlob) : null,
						$access: eff.accessBlob ? Buffer.from(eff.accessBlob) : null,
						$isPassword: eff.passwordLocked ? 1 : 0,
						$id: fileObj.id,
					},
				);
			});
			recordAudit(db, {
				actor: user.username,
				action: "file.moved",
				target: `file:${fileObj.id}->${targetId === null ? "root" : `directory:${targetId}`}`,
				ip: clientIp(state, req),
			});
			const updated = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: fileObj.id,
			})!;
			res.json(serializeFiles(state, req, [updated])[0]!);
		},
	);

	/** Change what protects one file. `{ mode: "none" | "server" }` gives it its
	 * own key (or none); `{ adopt_parent: true }` puts it back under whatever
	 * protects the folder it sits in. Either way the bytes are rewritten. */
	router.patch(
		"/:fileId(\\d+)/encryption",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(fileObj, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const body = req.body ?? {};
			const adopt = body.adopt_parent === true;
			const mode = typeof body.mode === "string" ? body.mode : null;
			if (!adopt && mode !== "none" && mode !== "server") {
				res.status(400).json({
					detail: 'mode must be "none" or "server", or pass adopt_parent',
				});
				return;
			}

			const current = resolveFileEncryption(db, fileObj);
			// The server has no key for these, so it cannot rewrite them. Going
			// into or out of E2E is a browser-side re-upload (see docs/api.md and
			// POST /files/:id/seal for the one-way server-side variant).
			if (current.mode === "client" || current.mode === "sealed") {
				res.status(409).json({
					detail:
						"end-to-end encrypted files can only be converted from the browser",
				});
				return;
			}

			const masterKey = getMasterKey(state.settings);
			let next: { mode: string; keyBlob: Buffer | null };
			let target: TargetEncryption;
			let accessKey: string | null = null;

			if (adopt) {
				if (fileObj.directory_id === null) {
					res.status(400).json({
						detail: "a file outside any folder has nothing to inherit from",
					});
					return;
				}
				const dir = getDirectory(db, fileObj.directory_id);
				if (!dir) {
					res.status(404).json({ detail: "directory not found" });
					return;
				}
				const dirEff = resolveDirectoryEncryption(db, dir);
				if (dirEff.mode === "client") {
					res.status(409).json({
						detail:
							"end-to-end encrypted folders can only be converted from the browser",
					});
					return;
				}
				let key: Buffer | null = null;
				if (dirEff.mode === "server") {
					if (!dirEff.keyBlob) {
						res.status(500).json({ detail: "folder key missing" });
						return;
					}
					key = openBox(masterKey, Buffer.from(dirEff.keyBlob));
				}
				accessKey = recoverAccessSecret(masterKey, dirEff);
				next = { mode: dirEff.mode, keyBlob: dirEff.keyBlob as Buffer | null };
				target = {
					mode: dirEff.mode,
					key,
					keyBlob: null,
					accessBlob: null,
					accessIsPassword: 0,
					overridden: 0,
				};
			} else if (mode === "server") {
				// Random capability token unless the owner supplies a password
				// (security/accessLock.ts).
				const isPassword =
					body.password === undefined || body.password === null ? 0 : 1;
				const key = randomBytes(32);
				accessKey = isPassword
					? validateAccessPassword(body.password)
					: randomBytes(18).toString("base64url");
				const keyBlob = seal(masterKey, key);
				next = { mode: "server", keyBlob };
				target = {
					mode: "server",
					key,
					keyBlob,
					accessBlob: seal(masterKey, Buffer.from(accessKey)),
					accessIsPassword: isPassword,
					overridden: 1,
				};
			} else {
				next = { mode: "none", keyBlob: null };
				target = {
					mode: "none",
					key: null,
					keyBlob: null,
					accessBlob: null,
					accessIsPassword: 0,
					overridden: 1,
				};
			}

			// Same state, different bookkeeping (e.g. adopting a parent that already
			// holds this exact key): flip the flags without touching the bytes.
			if (
				next.mode === current.mode &&
				blobsEqual(next.keyBlob, current.keyBlob)
			) {
				db.run(
					`UPDATE files SET encryption_mode = $mode, enc_key_blob = $key,
             enc_access_blob = $access, access_is_password = $isPassword,
             encryption_overridden = $overridden WHERE id = $id`,
					{
						$mode: target.mode,
						$key: target.keyBlob,
						$access: target.accessBlob,
						$isPassword: target.accessIsPassword,
						$overridden: target.overridden,
						$id: fileObj.id,
					},
				);
			} else {
				await rewriteFileEncryption(state, fileObj, target);
			}

			recordAudit(db, {
				actor: user.username,
				action: "file.encryption_changed",
				target: `file:${fileObj.id}`,
				ip: clientIp(state, req),
			});
			const updated = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: fileObj.id,
			})!;
			res.json({
				...serializeFiles(state, req, [updated])[0]!,
				access_key: accessKey ?? recoverAccessKey(state, updated),
			});
		}),
	);

	/** Seal & Forget: encrypt the file with a key the server immediately throws
	 * away, returning it to the caller **once**.
	 *
	 * Afterwards the file behaves exactly like a `client`-mode one -- the server
	 * can no longer read it, and the key travels in the URL *fragment*, never as
	 * a `?ek=` query parameter. The honest difference from true end-to-end
	 * encryption, which the UI must say plainly: the key existed in this
	 * process's memory for the duration of this one request. It is never
	 * written to disk or logs, but "attacker controls the server at the moment
	 * of sealing" is a threat E2E resists and this does not.
	 *
	 * With `{password}` the key is derived from that password instead of being
	 * random (crypto/passwordKey.ts), so there is something to remember rather
	 * than something to write down -- at the cost of the file being only as
	 * strong as the password, since nothing throttles an offline guess against
	 * bytes an attacker already has. */
	router.post(
		"/:fileId(\\d+)/seal",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			// Sealing is strictly more destructive than deleting: it is
			// irreversible, and afterwards not even the owner can read the file
			// back. So it takes the *delete* gate, not the edit gate -- an editor
			// of the containing folder may move and rename, only the owner may
			// make their file permanently unreadable.
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_delete) {
				res.status(403).json({ detail: "deletion not permitted" });
				return;
			}
			if (user.role !== "master" && fileObj.owner_id !== user.id) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const current = resolveFileEncryption(db, fileObj);
			if (current.mode === "client" || current.mode === "sealed") {
				res.status(409).json({
					detail:
						"this file is already encrypted with a key the server cannot read",
				});
				return;
			}

			const raw = req.body?.password;
			const usePassword = raw !== undefined && raw !== null;
			let salt: Buffer | null = null;
			let key: Buffer;
			let revealed: string;
			if (usePassword) {
				const password = validateAccessPassword(raw);
				salt = randomBytes(SEAL_SALT_BYTES);
				key = await deriveSealKey(password, salt);
				revealed = password;
			} else {
				key = randomBytes(32);
				revealed = key.toString("base64url");
			}

			await rewriteFileEncryption(state, fileObj, {
				mode: "sealed",
				key,
				keyBlob: null,
				accessBlob: null,
				accessIsPassword: 0,
				overridden: 1,
			});
			db.run("UPDATE files SET seal_salt = $salt WHERE id = $id", {
				$salt: salt,
				$id: fileObj.id,
			});
			// Deliberately not logged, here or anywhere: the key is in the response
			// body and nowhere else.
			recordAudit(db, {
				actor: user.username,
				action: "file.sealed",
				target: `file:${fileObj.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`file sealed file_id=${fileObj.id} owner_id=${fileObj.owner_id} password_derived=${usePassword}`,
			);
			const updated = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: fileObj.id,
			})!;
			res.json({
				...serializeFiles(state, req, [updated])[0]!,
				// Shown once. There is no second copy anywhere on this server.
				key: revealed,
				key_is_password: usePassword,
				seal_salt: salt ? salt.toString("base64url") : null,
				seal_kdf: usePassword ? sealKdfId() : null,
			});
		}),
	);

	/** The owner's own copy of a file's bytes.
	 *
	 * `/file/:slug/raw` exists for the public, and spends one use of the link it
	 * came in on. An owner re-encrypting their own file in the browser (the
	 * conversion flow below) would otherwise burn their share budget to do it,
	 * and a file with no link at all would be unreachable to its own owner. So
	 * this is the same read path with no link involved: session auth, edit
	 * rights, no use consumed, no `last_downloaded_at` bump.
	 *
	 * What comes back is whatever the server can produce -- plaintext for
	 * `none`/`server` (decompressing and decrypting as needed), and the raw
	 * container for `client`/`sealed`, which is exactly what a browser holding
	 * the key needs in order to decrypt it. */
	router.get(
		"/:fileId(\\d+)/content",
		requireSession(state),
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(fileObj, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			let fullPath: string;
			try {
				fullPath = safeJoin(storageRoot(), fileObj.storage_path);
			} catch {
				res.status(500).json({ detail: "invalid storage path" });
				return;
			}
			if (!existsSync(fullPath)) {
				await ensureBlobAvailable(state, fileObj, fullPath);
			}
			if (!existsSync(fullPath)) {
				res.status(500).json({ detail: "file missing from storage" });
				return;
			}
			let source: AsyncGenerator<Buffer>;
			try {
				source = plaintextStream(state, fileObj, fullPath);
			} catch (err) {
				if (err instanceof PlaintextUnavailable) {
					res.status(503).json({ detail: err.message });
					return;
				}
				throw err;
			}
			res.writeHead(200, {
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Content-Type": "application/octet-stream",
			});
			try {
				for await (const chunk of source) {
					if (!res.write(chunk))
						await new Promise((resolve) => res.once("drain", resolve));
				}
				res.end();
			} catch (err) {
				log.error(
					`owner content read failed file_id=${fileObj.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
				res.destroy();
			}
		}),
	);

	/** Commit a browser-side end-to-end conversion.
	 *
	 * There is no server-side path into or out of `client`/`sealed` mode -- the
	 * server has no key, so the crypto has to happen in the browser. The client
	 * sequence is: upload the converted bytes as a **new** file (the ordinary
	 * finalize flow), wait for that to succeed, then call this with the old
	 * file's id. Both files exist for the duration of that window, which is
	 * deliberate: the old one is only destroyed once the replacement is known to
	 * be durable. Crashing mid-conversion leaves a duplicate, never a hole.
	 *
	 * The backend's whole job here is to make the transition *visible*. Nothing
	 * else in the audit log distinguishes "a file was uploaded" from "content
	 * that used to be unreadable by this server just passed through it in
	 * plaintext", and that is exactly the moment worth recording. */
	router.post(
		"/:fileId(\\d+)/e2e-conversion",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_delete"),
		(req, res) => {
			const user = req.currentUser!;
			const replacement = db.get<FileRow>(
				"SELECT * FROM files WHERE id = $id",
				{ $id: req.params.fileId },
			);
			if (!replacement) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(replacement, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const replacedId = intField(req.body?.replaced_file_id);
			if (replacedId === null) {
				res.status(400).json({ detail: "replaced_file_id is required" });
				return;
			}
			if (replacedId === replacement.id) {
				res.status(400).json({ detail: "a file cannot replace itself" });
				return;
			}
			const replaced = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: replacedId,
			});
			if (!replaced) {
				res.status(404).json({ detail: "replaced file not found" });
				return;
			}
			// Same rule the plain delete uses: an editor of the folder may move and
			// rename, but only the owner (or a master) may destroy.
			if (user.role !== "master" && replaced.owner_id !== user.id) {
				res.status(403).json({ detail: "not your file" });
				return;
			}

			const before = resolveFileEncryption(db, replaced).mode;
			const after = resolveFileEncryption(db, replacement).mode;
			const wasE2E = before === "client" || before === "sealed";
			const isE2E = after === "client" || after === "sealed";
			if (!wasE2E && !isE2E) {
				res.status(400).json({
					detail:
						"neither file is end-to-end encrypted; use PATCH /files/:id/encryption instead",
				});
				return;
			}

			purgeFile(state, replaced);
			recordAudit(db, {
				actor: user.username,
				// `file.e2e_decrypted` is the entry that matters: it marks when
				// previously-unreadable content stopped being unreadable.
				action: isE2E ? "file.e2e_sealed" : "file.e2e_decrypted",
				target: `file:${replacement.id} replaces file:${replaced.id} (${before}->${after})`,
				ip: clientIp(state, req),
			});
			const updated = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: replacement.id,
			})!;
			res.json({
				...serializeFiles(state, req, [updated])[0]!,
				replaced_file_id: replaced.id,
				previous_encryption_mode: before,
			});
		},
	);

	/** Swap the `?ek=` secret without re-encrypting. `{password}` locks the file
	 * behind a memorable password; an empty body mints a fresh random token. */
	router.put(
		"/:fileId(\\d+)/access",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!canEditFile(fileObj, user)) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const eff = resolveFileEncryption(db, fileObj);
			if (eff.mode !== "server") {
				res
					.status(400)
					.json({ detail: "only server-encrypted files have an access key" });
				return;
			}
			// The secret belongs to whichever node owns the key; changing it here
			// would strand everything else resolving through that same folder.
			if (!fileObj.encryption_overridden) {
				res.status(409).json({
					detail:
						"this file inherits its key; set the password on the folder that owns it",
					inherited_from_directory_id: eff.sourceDirectoryId,
				});
				return;
			}
			const raw = req.body?.password;
			const isPassword = raw === undefined || raw === null ? 0 : 1;
			const secret = isPassword
				? validateAccessPassword(raw)
				: randomBytes(18).toString("base64url");
			db.run(
				`UPDATE files SET enc_access_blob = $access, access_is_password = $isPassword
         WHERE id = $id`,
				{
					$access: seal(getMasterKey(state.settings), Buffer.from(secret)),
					$isPassword: isPassword,
					$id: fileObj.id,
				},
			);
			// A new secret means the old guessing history is meaningless. One
			// reset, because the counter is keyed on the secret's owner rather
			// than on each link that presents it.
			state.lockout.resetIdentifier(
				db,
				`file:${fileObj.id}`,
				LINK_ACCESS_IDENTIFIER,
			);
			recordAudit(db, {
				actor: user.username,
				action: "file.access_key_changed",
				target: `file:${fileObj.id}`,
				ip: clientIp(state, req),
			});
			res.json({
				id: fileObj.id,
				access_key: secret,
				password_locked: !!isPassword,
			});
		},
	);

	router.delete(
		"/:fileId(\\d+)",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_delete"),
		(req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && fileObj.owner_id !== user.id) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			purgeFile(state, fileObj);
			recordAudit(db, {
				actor: user.username,
				action: "file.deleted",
				target: `file:${fileObj.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

	router.post(
		"/:fileId(\\d+)/links",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_regenerate_links"),
		(req, res) => {
			const user = req.currentUser!;
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && fileObj.owner_id !== user.id) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const body = req.body ?? {};
			let expiresAt: string | null = null;
			if (
				body.expires_in_seconds !== undefined &&
				body.expires_in_seconds !== null
			) {
				expiresAt = new Date(
					Date.now() + Number(body.expires_in_seconds) * 1000,
				).toISOString();
			}
			const slug = newSlug();
			db.run(
				`INSERT INTO links (file_id, slug, max_uses, expires_at, use_count, active, hide_uploader, created_at)
       VALUES ($fileId, $slug, $maxUses, $expiresAt, 0, 1, $hideUploader, $now)`,
				{
					$fileId: fileObj.id,
					$slug: slug,
					$maxUses: body.max_uses ?? null,
					$expiresAt: expiresAt,
					$hideUploader: body.hide_uploader ? 1 : 0,
					$now: nowIso(),
				},
			);
			const link = db.get<LinkRow>(
				"SELECT * FROM links WHERE id = last_insert_rowid()",
			)!;
			recordAudit(db, {
				actor: user.username,
				action: "link.created",
				target: `link:${link.id}`,
				ip: clientIp(state, req),
			});
			const base = fileUrl(req, slug);
			res.json({
				slug,
				url: base,
				raw_url: `${base}/raw`,
				encryption_mode: resolveFileEncryption(db, fileObj).mode,
				access_key: recoverAccessKey(state, fileObj),
			});
		},
	);

	return router;
}

/** Mounted separately at /admin/files in app.ts. */
export function adminFilesRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	/** Every file in the system, not just the root-level ones.
	 *
	 * This used to filter on `directory_id IS NULL`, which was defensible when a
	 * folder was a flat side-container; with a real tree it hid most of the
	 * system from the one screen whose job is to show all of it. `directory_path`
	 * is what makes a nested row identifiable — two files can share a name at
	 * different depths. */
	router.get("/", requireMaster(state), (req, res) => {
		const files = db.all<FileRow>(
			"SELECT * FROM files ORDER BY created_at DESC",
		);
		const pathOf = buildPathIndex(db);
		const rows = serializeFiles(state, req, files);
		res.json({
			files: rows.map((row, i) => ({
				...row,
				directory_path: pathOf(files[i]!.directory_id),
			})),
		});
	});

	return router;
}

/** Mounted separately at /links in app.ts for /links/:linkId edit + delete. */
export function linksRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.delete(
		"/:linkId",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_delete_links"),
		(req, res) => {
			const user = req.currentUser!;
			const link = db.get<LinkRow>("SELECT * FROM links WHERE id = $id", {
				$id: req.params.linkId,
			});
			if (!link) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: link.file_id,
			});
			if (
				!fileObj ||
				(user.role !== "master" && fileObj.owner_id !== user.id)
			) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			db.run("DELETE FROM links WHERE id = $id", { $id: link.id });
			recordAudit(db, {
				actor: user.username,
				action: "link.deleted",
				target: `link:${link.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

	router.patch(
		"/:linkId",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_regenerate_links"),
		(req, res) => {
			const user = req.currentUser!;
			const link = db.get<LinkRow>("SELECT * FROM links WHERE id = $id", {
				$id: req.params.linkId,
			});
			if (!link) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: link.file_id,
			});
			if (
				!fileObj ||
				(user.role !== "master" && fileObj.owner_id !== user.id)
			) {
				res.status(403).json({ detail: "not your file" });
				return;
			}
			const body = req.body ?? {};
			if (Object.hasOwn(body, "max_uses")) {
				db.run("UPDATE links SET max_uses = $v WHERE id = $id", {
					$v: body.max_uses,
					$id: link.id,
				});
			}
			if (
				body.expires_in_seconds !== undefined &&
				body.expires_in_seconds !== null
			) {
				db.run("UPDATE links SET expires_at = $v WHERE id = $id", {
					$v: new Date(
						Date.now() + Number(body.expires_in_seconds) * 1000,
					).toISOString(),
					$id: link.id,
				});
			}
			if (body.active !== undefined && body.active !== null) {
				db.run("UPDATE links SET active = $v WHERE id = $id", {
					$v: body.active ? 1 : 0,
					$id: link.id,
				});
			}
			if (body.hide_uploader !== undefined && body.hide_uploader !== null) {
				db.run("UPDATE links SET hide_uploader = $v WHERE id = $id", {
					$v: body.hide_uploader ? 1 : 0,
					$id: link.id,
				});
			}
			recordAudit(db, {
				actor: user.username,
				action: "link.edited",
				target: `link:${link.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "updated" });
		},
	);

	return router;
}

function respondError(res: Response, err: unknown): void {
	if (res.headersSent) return;
	if (err instanceof HttpError) {
		res.status(err.status).json({ detail: err.detail });
		return;
	}
	log.error(
		`unhandled route error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
	);
	res.status(500).json({ detail: "internal server error" });
}
