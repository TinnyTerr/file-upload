import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { ZipArchive } from "archiver";
import type { Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { commitQuota, releaseQuota, reserveQuota } from "../cluster/quota.ts";
import { pushRevocation, revocationMark } from "../cluster/revocation.ts";
import { getMasterKey } from "../config.ts";
import {
	type EffectiveEncryption,
	keyScopeOf,
	recoverAccessSecret,
	resolveDirectoryEncryption,
	resolveFileEncryption,
} from "../crypto/effectiveEncryption.ts";
import { openBox, seal } from "../crypto/secretbox.ts";
import {
	type DirectoryLinkRow,
	type DirectoryRow,
	type FileRow,
	type LinkRow,
	nowIso,
	type UserRow,
} from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import {
	ancestorChain,
	buildPathIndex,
	depthOf,
	directoryRole,
	getDirectory,
	isEditor,
	isSelfOrDescendant,
	MAX_DEPTH,
	nearestOverride,
	subtree,
	subtreeHeight,
} from "../directoryTree.ts";
import { HttpError } from "../httpError.ts";
import { newSlug } from "../links.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import {
	requireActiveUser,
	requireMaster,
	requirePermission,
	requireScopeOrSession,
} from "../middleware/deps.ts";
import { ensurePermissions } from "../permissions.ts";
import {
	type AccessCheck,
	checkLinkAccess,
	LINK_ACCESS_IDENTIFIER,
	validateAccessPassword,
} from "../security/accessLock.ts";
import { requireCsrf } from "../security/csrf.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { renderSpa } from "../spa.ts";
import { releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";
import {
	blobsEqual,
	directoriesFollowingDirectory,
	filesFollowingDirectory,
	pinFileEncryption,
	rewriteFileEncryption,
} from "../storage/rekey.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";
import { memberSource, safeArcname, safeArcsegment } from "../storage/zip.ts";
import { serializeFiles } from "./files.ts";
import { previewEligible } from "./public.ts";

const log = getLogger("app.routes.directories");

const CSP =
	"default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
	"font-src 'self' https://fonts.gstatic.com; " +
	"img-src 'self' data: blob:; " +
	"media-src 'self' blob:; " +
	"frame-src 'self'; " +
	"worker-src 'self' blob:; " +
	"connect-src 'self'; " +
	"object-src 'none'";
const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": CSP,
};

const MAX_EPOCH_MS = 8640000000000000; // Date's max representable instant.

interface FileCountRow {
	n: number;
}
interface CollabIdRow {
	id: number;
}

function dirUrl(req: Request, slug: string): string {
	return `${req.protocol}://${req.get("host")}/d/${slug}`;
}

/** A nested folder usually holds no key of its own -- the break point above it
 * does -- so both of these resolve before touching any blob. */
function recoverDirAccessKey(state: AppState, d: DirectoryRow): string | null {
	return recoverAccessSecret(
		getMasterKey(state.settings),
		resolveDirectoryEncryption(state.db, d),
	);
}

/** Throttled per slug when the folder's secret is a password rather than a
 * random token (security/accessLock.ts). */
function verifyDirAccessKey(
	state: AppState,
	d: DirectoryRow,
	ek: string | null,
): AccessCheck {
	const eff = resolveDirectoryEncryption(state.db, d);
	return checkLinkAccess(state, keyScope(eff, `dir:${d.id}`), eff, ek);
}

/** Mirrors app/routes/directories.py::_resolve, but -- unlike the Python
 * reference, which only checks DirectoryLink.active and ignores its own
 * max_uses/expires_at fields even though the model defines them -- this also
 * enforces the link's own limits, mirroring links.ts::resolveActiveLink for
 * file links (same DirectoryLink/Link column shapes per CLAUDE.md's "Share
 * links (folders)" section). */
function resolveActiveDirLink(db: Db, slug: string): DirectoryLinkRow | null {
	const link = db.get<DirectoryLinkRow>(
		"SELECT * FROM directory_links WHERE slug = $slug",
		{ $slug: slug },
	);
	if (!link?.active) return null;
	const now = new Date().toISOString();
	if (link.expires_at !== null && link.expires_at <= now) return null;
	if (link.max_uses !== null && link.use_count >= link.max_uses) return null;
	return link;
}

/** Atomically claims one use, mirrors links.ts::consumeUse for directory_links. */
function consumeDirUse(db: Db, slug: string): boolean {
	const now = new Date().toISOString();
	const claimed = db.get<{ id: number }>(
		`UPDATE directory_links SET use_count = use_count + 1
     WHERE slug = $slug AND active = 1
       AND (expires_at IS NULL OR expires_at > $now)
       AND (max_uses IS NULL OR use_count < max_uses)
     RETURNING id`,
		{ $slug: slug, $now: now },
	);
	return !!claimed;
}

interface ResolvedDirectory {
	directory: DirectoryRow;
	link: DirectoryLinkRow;
}

function resolveDirectory(db: Db, slug: string): ResolvedDirectory | null {
	const link = resolveActiveDirLink(db, slug);
	if (!link) return null;
	const d = db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", {
		$id: link.directory_id,
	});
	if (!d) return null;
	const now = new Date().toISOString();
	if (d.expires_at !== null && d.expires_at <= now) return null;
	return { directory: d, link };
}

function serializeDirectories(
	state: AppState,
	req: Request,
	dirs: DirectoryRow[],
	user?: UserRow,
): Record<string, unknown>[] {
	const { db } = state;
	return dirs.map((d) => {
		const fileCount = db.get<FileCountRow>(
			"SELECT COUNT(*) as n FROM files WHERE directory_id = $id",
			{
				$id: d.id,
			},
		)!.n;
		const subdirectoryCount = db.get<FileCountRow>(
			"SELECT COUNT(*) as n FROM directories WHERE parent_directory_id = $id",
			{ $id: d.id },
		)!.n;
		// Effective state, not the row's own columns: an inheriting folder's key
		// lives on the break point above it (crypto/effectiveEncryption.ts).
		// `encryption_overridden` is what tells the UI which of the two it is.
		const eff = resolveDirectoryEncryption(db, d);
		return {
			id: d.id,
			owner_id: d.owner_id,
			slug: d.slug,
			title: d.title,
			url: dirUrl(req, d.slug),
			parent_directory_id: d.parent_directory_id,
			subdirectory_count: subdirectoryCount,
			encryption_mode: eff.mode,
			encryption_overridden: !!d.encryption_overridden,
			inherited_from_directory_id: eff.sourceDirectoryId,
			password_locked: eff.passwordLocked,
			key_check_blob: eff.keyCheckBlob,
			access_key: recoverDirAccessKey(state, d),
			file_count: fileCount,
			total_bytes: d.total_bytes,
			expires_at: d.expires_at,
			created_at: d.created_at,
			role: user ? directoryRole(db, d, user) : null,
			// Media library publication state, so the folder list can offer
			// publish/unpublish without a second round trip (routes/media.ts).
			is_library: !!d.is_library,
			library_visibility: d.library_visibility,
			library_kind: d.library_kind,
			library_overview: d.library_overview,
			// How the *public* page renders this folder. Cosmetic only.
			gallery_view: !!d.gallery_view,
		};
	});
}

function serializeDirLink(
	lk: DirectoryLinkRow,
	req: Request,
): Record<string, unknown> {
	return {
		id: lk.id,
		slug: lk.slug,
		url: dirUrl(req, lk.slug),
		max_uses: lk.max_uses,
		use_count: lk.use_count,
		expires_at: lk.expires_at,
		active: !!lk.active,
		hide_uploader: !!lk.hide_uploader,
		created_at: lk.created_at,
	};
}

/** Member files paired with their most-recent active link, mirrors
 * app/routes/directories.py::_public_files. Batch-fetches every member's
 * links in one query instead of one query per file (N+1). */
function publicFiles(
	db: Db,
	dirId: number,
): Array<{ file: FileRow; link: LinkRow }> {
	const members = db.all<FileRow>(
		"SELECT * FROM files WHERE directory_id = $id ORDER BY created_at ASC",
		{
			$id: dirId,
		},
	);
	if (!members.length) return [];
	const fileIds = members.map((f) => f.id);
	const linkRows = db.all<LinkRow>(
		`SELECT * FROM links WHERE active = 1 AND file_id IN (${fileIds.map((_, i) => `$fid${i}`).join(",")}) ORDER BY created_at DESC`,
		Object.fromEntries(fileIds.map((id, i) => [`$fid${i}`, id])),
	);
	// First row per file_id wins -- rows are ordered created_at DESC, matching
	// the single-file query's "most recent active link" semantics.
	const latestByFile = new Map<number, LinkRow>();
	for (const lk of linkRows) {
		if (!latestByFile.has(lk.file_id)) latestByFile.set(lk.file_id, lk);
	}
	const out: Array<{ file: FileRow; link: LinkRow }> = [];
	for (const f of members) {
		const link = latestByFile.get(f.id);
		if (link) out.push({ file: f, link });
	}
	return out;
}

/**
 * Which secret opens a node, as an opaque string the public page can key a
 * map of unlocked keys by.
 *
 * A folder link now covers a whole subtree, and that subtree can contain break
 * points with keys of their own -- the visitor may hold one, several, or none
 * of them. Naming the *owner* of each key (rather than just the mode) is what
 * lets the page ask for exactly the one it's missing.
 */
function keyScope(eff: EffectiveEncryption, own: string): string {
	return keyScopeOf(eff, own);
}

/** The directory a public request is asking about: the link's own directory,
 * or a descendant of it. Anything else is not reachable through this link and
 * is reported as missing rather than forbidden -- a link must not confirm the
 * existence of folders outside its own subtree. */
function publicSubdirectory(
	db: Db,
	entry: DirectoryRow,
	raw: unknown,
): DirectoryRow | null {
	if (raw === undefined || raw === null || raw === "") return entry;
	const id = Number(raw);
	if (!Number.isInteger(id)) return null;
	if (id === entry.id) return entry;
	if (!isSelfOrDescendant(db, id, entry.id)) return null;
	return getDirectory(db, id);
}

/** Subfolders of `d`, as the public page's tiles. */
function publicSubdirectories(
	db: Db,
	d: DirectoryRow,
): Record<string, unknown>[] {
	const rows = db.all<DirectoryRow>(
		"SELECT * FROM directories WHERE parent_directory_id = $id ORDER BY title ASC",
		{ $id: d.id },
	);
	return rows.map((sub) => {
		const eff = resolveDirectoryEncryption(db, sub);
		return {
			id: sub.id,
			title: sub.title,
			file_count: db.get<FileCountRow>(
				"SELECT COUNT(*) as n FROM files WHERE directory_id = $id",
				{ $id: sub.id },
			)!.n,
			subdirectory_count: db.get<FileCountRow>(
				"SELECT COUNT(*) as n FROM directories WHERE parent_directory_id = $id",
				{ $id: sub.id },
			)!.n,
			total_bytes: sub.total_bytes,
			encryption_mode: eff.mode,
			password_locked: eff.passwordLocked,
			key_check_blob: eff.keyCheckBlob,
			key_scope: keyScope(eff, `dir:${sub.id}`),
		};
	});
}

/** Breadcrumbs from the link's entry folder down to `d`. Never above the
 * entry: what's above it isn't part of what was shared. */
function publicBreadcrumbs(
	db: Db,
	entry: DirectoryRow,
	d: DirectoryRow,
): { id: number; title: string }[] {
	const chain = [...ancestorChain(db, d.id)].reverse().concat([d]);
	const start = chain.findIndex((a) => a.id === entry.id);
	return (start === -1 ? [d] : chain.slice(start)).map((a) => ({
		id: a.id,
		title: a.title,
	}));
}

function previewGroup(contentType: string, filename: string): string {
	const ct = (contentType || "application/octet-stream").toLowerCase();
	const name = filename.toLowerCase();
	if (ct.startsWith("image/")) return "images";
	if (ct.startsWith("video/")) return "videos";
	if (ct.startsWith("audio/")) return "audio";
	if (ct.startsWith("text/") || /\.(txt|md|json|csv|log)$/.test(name))
		return "text";
	if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdfs";
	if (
		ct === "application/zip" ||
		ct === "application/x-zip-compressed" ||
		name.endsWith(".zip")
	)
		return "archives";
	return "other";
}

/** Reads just the ZIP End-Of-Central-Directory record plus the central
 * directory itself (not the whole file) to list member names and detect
 * per-entry encryption (general-purpose bit flag 0). No zip-reading library
 * is vendored in server/ (only `archiver` for writing) so this is a minimal
 * hand-rolled parser -- sufficient for the preview feature's namelist/flag
 * needs, mirrors Python's zipfile.ZipFile inspection in _archive_preview. */
function readZipManifest(
	path: string,
): { entries: string[]; entryCount: number; encrypted: boolean } | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const size = fstatSync(fd).size;
		const EOCD_SIG = 0x06054b50;
		const MIN_EOCD = 22;
		const MAX_COMMENT = 65535;
		const tailLen = Math.min(size, MIN_EOCD + MAX_COMMENT);
		if (tailLen < MIN_EOCD) return null;
		const tail = Buffer.alloc(tailLen);
		readSync(fd, tail, 0, tailLen, size - tailLen);
		let eocdOffset = -1;
		for (let i = tail.length - MIN_EOCD; i >= 0; i--) {
			if (tail.readUInt32LE(i) === EOCD_SIG) {
				eocdOffset = i;
				break;
			}
		}
		if (eocdOffset === -1) return null;
		const totalEntries = tail.readUInt16LE(eocdOffset + 10);
		const cdSize = tail.readUInt32LE(eocdOffset + 12);
		const cdOffset = tail.readUInt32LE(eocdOffset + 16);
		if (cdOffset + cdSize > size) return null; // zip64 or corrupt -- bail rather than misparse
		const cd = Buffer.alloc(cdSize);
		readSync(fd, cd, 0, cdSize, cdOffset);
		const entries: string[] = [];
		let encrypted = false;
		let pos = 0;
		for (let i = 0; i < totalEntries && pos + 46 <= cd.length; i++) {
			if (cd.readUInt32LE(pos) !== 0x02014b50) break;
			const flags = cd.readUInt16LE(pos + 8);
			if (flags & 0x1) encrypted = true;
			const nameLen = cd.readUInt16LE(pos + 28);
			const extraLen = cd.readUInt16LE(pos + 30);
			const commentLen = cd.readUInt16LE(pos + 32);
			entries.push(cd.toString("utf-8", pos + 46, pos + 46 + nameLen));
			pos += 46 + nameLen + extraLen + commentLen;
		}
		return { entries, entryCount: totalEntries, encrypted };
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

function archivePreview(db: Db, f: FileRow): Record<string, unknown> {
	if (
		resolveFileEncryption(db, f).mode !== "none" ||
		f.compressed ||
		f.archived
	) {
		return { status: "unreadable", reason: "encrypted or transformed archive" };
	}
	let full: string;
	try {
		full = safeJoin(storageRoot(), f.storage_path);
	} catch {
		return { status: "unreadable", reason: "corrupt or unsupported archive" };
	}
	const manifest = readZipManifest(full);
	if (!manifest)
		return { status: "unreadable", reason: "corrupt or unsupported archive" };
	if (manifest.encrypted)
		return { status: "unreadable", reason: "encrypted archive" };
	return {
		status: "readable",
		entries: manifest.entries.slice(0, 100),
		entry_count: manifest.entryCount,
	};
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function directoryPageMeta(req: Request, db: Db, d: DirectoryRow): string {
	const pairs = publicFiles(db, d.id);
	const totalBytes = pairs.reduce((sum, { file }) => sum + file.size_bytes, 0);
	const title = escapeHtml(d.title || "Shared folder");
	const desc = escapeHtml(`${pairs.length} files, ${totalBytes} bytes`);
	const url = escapeHtml(
		`${req.protocol}://${req.get("host")}${req.originalUrl}`,
	);
	return [
		`<meta property="og:title" content="${title}">`,
		`<meta property="og:description" content="${desc}">`,
		`<meta property="og:url" content="${url}">`,
		'<meta property="og:type" content="website">',
		`<meta name="twitter:title" content="${title}">`,
		`<meta name="twitter:description" content="${desc}">`,
	].join("\n");
}

function expiresAtFromSeconds(
	res: Response,
	seconds: unknown,
): { ok: true; value: string | null } | { ok: false } {
	if (seconds === undefined || seconds === null || Number(seconds) < 1)
		return { ok: true, value: null };
	const ms = Date.now() + Number(seconds) * 1000;
	if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) {
		res.status(400).json({ detail: "expires_in_seconds is too large" });
		return { ok: false };
	}
	return { ok: true, value: new Date(ms).toISOString() };
}

/** Mirrors app/routes/directories.py -- folder CRUD, collaborators, and
 * per-folder link CRUD. Mounted at /api with no further prefix -- every path
 * in this router already spells out its own /directories segment. */
export function directoriesRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.post(
		"/directories",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const body = req.body ?? {};
			let encryptionMode = body.encryption_mode || "none";
			if (!["none", "server", "client"].includes(encryptionMode)) {
				res.status(400).json({ detail: "invalid encryption_mode" });
				return;
			}
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_create_directories) {
				res.status(403).json({ detail: "directory creation not permitted" });
				return;
			}

			// Nesting. A child always starts out inheriting its parent's effective
			// encryption -- picking a different one is an explicit override, which
			// is what PATCH /directories/:id/encryption is for (phase 6).
			let parent: DirectoryRow | null = null;
			const rawParent = body.parent_directory_id;
			if (rawParent !== undefined && rawParent !== null && rawParent !== "") {
				const parentId = Number(rawParent);
				if (!Number.isInteger(parentId)) {
					res.status(400).json({ detail: "invalid parent_directory_id" });
					return;
				}
				parent = getDirectory(db, parentId);
				if (!parent) {
					res.status(404).json({ detail: "parent directory not found" });
					return;
				}
				if (!isEditor(db, parent, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
				if (depthOf(db, parent.id) + 1 > MAX_DEPTH) {
					res.status(400).json({
						detail: `folders can be nested at most ${MAX_DEPTH} deep`,
					});
					return;
				}
				if (body.encryption_mode === "client") {
					res.status(400).json({
						detail:
							"nested folders inherit their parent's encryption; set it on the parent instead",
					});
					return;
				}
				// Same reasoning: a child has no secret of its own to lock, and
				// silently ignoring the password would leave the caller believing
				// the folder is protected by one.
				if (body.password !== undefined && body.password !== null) {
					res.status(400).json({
						detail:
							"nested folders inherit their parent's access key; set the password on the folder that owns it",
					});
					return;
				}
				encryptionMode = nearestOverride(db, parent).encryption_mode;
			}

			// Only a root-level folder declares its own client-mode key material; a
			// child of a legacy client-mode folder inherits the parent's, so it has
			// no key_check_blob of its own to supply.
			if (encryptionMode === "client" && !parent) {
				if (!perm.can_upload_client_encrypted) {
					res
						.status(403)
						.json({ detail: "client-side encryption not permitted" });
					return;
				}
				if (!body.key_check_blob) {
					res
						.status(400)
						.json({ detail: "client directories require key_check_blob" });
					return;
				}
			}

			const title =
				(typeof body.title === "string" ? body.title : "Untitled folder")
					.trim()
					.slice(0, 512) || "Untitled folder";
			const expires = expiresAtFromSeconds(res, body.expires_in_seconds);
			if (!expires.ok) return;

			let encKeyBlob: Buffer | null = null;
			let encAccessBlob: Buffer | null = null;
			let accessKey: string | null = null;
			let keyCheckBlob: string | null =
				encryptionMode === "client" ? (body.key_check_blob ?? null) : null;
			// A root-level folder is always its own break point. A child always
			// inherits -- including from a *plaintext* parent, because "plaintext"
			// is a state the parent can later change; a child that stood alone just
			// because its parent happened to be unencrypted would silently refuse
			// to follow when the parent is encrypted afterwards.
			//
			// An inheriting child's key columns stay NULL on purpose -- the single
			// copy of the key material lives on the break point, so re-keying that
			// folder can't leave a stale duplicate behind down here. Reads go
			// through crypto/effectiveEncryption.ts.
			let overridden = 1;
			let accessIsPassword = 0;
			if (parent) {
				overridden = 0;
				keyCheckBlob = null;
				accessKey = recoverDirAccessKey(state, nearestOverride(db, parent));
			} else if (encryptionMode === "server") {
				const masterKey = getMasterKey(state.settings);
				const dirKey = randomBytes(32);
				// An owner may supply their own password instead of taking the random
				// capability token (security/accessLock.ts).
				accessIsPassword =
					body.password === undefined || body.password === null ? 0 : 1;
				accessKey = accessIsPassword
					? validateAccessPassword(body.password)
					: randomBytes(18).toString("base64url");
				encKeyBlob = seal(masterKey, dirKey);
				encAccessBlob = seal(masterKey, Buffer.from(accessKey));
			}

			const slug = newSlug();
			db.run(
				`INSERT INTO directories (
         owner_id, slug, title, parent_directory_id, encryption_mode, enc_key_blob,
         enc_access_blob, access_is_password, encryption_overridden, key_check_blob,
         expires_at, created_at
       ) VALUES ($ownerId, $slug, $title, $parentId, $enc, $encKey, $encAccess,
         $isPassword, $overridden, $keyCheck, $expiresAt, $now)`,
				{
					// A folder created inside someone else's tree belongs to that
					// tree's owner, not to whoever made it. Otherwise an editor could
					// create a subfolder they own, invite third parties to it (the
					// collaborator endpoint is owner-only), and move the tree owner's
					// files into it — routing around the very restriction that
					// endpoint exists to impose. Mirrors routes/dropbox.ts, which
					// already attributes to the target folder's owner.
					$ownerId: parent ? parent.owner_id : user.id,
					$slug: slug,
					$title: title,
					$parentId: parent ? parent.id : null,
					$enc: encryptionMode,
					$encKey: encKeyBlob,
					$encAccess: encAccessBlob,
					$isPassword: accessIsPassword,
					$overridden: overridden,
					$keyCheck: keyCheckBlob,
					$expiresAt: expires.value,
					$now: nowIso(),
				},
			);
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = last_insert_rowid()",
			)!;
			// Default DirectoryLink so /d/{slug} resolves via the link system, mirrors
			// the directory-links auto-create noted in CLAUDE.md's "Share links (folders)".
			db.run(
				"INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
				{ $dirId: d.id, $slug: slug, $now: nowIso() },
			);
			recordAudit(db, {
				actor: user.username,
				action: "directory.created",
				target: `directory:${d.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`directory created directory_id=${d.id} owner_id=${user.id} encryption=${encryptionMode}`,
			);

			const eff = resolveDirectoryEncryption(db, d);
			res.json({
				id: d.id,
				slug,
				url: dirUrl(req, slug),
				parent_directory_id: d.parent_directory_id,
				encryption_mode: eff.mode,
				encryption_overridden: !!d.encryption_overridden,
				inherited_from_directory_id: eff.sourceDirectoryId,
				password_locked: eff.passwordLocked,
				key_check_blob: eff.keyCheckBlob,
				access_key: accessKey,
			});
		},
	);

	// ── the browse/search endpoint ─────────────────────────────────────────
	//
	// One endpoint answers every read of the tree; which read you get is chosen
	// entirely by search parameters. It replaces the three that used to do this
	// (`GET /directories/`, `/directories/root/children`,
	// `/directories/:id/children`), whose only real differences were the scope
	// they walked and whether they returned files.
	//
	//   parent = root | <id>   where to look; defaults to root
	//   scope  = level | subtree | all
	//              level   (default) direct children of `parent`
	//              subtree everything beneath `parent`, recursively
	//              all     every folder the caller can reach; ignores `parent`
	//   q      = <term>        case-insensitive substring over folder titles and
	//                          file names, applied within `scope`
	//   type   = all | directories | files
	//   limit / offset         paging, applied after filtering
	//
	// `scope=level` with no `q` is the Drive explorer's per-level fetch and is
	// still never a recursive dump. `subtree` and `all` are bounded by the same
	// MAX_DEPTH walkers as everything else in directoryTree.ts.

	const MAX_LIMIT = 500;

	/** Every folder the user can reach: the ones they own, plus every folder at
	 * or beneath a collaborator grant. Reads the table once and walks in memory
	 * -- a query per row is what `buildPathIndex` exists to avoid. */
	function reachableDirectories(user: UserRow): DirectoryRow[] {
		const owned = db.all<DirectoryRow>(
			"SELECT * FROM directories WHERE owner_id = $id",
			{ $id: user.id },
		);
		const granted = db.all<DirectoryRow>(
			`SELECT d.* FROM directories d
       JOIN directory_collaborators dc ON dc.directory_id = d.id
       WHERE dc.user_id = $id`,
			{ $id: user.id },
		);
		const byId = new Map<number, DirectoryRow>();
		for (const d of owned) byId.set(d.id, d);
		// A grant covers the whole subtree under it, so the grant row alone is not
		// the reachable set -- pull each one's descendants in too.
		for (const d of granted) {
			if (byId.has(d.id)) continue;
			byId.set(d.id, d);
			for (const child of subtree(db, d.id)) byId.set(child.id, child);
		}
		return [...byId.values()];
	}

	/** Every file directly inside any of `dirs`, in one query. The Db contract
	 * takes named parameters only (db/types.ts), so the IN list is built as
	 * $d0,$d1,... rather than positional placeholders. Chunked because SQLite
	 * caps a statement at SQLITE_MAX_VARIABLE_NUMBER bindings. */
	function filesUnder(dirs: DirectoryRow[]): FileRow[] {
		const ids = dirs.map((d) => d.id);
		const out: FileRow[] = [];
		for (let i = 0; i < ids.length; i += 400) {
			const chunk = ids.slice(i, i + 400);
			const params: Record<string, number> = {};
			const names = chunk.map((id, j) => {
				params[`$d${j}`] = id;
				return `$d${j}`;
			});
			out.push(
				...db.all<FileRow>(
					`SELECT * FROM files WHERE directory_id IN (${names.join(",")})`,
					params,
				),
			);
		}
		return out;
	}

	function parseParent(raw: unknown): number | null {
		const value = typeof raw === "string" ? raw.trim() : "";
		if (!value || value === "root") return null;
		const n = Number(value);
		if (!Number.isInteger(n) || n <= 0) {
			throw new HttpError(400, "parent must be a directory id or 'root'");
		}
		return n;
	}

	function parseIntParam(raw: unknown, fallback: number, max: number): number {
		const value = typeof raw === "string" ? raw.trim() : "";
		if (!value) return fallback;
		const n = Number(value);
		if (!Number.isInteger(n) || n < 0) {
			throw new HttpError(
				400,
				"limit and offset must be non-negative integers",
			);
		}
		return Math.min(n, max);
	}

	// Session cookie, or an OAuth token carrying directories:read.
	router.get(
		"/directories",
		requireScopeOrSession(state, "directories:read"),
		(req, res) => {
			const user = req.currentUser!;

			const scope = String(req.query.scope ?? "level");
			if (scope !== "level" && scope !== "subtree" && scope !== "all") {
				res
					.status(400)
					.json({ detail: "scope must be one of: level, subtree, all" });
				return;
			}
			const type = String(req.query.type ?? "all");
			if (type !== "all" && type !== "directories" && type !== "files") {
				res
					.status(400)
					.json({ detail: "type must be one of: all, directories, files" });
				return;
			}
			const q = String(req.query.q ?? "")
				.trim()
				.toLowerCase();
			const limit = parseIntParam(req.query.limit, MAX_LIMIT, MAX_LIMIT);
			const offset = parseIntParam(
				req.query.offset,
				0,
				Number.MAX_SAFE_INTEGER,
			);

			// `all` is caller-wide by definition, so it never resolves a parent --
			// passing one alongside it is a contradiction rather than a refinement.
			const parentId = scope === "all" ? null : parseParent(req.query.parent);
			let parent: DirectoryRow | null = null;
			if (parentId !== null) {
				parent = getDirectory(db, parentId);
				if (!parent) {
					res.status(404).json({ detail: "not found" });
					return;
				}
				if (!isEditor(db, parent, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
			}

			// ── collect, before filtering ──
			let dirs: DirectoryRow[];
			let files: FileRow[];
			// `type` is applied here rather than after collecting, so asking for
			// only folders doesn't read every file first and throw them away. The
			// folder picker (scope=all&type=directories) is the hot path for this.
			const wantFiles = type !== "directories";

			if (scope === "all" || (scope === "subtree" && !parent)) {
				// A root-bounded subtree is everything the caller can reach, which is
				// exactly what `all` collects -- the two coincide here.
				dirs = reachableDirectories(user);
				files = wantFiles
					? filesUnder(dirs).concat(
							db.all<FileRow>(
								"SELECT * FROM files WHERE directory_id IS NULL AND owner_id = $id",
								{ $id: user.id },
							),
						)
					: [];
			} else if (scope === "subtree") {
				// subtree() is "at or below", so it hands back the bounding folder
				// itself -- drop it, or the folder you asked about turns up as one of
				// its own descendants (and its files get counted twice below).
				dirs = subtree(db, parent!.id).filter((d) => d.id !== parent!.id);
				// The bounding folder's own files do belong to its subtree, though.
				files = wantFiles ? filesUnder([parent!, ...dirs]) : [];
			} else {
				dirs = parent
					? db.all<DirectoryRow>(
							"SELECT * FROM directories WHERE parent_directory_id = $id ORDER BY title ASC",
							{ $id: parent.id },
						)
					: db.all<DirectoryRow>(
							`SELECT * FROM directories WHERE parent_directory_id IS NULL
                 AND (owner_id = $id OR id IN (
                   SELECT directory_id FROM directory_collaborators WHERE user_id = $id))
               ORDER BY title ASC`,
							{ $id: user.id },
						);
				files = !wantFiles
					? []
					: parent
						? db.all<FileRow>(
								"SELECT * FROM files WHERE directory_id = $id ORDER BY created_at DESC",
								{ $id: parent.id },
							)
						: db.all<FileRow>(
								"SELECT * FROM files WHERE directory_id IS NULL AND owner_id = $id ORDER BY created_at DESC",
								{ $id: user.id },
							);
			}

			// ── filter ──
			if (q) {
				dirs = dirs.filter((d) => d.title.toLowerCase().includes(q));
				files = files.filter((f) =>
					f.original_filename.toLowerCase().includes(q),
				);
			}
			// Folders can only be dropped after collection: a subtree's file set is
			// derived from them.
			if (type === "files") dirs = [];

			// A level listing keeps its SQL ordering (folders A-Z, files newest
			// first); anything wider is a result set, so name order reads better.
			if (scope !== "level") {
				dirs.sort((a, b) => a.title.localeCompare(b.title));
				files.sort((a, b) =>
					a.original_filename.localeCompare(b.original_filename),
				);
			}

			const total = { directories: dirs.length, files: files.length };
			const page = <T>(rows: T[]) => rows.slice(offset, offset + limit);

			// Search results land out of context, so each one carries the folder
			// path it lives at. buildPathIndex reads the table once -- never
			// ancestor-walk per row in a listing.
			const withPaths = scope !== "level" || Boolean(q);
			const pathOf = withPaths ? buildPathIndex(db) : null;

			const pagedDirs = page(dirs);
			const pagedFiles = page(files);

			res.json({
				directory: parent
					? serializeDirectories(state, req, [parent], user)[0]!
					: null,
				breadcrumbs: parent
					? [...ancestorChain(db, parent.id)]
							.reverse()
							.concat([parent])
							.map((a) => ({ id: a.id, title: a.title }))
					: [],
				directories: serializeDirectories(state, req, pagedDirs, user).map(
					(d, i) =>
						pathOf
							? { ...d, path: pathOf(pagedDirs[i]!.parent_directory_id) }
							: d,
				),
				files: serializeFiles(state, pagedFiles).map((f, i) =>
					pathOf ? { ...f, path: pathOf(pagedFiles[i]!.directory_id) } : f,
				),
				scope,
				query: q || null,
				total,
				limit,
				offset,
			});
		},
	);

	/** Rename, and/or switch the public page between the list and the gallery.
	 * Editors of the folder (or of anything above it) may do either. */
	router.patch(
		"/directories/:dirId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = getDirectory(db, Number(req.params.dirId));
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, d, user)) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const body = req.body ?? {};
			const wantsTitle = "title" in body;
			const wantsGallery = "gallery_view" in body;
			if (!wantsTitle && !wantsGallery) {
				res.status(400).json({ detail: "title is required" });
				return;
			}
			// Validate both fields before writing either: a request that names two
			// changes must not half-apply because the second one is malformed.
			if (
				wantsTitle &&
				(typeof body.title !== "string" || !body.title.trim())
			) {
				res.status(400).json({ detail: "title is required" });
				return;
			}
			if (wantsGallery && typeof body.gallery_view !== "boolean") {
				res.status(400).json({ detail: "gallery_view must be a boolean" });
				return;
			}
			if (wantsTitle) {
				db.run("UPDATE directories SET title = $title WHERE id = $id", {
					$title: (body.title as string).trim().slice(0, 512),
					$id: d.id,
				});
			}
			if (wantsGallery) {
				db.run("UPDATE directories SET gallery_view = $g WHERE id = $id", {
					$g: body.gallery_view ? 1 : 0,
					$id: d.id,
				});
			}
			recordAudit(db, {
				actor: user.username,
				action: wantsTitle ? "directory.renamed" : "directory.updated",
				target: `directory:${d.id}`,
				ip: clientIp(state, req),
			});
			const updated = getDirectory(db, d.id)!;
			res.json(serializeDirectories(state, req, [updated], user)[0]!);
		},
	);

	/** Re-parent a folder. `parent_directory_id: null` moves it to the root. */
	router.patch(
		"/directories/:dirId(\\d+)/move",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = getDirectory(db, Number(req.params.dirId));
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, d, user)) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			// A grant made directly on this folder shouldn't be enough to pull it
			// out of a tree the grantee has no rights over.
			if (d.parent_directory_id !== null) {
				const sourceParent = getDirectory(db, d.parent_directory_id);
				if (sourceParent && !isEditor(db, sourceParent, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
			} else if (user.role !== "master" && d.owner_id !== user.id) {
				// A root-level folder has no parent to check rights against, so
				// editorship alone would let a collaborator relocate someone else's
				// top-level folder into their own tree — and the guard above would
				// then stop the owner moving it back, since they have no rights on
				// the new parent. Relocating a root folder is the owner's call.
				res.status(403).json({ detail: "not your directory" });
				return;
			}

			const body = req.body ?? {};
			if (!("parent_directory_id" in body)) {
				res.status(400).json({ detail: "parent_directory_id is required" });
				return;
			}
			const raw = body.parent_directory_id;
			let target: DirectoryRow | null = null;
			if (raw !== null && raw !== "" && raw !== undefined) {
				const targetId = Number(raw);
				if (!Number.isInteger(targetId)) {
					res.status(400).json({ detail: "invalid parent_directory_id" });
					return;
				}
				target = getDirectory(db, targetId);
				if (!target) {
					res.status(404).json({ detail: "target directory not found" });
					return;
				}
				if (!isEditor(db, target, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
				if (isSelfOrDescendant(db, target.id, d.id)) {
					res.status(400).json({
						detail: "cannot move a folder into itself or its contents",
					});
					return;
				}
			}

			// The whole subtree moves, so its deepest member is what has to fit.
			const newDepth = target ? depthOf(db, target.id) + 1 : 0;
			if (newDepth + subtreeHeight(db, d.id) > MAX_DEPTH) {
				res
					.status(400)
					.json({ detail: `folders can be nested at most ${MAX_DEPTH} deep` });
				return;
			}

			// Moving must not silently change which key protects bytes that are
			// already encrypted, so an inheriting folder is promoted to its own
			// break point on the way out. Promotion has to *materialize* the key
			// it was resolving to a moment ago -- the chain it inherited from is
			// exactly what the move severs, so leaving the columns NULL would strand
			// every file underneath. Re-keying to the new parent is an explicit
			// action (PATCH .../encryption, phase 6), never a side effect of a drag.
			if (d.encryption_overridden) {
				db.run(
					"UPDATE directories SET parent_directory_id = $parent WHERE id = $id",
					{ $parent: target ? target.id : null, $id: d.id },
				);
			} else {
				const eff = resolveDirectoryEncryption(db, d);
				db.run(
					`UPDATE directories SET parent_directory_id = $parent, encryption_overridden = 1,
             encryption_mode = $mode, enc_key_blob = $key, enc_access_blob = $access,
             access_is_password = $isPassword, key_check_blob = $keyCheck WHERE id = $id`,
					{
						$parent: target ? target.id : null,
						$mode: eff.mode,
						$key: eff.keyBlob ? Buffer.from(eff.keyBlob) : null,
						$access: eff.accessBlob ? Buffer.from(eff.accessBlob) : null,
						// Carrying this is not cosmetic: it is the only thing that tells
						// the public check to throttle guesses. Dropping it would turn a
						// moved folder's human password into an unthrottled oracle.
						$isPassword: eff.passwordLocked ? 1 : 0,
						$keyCheck: eff.keyCheckBlob,
						$id: d.id,
					},
				);
			}
			recordAudit(db, {
				actor: user.username,
				action: "directory.moved",
				target: `directory:${d.id}->${target ? `directory:${target.id}` : "root"}`,
				ip: clientIp(state, req),
			});
			const updated = getDirectory(db, d.id)!;
			res.json(serializeDirectories(state, req, [updated], user)[0]!);
		},
	);

	/**
	 * Duplicate one of your own folders, and everything under it, somewhere else.
	 *
	 * The recursive half of `POST /files/:id/copy`, and the same primitive
	 * `POST /d/:slug/save` is built on — minus the "as far as the presented key
	 * reaches" filter, because an owner is entitled to the whole subtree. No
	 * bytes are written: every file is a `ref_count` bump on a blob that is
	 * already there.
	 */
	router.post(
		"/directories/:dirId(\\d+)/copy",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_create_directories"),
		// Async since Phase 5: the quota reservation is a call to the master.
		// Express 4 does not await handlers, so this MUST stay inside
		// asyncHandler or a rejection hangs the request forever.
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const sourceDir = getDirectory(db, Number(req.params.dirId));
			if (!sourceDir) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, sourceDir, user)) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}

			const body = req.body ?? {};
			const raw = body.parent_directory_id;
			let target: DirectoryRow | null = null;
			if (raw !== null && raw !== "" && raw !== undefined) {
				const targetId = Number(raw);
				if (!Number.isInteger(targetId)) {
					res.status(400).json({ detail: "invalid parent_directory_id" });
					return;
				}
				target = getDirectory(db, targetId);
				if (!target) {
					res.status(404).json({ detail: "target directory not found" });
					return;
				}
				if (!isEditor(db, target, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
				if (isSelfOrDescendant(db, target.id, sourceDir.id)) {
					res.status(400).json({
						detail: "cannot copy a folder into itself or its contents",
					});
					return;
				}
			}

			const targetEff = target ? resolveDirectoryEncryption(db, target) : null;
			// Same refusal as an upload into an end-to-end folder: the server holds
			// no key for it, so it cannot re-key the copy into place.
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

			// The whole subtree comes along, so its deepest member is what has to fit.
			const newDepth = target ? depthOf(db, target.id) + 1 : 0;
			if (newDepth + subtreeHeight(db, sourceDir.id) > MAX_DEPTH) {
				res
					.status(400)
					.json({ detail: `folders can be nested at most ${MAX_DEPTH} deep` });
				return;
			}

			interface CopyNode {
				source: DirectoryRow;
				eff: EffectiveEncryption;
				files: FileRow[];
				children: CopyNode[];
			}
			// `cluster/replication.ts` upserts `parent_directory_id` with no
			// validation, so a walk that trusts the tree can be made to recurse
			// forever by a bad peer. Every walker in directoryTree.ts guards this.
			const visited = new Set<number>();
			const collect = (dir: DirectoryRow): CopyNode => {
				visited.add(dir.id);
				return {
					source: dir,
					eff: resolveDirectoryEncryption(db, dir),
					files: db.all<FileRow>(
						"SELECT * FROM files WHERE directory_id = $id ORDER BY id ASC",
						{ $id: dir.id },
					),
					children: db
						.all<DirectoryRow>(
							"SELECT * FROM directories WHERE parent_directory_id = $id ORDER BY title ASC",
							{ $id: dir.id },
						)
						.flatMap((sub) => (visited.has(sub.id) ? [] : [collect(sub)])),
				};
			};
			const tree = collect(sourceDir);

			const totalOf = (n: CopyNode): number =>
				n.files.reduce((sum, f) => sum + f.size_bytes, 0) +
				n.children.reduce((sum, c) => sum + totalOf(c), 0);
			const logicalBytes = totalOf(tree);
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_upload && user.role !== "master") {
				res.status(403).json({ detail: "permission denied: can_upload" });
				return;
			}
			// One reservation for the whole tree, taken before any of it is
			// written: a folder copy creates many `files` rows and quota is
			// logical bytes (D-17), so the sum is what has to be admitted.
			const reservation = await reserveQuota(state, {
				user,
				bytes: logicalBytes,
				kind: "copy",
			});

			// " - Copy", as everywhere else, but only when it would otherwise
			// collide: pasting into a different folder should keep the name.
			const siblingTitles = new Set(
				db
					.all<DirectoryRow>(
						target
							? "SELECT * FROM directories WHERE parent_directory_id = $id"
							: "SELECT * FROM directories WHERE parent_directory_id IS NULL AND owner_id = $owner",
						target ? { $id: target.id } : { $owner: user.id },
					)
					.map((d) => d.title),
			);
			let rootTitle = sourceDir.title;
			for (let n = 0; siblingTitles.has(rootTitle) && n < 100; n += 1) {
				rootTitle =
					n === 0
						? `${sourceDir.title} - Copy`
						: `${sourceDir.title} - Copy (${n + 1})`;
			}

			let copiedFiles = 0;

			/** Copies one folder, then everything under it.
			 *
			 * The root copy is its own break point — it may land where nothing above
			 * it holds a key — so it needs the source's *effective* material, not
			 * columns that are NULL because the source inherits. A descendant whose
			 * effective material is byte-identical to its new parent's inherits
			 * instead, so re-keying the copy later reaches the whole tree; one whose
			 * material differs becomes its own break point, because inheriting would
			 * relabel bytes it doesn't describe. */
			const copyNode = (
				node: CopyNode,
				parent: DirectoryRow | null,
				title: string,
			): DirectoryRow => {
				const parentEff = parent
					? resolveDirectoryEncryption(db, parent)
					: null;
				const inherits =
					parentEff !== null &&
					node.eff.mode === parentEff.mode &&
					blobsEqual(node.eff.keyBlob, parentEff.keyBlob);
				const slug = newSlug();
				db.run(
					`INSERT INTO directories (
         owner_id, slug, title, parent_directory_id, encryption_mode, enc_key_blob,
         enc_access_blob, access_is_password, encryption_overridden, key_check_blob,
         total_bytes, gallery_view, created_at
       ) VALUES ($ownerId, $slug, $title, $parentId, $enc, $encKey, $encAccess, $isPassword,
         $overridden, $keyCheck, $totalBytes, $gallery, $now)`,
					{
						// A folder created inside someone else's tree belongs to that
						// tree's owner -- otherwise an editor owns it, and the
						// owner-only collaborator endpoint becomes re-delegatable.
						$ownerId: parent ? parent.owner_id : user.id,
						$slug: slug,
						$title: title,
						$parentId: parent ? parent.id : null,
						$enc: node.eff.mode,
						$encKey:
							inherits || !node.eff.keyBlob
								? null
								: Buffer.from(node.eff.keyBlob),
						$encAccess:
							inherits || !node.eff.accessBlob
								? null
								: Buffer.from(node.eff.accessBlob),
						$isPassword: !inherits && node.eff.passwordLocked ? 1 : 0,
						$overridden: inherits ? 0 : 1,
						$keyCheck: inherits ? null : node.eff.keyCheckBlob,
						$totalBytes: node.files.reduce((sum, f) => sum + f.size_bytes, 0),
						$gallery: node.source.gallery_view,
						$now: nowIso(),
					},
				);
				const copy = db.get<DirectoryRow>(
					"SELECT * FROM directories WHERE id = last_insert_rowid()",
				)!;
				db.run(
					"INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
					{ $dirId: copy.id, $slug: slug, $now: nowIso() },
				);
				copyFilesInto(node, copy);
				for (const child of node.children)
					copyNode(child, copy, child.source.title);
				return copy;
			};

			function copyFilesInto(node: CopyNode, into: DirectoryRow): void {
				for (const source of node.files) {
					const fileEff = resolveFileEncryption(db, source);
					const intoEff = resolveDirectoryEncryption(db, into);
					const inherits =
						fileEff.mode === intoEff.mode &&
						blobsEqual(fileEff.keyBlob, intoEff.keyBlob);
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
							$ownerId: into.owner_id,
							$dirId: into.id,
							$blobId: source.blob_id,
							$path: source.storage_path,
							$filename: source.original_filename,
							$sourceType: source.source_type,
							$size: source.size_bytes,
							$storedSize: source.stored_size_bytes,
							$ct: source.content_type,
							$enc: fileEff.mode,
							$encKey:
								inherits || !fileEff.keyBlob
									? null
									: Buffer.from(fileEff.keyBlob),
							$encAccess:
								inherits || !fileEff.accessBlob
									? null
									: Buffer.from(fileEff.accessBlob),
							$isPassword: !inherits && fileEff.passwordLocked ? 1 : 0,
							$overridden: inherits ? 0 : 1,
							$sealSalt: source.seal_salt
								? Buffer.from(source.seal_salt)
								: null,
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
					db.run(
						"INSERT INTO links (file_id, slug, use_count, active, created_at) VALUES (last_insert_rowid(), $slug, 0, 1, $now)",
						{ $slug: newSlug(), $now: nowIso() },
					);
					copiedFiles += 1;
				}
			}

			// `directories.total_bytes` counts a folder's *direct* files only --
			// which is why moving a folder doesn't touch its new parent's total
			// either. Each copied folder sets its own; the destination's is unchanged.
			let newDir!: DirectoryRow;
			db.transaction(() => {
				newDir = copyNode(tree, target, rootTitle);
			});

			recordAudit(db, {
				actor: user.username,
				action: "directory.copied",
				target: `directory:${sourceDir.id}->directory:${newDir.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`directory copied source_directory_id=${sourceDir.id} copy_directory_id=${newDir.id} owner_id=${user.id} copied_files=${copiedFiles}`,
			);
			await commitQuota(state, reservation.uid, logicalBytes);
			res.json(serializeDirectories(state, req, [newDir], user)[0]!);
		}),
	);

	/** Change what protects a folder's contents.
	 *
	 * Body is either `{ mode: "none" | "server" }` (this folder becomes its own
	 * break point, minting a fresh key for `server`) or `{ adopt_parent: true }`
	 * (drop its own key and follow the chain above it again).
	 *
	 * Every file the change reaches is physically re-encrypted, synchronously,
	 * inside this request -- a large subtree therefore makes for a long request.
	 * A background job with progress reporting is the natural next step; it is
	 * deliberately not built here. */
	router.patch(
		"/directories/:dirId(\\d+)/encryption",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const d = getDirectory(db, Number(req.params.dirId));
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, d, user)) {
				res.status(403).json({ detail: "not your directory" });
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

			const current = resolveDirectoryEncryption(db, d);
			if (current.mode === "client") {
				res.status(409).json({
					detail:
						"end-to-end encrypted folders can only be converted from the browser",
				});
				return;
			}

			let parent: DirectoryRow | null = null;
			if (adopt) {
				if (d.parent_directory_id === null) {
					res.status(400).json({
						detail: "a root-level folder has no parent to inherit from",
					});
					return;
				}
				parent = getDirectory(db, d.parent_directory_id);
				if (!parent) {
					res.status(404).json({ detail: "parent directory not found" });
					return;
				}
				if (resolveDirectoryEncryption(db, parent).mode === "client") {
					res.status(409).json({
						detail:
							"end-to-end encrypted folders can only be converted from the browser",
					});
					return;
				}
			}

			// What protects the contents afterwards, and what the folder row itself
			// stores -- nothing, when it goes back to inheriting.
			const masterKey = getMasterKey(state.settings);
			let next: EffectiveEncryption;
			let rowKeyBlob: Buffer | null = null;
			let rowAccessBlob: Buffer | null = null;
			let overridden = 1;
			let isPassword = 0;
			let accessKey: string | null = null;
			let fileKey: Buffer | null = null;
			if (adopt) {
				next = resolveDirectoryEncryption(db, parent!);
				overridden = 0;
				accessKey = recoverAccessSecret(masterKey, next);
				if (next.mode === "server") {
					if (!next.keyBlob) {
						res.status(500).json({ detail: "parent key missing" });
						return;
					}
					fileKey = openBox(masterKey, Buffer.from(next.keyBlob));
				}
			} else if (mode === "server") {
				// The access secret is either a random capability token or, when the
				// owner supplies one, their own password -- stored identically, but
				// flagged so public checks get throttled (security/accessLock.ts).
				isPassword =
					body.password === undefined || body.password === null ? 0 : 1;
				fileKey = randomBytes(32);
				accessKey = isPassword
					? validateAccessPassword(body.password)
					: randomBytes(18).toString("base64url");
				rowKeyBlob = seal(masterKey, fileKey);
				rowAccessBlob = seal(masterKey, Buffer.from(accessKey));
				next = {
					mode: "server",
					keyBlob: rowKeyBlob,
					accessBlob: rowAccessBlob,
					passwordLocked: !!isPassword,
					keyCheckBlob: null,
					sourceDirectoryId: null,
					ownerDirectoryId: d.id,
				};
			} else {
				next = {
					mode: "none",
					keyBlob: null,
					accessBlob: null,
					passwordLocked: false,
					keyCheckBlob: null,
					sourceDirectoryId: null,
					ownerDirectoryId: d.id,
				};
			}

			const rewriteNeeded =
				next.mode !== current.mode ||
				!blobsEqual(next.keyBlob, current.keyBlob);
			const affected = rewriteNeeded
				? filesFollowingDirectory(db, d, current)
				: [];
			const inheritors = directoriesFollowingDirectory(db, d);

			// Pin first: from here on nothing underneath depends on this folder's
			// columns, so a failure part-way through leaves every file readable with
			// the key it already had (see storage/rekey.ts).
			for (const f of affected) pinFileEncryption(db, f);

			db.run(
				`UPDATE directories SET encryption_mode = $mode, enc_key_blob = $key,
           enc_access_blob = $access, access_is_password = $isPassword,
           encryption_overridden = $overridden, key_check_blob = NULL
         WHERE id = $id`,
				{
					$mode: next.mode,
					$key: rowKeyBlob,
					$access: rowAccessBlob,
					$isPassword: isPassword,
					$overridden: overridden,
					$id: d.id,
				},
			);
			// Keep the denormalized mode mirror on inheriting subfolders in step.
			for (const child of inheritors) {
				db.run(
					"UPDATE directories SET encryption_mode = $mode WHERE id = $id",
					{
						$mode: next.mode,
						$id: child.id,
					},
				);
			}

			let rewritten = 0;
			for (const f of affected) {
				const fresh = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
					$id: f.id,
				});
				if (!fresh) continue;
				await rewriteFileEncryption(state, fresh, {
					mode: next.mode,
					key: fileKey,
					keyBlob: null,
					accessBlob: null,
					accessIsPassword: 0,
					overridden: 0,
				});
				rewritten += 1;
			}

			recordAudit(db, {
				actor: user.username,
				action: "directory.encryption_changed",
				target: `directory:${d.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`directory encryption changed directory_id=${d.id} mode=${next.mode} inherited=${overridden === 0} files_reencrypted=${rewritten}`,
			);
			const updated = getDirectory(db, d.id)!;
			res.json({
				...serializeDirectories(state, req, [updated], user)[0]!,
				access_key: accessKey,
				files_reencrypted: rewritten,
			});
		}),
	);

	/** Swap the `?ek=` secret without re-keying anything. `{password}` locks the
	 * folder behind a memorable password; an empty body mints a fresh random
	 * token. The stored bytes are untouched -- only the gate changes. */
	router.put(
		"/directories/:dirId(\\d+)/access",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = getDirectory(db, Number(req.params.dirId));
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, d, user)) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const eff = resolveDirectoryEncryption(db, d);
			if (eff.mode !== "server") {
				res
					.status(400)
					.json({ detail: "only server-encrypted folders have an access key" });
				return;
			}
			// The secret belongs to whichever folder owns the key; changing it here
			// would strand every other folder resolving through that same one.
			if (!d.encryption_overridden) {
				res.status(409).json({
					detail:
						"this folder inherits its key; set the password on the folder that owns it",
					inherited_from_directory_id: eff.sourceDirectoryId,
				});
				return;
			}
			const raw = req.body?.password;
			const isPassword = raw === undefined || raw === null ? 0 : 1;
			const secret = isPassword
				? validateAccessPassword(raw)
				: randomBytes(18).toString("base64url");
			const sealedSecret = seal(
				getMasterKey(state.settings),
				Buffer.from(secret),
			);
			// Every file this folder's key governs, *before* the swap — the set is
			// defined by the old secret, so it has to be computed first.
			const governed = filesFollowingDirectory(db, d, eff);
			db.run(
				`UPDATE directories SET enc_access_blob = $access, access_is_password = $isPassword
         WHERE id = $id`,
				{
					$access: sealedSecret,
					$isPassword: isPassword,
					$id: d.id,
				},
			);
			// Files that pin their own copy of the old secret would otherwise keep
			// answering to it: every file uploaded before the inheritance model
			// carries a byte-identical copy of its folder's access blob on its own
			// row, so swapping only the folder's would leave the old token live on
			// each member's link. No bytes change — this is the secret, not the key.
			for (const f of governed) {
				if (!f.encryption_overridden) continue;
				db.run(
					`UPDATE files SET enc_access_blob = $access, access_is_password = $isPassword
           WHERE id = $id`,
					{ $access: sealedSecret, $isPassword: isPassword, $id: f.id },
				);
				state.lockout.resetIdentifier(
					db,
					`file:${f.id}`,
					LINK_ACCESS_IDENTIFIER,
				);
			}
			// A new secret means the old guessing history is meaningless. One
			// reset, because the counter is keyed on the secret's owner rather
			// than on each link that presents it.
			state.lockout.resetIdentifier(db, `dir:${d.id}`, LINK_ACCESS_IDENTIFIER);
			recordAudit(db, {
				actor: user.username,
				action: "directory.access_key_changed",
				target: `directory:${d.id}`,
				ip: clientIp(state, req),
			});
			res.json({
				id: d.id,
				access_key: secret,
				password_locked: !!isPassword,
			});
		},
	);

	router.get(
		"/directories/:dirId(\\d+)/files",
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, d, user)) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const members = db.all<FileRow>(
				"SELECT * FROM files WHERE directory_id = $id ORDER BY created_at ASC",
				{ $id: d.id },
			);
			const files = members.map((f) => {
				const link = db.get<LinkRow>(
					"SELECT * FROM links WHERE file_id = $id AND active = 1 ORDER BY created_at DESC LIMIT 1",
					{ $id: f.id },
				);
				return {
					id: f.id,
					slug: link ? link.slug : null,
					filename: f.original_filename,
					size_bytes: f.size_bytes,
					stored_size_bytes: f.stored_size_bytes,
					content_type: f.content_type,
					encryption_mode: resolveFileEncryption(db, f).mode,
					created_at: f.created_at,
				};
			});
			res.json({ files });
		},
	);

	router.delete(
		"/directories/:dirId(\\d+)/files/:fileId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!isEditor(db, d, user)) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			// DELETE /files/:fileId requires can_delete -- without this check a
			// user denied deletion could route around it through a folder instead.
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_delete) {
				res.status(403).json({ detail: "deletion not permitted" });
				return;
			}
			const fileObj = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: req.params.fileId,
			});
			if (!fileObj || fileObj.directory_id !== d.id) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			db.run("DELETE FROM links WHERE file_id = $id", { $id: fileObj.id });
			db.run(
				"UPDATE directories SET total_bytes = MAX(0, COALESCE(total_bytes, 0) - $dec) WHERE id = $id",
				{
					$dec: fileObj.size_bytes ?? 0,
					$id: d.id,
				},
			);
			const unlinkAfterCommit = [releaseBlob(db, fileObj)];
			db.run("DELETE FROM files WHERE id = $id", { $id: fileObj.id });
			deleteThumbnail(fileObj.id);
			recordAudit(db, {
				actor: user.username,
				action: "directory.file_deleted",
				target: `file:${fileObj.id}`,
				ip: clientIp(state, req),
			});
			unlinkQueued(unlinkAfterCommit);
			res.json({ status: "deleted" });
		},
	);

	router.post(
		"/directories/:dirId(\\d+)/collaborators",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const username =
				typeof req.body?.username === "string" ? req.body.username.trim() : "";
			const target = db.get<UserRow>(
				"SELECT * FROM users WHERE username = $u",
				{ $u: username },
			);
			if (!target) {
				res.status(404).json({ detail: "user not found" });
				return;
			}
			if (target.id === d.owner_id) {
				res.status(400).json({ detail: "owner is already a collaborator" });
				return;
			}
			let existing = db.get<{ id: number; role: string }>(
				"SELECT id, role FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user",
				{ $dir: d.id, $user: target.id },
			);
			if (!existing) {
				db.run(
					`INSERT INTO directory_collaborators (directory_id, user_id, invited_by_id, role, created_at)
           VALUES ($dir, $user, $invitedBy, 'editor', $now)`,
					{ $dir: d.id, $user: target.id, $invitedBy: user.id, $now: nowIso() },
				);
				existing = db.get<{ id: number; role: string }>(
					"SELECT id, role FROM directory_collaborators WHERE id = last_insert_rowid()",
				)!;
			}
			recordAudit(db, {
				actor: user.username,
				action: "directory.collaborator_added",
				target: `directory:${d.id}:user:${target.id}`,
				ip: clientIp(state, req),
			});
			res.json({
				id: existing.id,
				directory_id: d.id,
				user_id: target.id,
				username: target.username,
				role: existing.role,
			});
		},
	);

	router.delete(
		"/directories/:dirId(\\d+)/collaborators/:userId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const row = db.get<CollabIdRow>(
				"SELECT id FROM directory_collaborators WHERE directory_id = $dir AND user_id = $user",
				{ $dir: d.id, $user: req.params.userId },
			);
			if (!row) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			db.run("DELETE FROM directory_collaborators WHERE id = $id", {
				$id: row.id,
			});
			recordAudit(db, {
				actor: user.username,
				action: "directory.collaborator_removed",
				target: `directory:${d.id}:user:${req.params.userId}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "removed" });
		},
	);

	router.delete(
		"/directories/:dirId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			// Same can_delete gate as the single-file route above and DELETE /files/:fileId.
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_delete) {
				res.status(403).json({ detail: "deletion not permitted" });
				return;
			}

			// Folders nest now, so deletion walks the whole subtree bottom-up:
			// `parent_directory_id` is a real FK and PRAGMA foreign_keys is ON, so
			// a parent cannot be removed while a child still points at it.
			const nodes = subtree(db, d.id);
			const foreign = nodes.find(
				(n) => user.role !== "master" && n.owner_id !== user.id,
			);
			if (foreign) {
				res.status(403).json({
					detail: "this folder contains a subfolder owned by someone else",
				});
				return;
			}

			const unlinkAfterCommit: Array<string | null> = [];
			let filesRemoved = 0;
			for (const node of [...nodes].reverse()) {
				const members = db.all<FileRow>(
					"SELECT * FROM files WHERE directory_id = $id",
					{ $id: node.id },
				);
				for (const f of members) {
					db.run("DELETE FROM links WHERE file_id = $id", { $id: f.id });
					unlinkAfterCommit.push(releaseBlob(db, f));
					db.run("DELETE FROM files WHERE id = $id", { $id: f.id });
					deleteThumbnail(f.id);
				}
				filesRemoved += members.length;
				db.run(
					"DELETE FROM dropbox_upload_links WHERE target_directory_id = $id",
					{ $id: node.id },
				);
				db.run("DELETE FROM directory_collaborators WHERE directory_id = $id", {
					$id: node.id,
				});
				db.run("DELETE FROM directory_links WHERE directory_id = $id", {
					$id: node.id,
				});
				db.run("DELETE FROM directories WHERE id = $id", { $id: node.id });
			}
			recordAudit(db, {
				actor: user.username,
				action: "directory.deleted",
				target: `directory:${d.id}`,
				ip: clientIp(state, req),
			});
			unlinkQueued(unlinkAfterCommit);
			res.json({
				status: "deleted",
				files_removed: filesRemoved,
				directories_removed: nodes.length,
			});
		},
	);

	router.get(
		"/directories/:dirId(\\d+)/links",
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const links = db.all<DirectoryLinkRow>(
				"SELECT * FROM directory_links WHERE directory_id = $id ORDER BY created_at ASC",
				{
					$id: d.id,
				},
			);
			res.json({ links: links.map((lk) => serializeDirLink(lk, req)) });
		},
	);

	router.post(
		"/directories/:dirId(\\d+)/links",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_regenerate_links) {
				res.status(403).json({ detail: "link creation not permitted" });
				return;
			}
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const body = req.body ?? {};
			const expires = expiresAtFromSeconds(res, body.expires_in_seconds);
			if (!expires.ok) return;
			const slug = newSlug();
			db.run(
				`INSERT INTO directory_links (directory_id, slug, max_uses, expires_at, use_count, active, hide_uploader, created_at)
       VALUES ($dirId, $slug, $maxUses, $expiresAt, 0, 1, $hideUploader, $now)`,
				{
					$dirId: d.id,
					$slug: slug,
					$maxUses: body.max_uses ?? null,
					$expiresAt: expires.value,
					$hideUploader: body.hide_uploader ? 1 : 0,
					$now: nowIso(),
				},
			);
			const lk = db.get<DirectoryLinkRow>(
				"SELECT * FROM directory_links WHERE id = last_insert_rowid()",
			)!;
			recordAudit(db, {
				actor: user.username,
				action: "directory_link.created",
				target: `directory:${d.id}`,
				ip: clientIp(state, req),
			});
			res.json(serializeDirLink(lk, req));
		},
	);

	router.patch(
		"/directories/:dirId(\\d+)/links/:linkId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			// Deactivating a folder link, shortening its life or capping its uses
			// are revocations (§5.9): a peer serving the old row keeps handing the
			// folder out. Pushed rather than left to the pull.
			const mark = revocationMark(state);
			const user = req.currentUser!;
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_regenerate_links) {
				res.status(403).json({ detail: "link creation not permitted" });
				return;
			}
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const lk = db.get<DirectoryLinkRow>(
				"SELECT * FROM directory_links WHERE id = $id",
				{ $id: req.params.linkId },
			);
			if (!lk || lk.directory_id !== d.id) {
				res.status(404).json({ detail: "link not found" });
				return;
			}
			const body = req.body ?? {};
			if (body.max_uses !== undefined && body.max_uses !== null) {
				db.run("UPDATE directory_links SET max_uses = $v WHERE id = $id", {
					$v: Number(body.max_uses) > 0 ? Number(body.max_uses) : null,
					$id: lk.id,
				});
			}
			if (body.active !== undefined && body.active !== null) {
				db.run("UPDATE directory_links SET active = $v WHERE id = $id", {
					$v: body.active ? 1 : 0,
					$id: lk.id,
				});
			}
			if (body.hide_uploader !== undefined && body.hide_uploader !== null) {
				db.run("UPDATE directory_links SET hide_uploader = $v WHERE id = $id", {
					$v: body.hide_uploader ? 1 : 0,
					$id: lk.id,
				});
			}
			if (
				body.expires_in_seconds !== undefined &&
				body.expires_in_seconds !== null
			) {
				const expires = expiresAtFromSeconds(res, body.expires_in_seconds);
				if (!expires.ok) return;
				db.run("UPDATE directory_links SET expires_at = $v WHERE id = $id", {
					$v: expires.value,
					$id: lk.id,
				});
			}
			recordAudit(db, {
				actor: user.username,
				action: "directory_link.updated",
				target: `directory_link:${lk.id}`,
				ip: clientIp(state, req),
			});
			const updated = db.get<DirectoryLinkRow>(
				"SELECT * FROM directory_links WHERE id = $id",
				{ $id: lk.id },
			)!;
			res.json({
				...serializeDirLink(updated, req),
				revocation: await pushRevocation(state, mark),
			});
		}),
	);

	router.delete(
		"/directories/:dirId(\\d+)/links/:linkId(\\d+)",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const mark = revocationMark(state);
			const user = req.currentUser!;
			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			if (!perm.can_delete_links) {
				res.status(403).json({ detail: "link deletion not permitted" });
				return;
			}
			const d = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: req.params.dirId },
			);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role !== "master" && d.owner_id !== user.id) {
				res.status(403).json({ detail: "not your directory" });
				return;
			}
			const lk = db.get<DirectoryLinkRow>(
				"SELECT * FROM directory_links WHERE id = $id",
				{ $id: req.params.linkId },
			);
			if (!lk || lk.directory_id !== d.id) {
				res.status(404).json({ detail: "link not found" });
				return;
			}
			db.run("DELETE FROM directory_links WHERE id = $id", { $id: lk.id });
			recordAudit(db, {
				actor: user.username,
				action: "directory_link.deleted",
				target: `directory_link:${lk.id}`,
				ip: clientIp(state, req),
			});
			res.json({
				status: "deleted",
				revocation: await pushRevocation(state, mark),
			});
		}),
	);

	return router;
}

/** Mounted separately at /admin/directories in app.ts, mirrors adminFilesRouter
 * in files.ts / GET /admin/directories in app/routes/directories.py. */
export function adminDirectoriesRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/", requireMaster(state), (req, res) => {
		const dirs = db.all<DirectoryRow>(
			"SELECT * FROM directories ORDER BY created_at DESC",
		);
		// Titles repeat across a tree, so a flat list needs the path to be
		// readable at all (directoryTree.ts::buildPathIndex — one query, not one
		// ancestor walk per row).
		const pathOf = buildPathIndex(db);
		const rows = serializeDirectories(state, req, dirs);
		res.json({
			directories: rows.map((row, i) => ({
				...row,
				directory_path: pathOf(dirs[i]!.parent_directory_id),
			})),
		});
	});

	return router;
}

/** Mirrors the /d/{slug}* endpoints of app/routes/directories.py -- no auth
 * required (link slug is the credential), same shape as public.ts for files.
 * Mounted at root. */
export function publicDirectoriesRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	/** One level of a shared folder.
	 *
	 * `?dir=<id>` walks into a descendant of the link's folder -- the link
	 * covers a subtree now, not a flat list. Metadata (titles, sizes, which key
	 * each node wants) is deliberately readable without a key, exactly as it
	 * always has been for the entry folder; the bytes are what `?ek=` gates,
	 * on `/raw` and `/zip`. */
	router.get("/d/:slug/info", (req, res) => {
		const resolved = resolveDirectory(db, req.params.slug);
		if (!resolved) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const { directory: entry, link } = resolved;
		const d = publicSubdirectory(db, entry, req.query.dir);
		if (!d) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const pairs = publicFiles(db, d.id);

		let uploader: {
			username: string;
			has_avatar: boolean;
			user_id: number;
		} | null = null;
		if (!link.hide_uploader) {
			const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: entry.owner_id,
			});
			if (owner)
				uploader = {
					username: owner.username,
					has_avatar: owner.avatar_data !== null,
					user_id: owner.id,
				};
		}

		let alreadySaved = false;
		const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
		if (cookie) {
			const sessionRow = state.sessionManager.resolve(db, cookie);
			if (sessionRow) {
				const existing = db.get<DirectoryRow>(
					"SELECT * FROM directories WHERE owner_id = $uid AND saved_from_directory_id = $did",
					{ $uid: sessionRow.user_id, $did: entry.id },
				);
				alreadySaved = !!existing || entry.owner_id === sessionRow.user_id;
			}
		}

		const eff = resolveDirectoryEncryption(db, d);
		res.json({
			id: d.id,
			entry_id: entry.id,
			title: d.title,
			breadcrumbs: publicBreadcrumbs(db, entry, d),
			encryption_mode: eff.mode,
			// Tells the folder page to ask for a password rather than paste a key.
			password_locked: eff.passwordLocked,
			key_check_blob: eff.keyCheckBlob,
			key_scope: keyScope(eff, `dir:${d.id}`),
			// Presentation is the *link's* folder's choice and stays put as the
			// visitor walks deeper -- switching layout mid-navigation would be
			// jarring, and only the shared folder was ever configured.
			gallery_view: !!entry.gallery_view,
			directories: publicSubdirectories(db, d),
			file_count: pairs.length,
			total_bytes: pairs.reduce((sum, { file }) => sum + file.size_bytes, 0),
			uploader,
			// Saving copies the folder the link points at, never a subfolder.
			already_saved: alreadySaved,
			files: pairs.map(({ file, link: lk }) => {
				// A file can be its own break point inside an otherwise-uniform
				// folder, so each member says which key it wants rather than
				// inheriting the page's assumption.
				const fileEff = resolveFileEncryption(db, file);
				return {
					slug: lk.slug,
					filename: file.original_filename,
					size_bytes: file.size_bytes,
					content_type: file.content_type,
					encryption_mode: fileEff.mode,
					password_locked: fileEff.passwordLocked,
					key_scope: keyScope(fileEff, `file:${file.id}`),
					// Whether /preview will actually serve these bytes. The gallery
					// needs the answer before it renders a player, and only the
					// server knows what transforms the blob is under.
					previewable: previewEligible(db, file, lk),
				};
			}),
		});
	});

	/** Check a key or password for one node under this link, without
	 * downloading anything.
	 *
	 * The public page needs to know whether the visitor holds the right secret
	 * *before* it offers to reveal a subfolder, and it must not learn that by
	 * starting a download it would then have to throw away. Password-locked
	 * nodes are throttled here on the same per-slug counter every other public
	 * check uses (security/accessLock.ts), so this is not a free oracle. */
	router.post("/d/:slug/unlock", (req, res) => {
		const resolved = resolveDirectory(db, req.params.slug);
		if (!resolved) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const d = publicSubdirectory(db, resolved.directory, req.body?.dir);
		if (!d) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const ek = typeof req.body?.ek === "string" ? req.body.ek : null;
		const eff = resolveDirectoryEncryption(db, d);
		const access = checkLinkAccess(
			state,
			keyScope(eff, `dir:${d.id}`),
			eff,
			ek,
		);
		if (!access.ok) {
			res.status(access.status).json({ detail: access.detail });
			return;
		}
		res.json({ ok: true, key_scope: keyScope(eff, `dir:${d.id}`) });
	});

	router.get("/d/:slug/preview-manifest", (req, res) => {
		const resolved = resolveDirectory(db, req.params.slug);
		if (!resolved) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const d = publicSubdirectory(db, resolved.directory, req.query.dir);
		if (!d) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const groups: Record<string, Record<string, unknown>[]> = {
			images: [],
			videos: [],
			audio: [],
			text: [],
			pdfs: [],
			archives: [],
			other: [],
		};
		for (const { file: f, link } of publicFiles(db, d.id)) {
			const fileEff = resolveFileEncryption(db, f);
			const row: Record<string, unknown> = {
				id: f.id,
				slug: link.slug,
				filename: f.original_filename,
				size_bytes: f.size_bytes,
				content_type: f.content_type,
				encryption_mode: fileEff.mode,
				password_locked: fileEff.passwordLocked,
				key_scope: keyScope(fileEff, `file:${f.id}`),
				preview_url: `/file/${link.slug}/preview`,
				download_url: `/file/${link.slug}/raw`,
			};
			const group = previewGroup(f.content_type, f.original_filename);
			if (group === "archives") row.preview = archivePreview(db, f);
			groups[group]!.push(row);
		}
		res.json({
			id: d.id,
			entry_id: resolved.directory.id,
			title: d.title,
			slug: d.slug,
			breadcrumbs: publicBreadcrumbs(db, resolved.directory, d),
			directories: publicSubdirectories(db, d),
			encryption_mode: resolveDirectoryEncryption(db, d).mode,
			file_count: Object.values(groups).reduce((sum, g) => sum + g.length, 0),
			groups,
		});
	});

	router.post(
		"/d/:slug/save",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		// Async since Phase 5 -- see the note on /directories/:dirId/copy above.
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const resolved = resolveDirectory(db, req.params.slug);
			if (!resolved) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const { directory: sourceDir } = resolved;
			if (sourceDir.owner_id === user.id) {
				res.status(409).json({ detail: "you own this directory" });
				return;
			}
			const already = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE owner_id = $uid AND saved_from_directory_id = $did",
				{ $uid: user.id, $did: sourceDir.id },
			);
			if (already) {
				res.status(409).json({ detail: "already saved" });
				return;
			}
			const ek = typeof req.query.ek === "string" ? req.query.ek : null;
			const access = verifyDirAccessKey(state, sourceDir, ek);
			if (!access.ok) {
				res.status(access.status).json({ detail: access.detail });
				return;
			}
			// Saving follows the subtree on exactly the rule the zip uses: as far
			// as the presented key reaches, and no further. A descendant holding a
			// key of its own is skipped -- copying it would hand away the whole
			// point of a break point. Plaintext descendants come along; they need
			// no key from anyone.
			const sourceEff = resolveDirectoryEncryption(db, sourceDir);
			const scope = keyScope(sourceEff, `dir:${sourceDir.id}`);
			const entitled = (eff: EffectiveEncryption, own: string): boolean =>
				eff.mode === "none" || keyScope(eff, own) === scope;

			interface SaveNode {
				source: DirectoryRow;
				eff: EffectiveEncryption;
				files: FileRow[];
				children: SaveNode[];
			}
			// A `parent_directory_id` cycle is unreachable through the move handler,
			// but cluster/replication.ts upserts that column with no validation, so
			// a walk that trusts the tree can be made to recurse forever by a bad
			// peer. Every walker in directoryTree.ts carries this guard already.
			const visited = new Set<number>();
			const collect = (
				dir: DirectoryRow,
				eff: EffectiveEncryption,
			): SaveNode => {
				visited.add(dir.id);
				return {
					source: dir,
					eff,
					files: publicFiles(db, dir.id)
						.map(({ file }) => file)
						.filter((f) =>
							entitled(resolveFileEncryption(db, f), `file:${f.id}`),
						),
					children: db
						.all<DirectoryRow>(
							"SELECT * FROM directories WHERE parent_directory_id = $id ORDER BY title ASC",
							{ $id: dir.id },
						)
						.flatMap((sub) => {
							if (visited.has(sub.id)) return [];
							const subEff = resolveDirectoryEncryption(db, sub);
							return entitled(subEff, `dir:${sub.id}`)
								? [collect(sub, subEff)]
								: [];
						}),
				};
			};
			const tree = collect(sourceDir, sourceEff);

			const totalOf = (n: SaveNode): number =>
				n.files.reduce((sum, f) => sum + f.size_bytes, 0) +
				n.children.reduce((sum, c) => sum + totalOf(c), 0);
			const logicalBytes = totalOf(tree);
			ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			// As with a file save (R-5): no new bytes, but a `files` row per
			// member, and logical bytes are the entitlement.
			const reservation = await reserveQuota(state, {
				user,
				bytes: logicalBytes,
				kind: "save",
			});
			if (!consumeDirUse(db, req.params.slug)) {
				await releaseQuota(state, reservation.uid);
				res.status(404).json({ detail: "not found" });
				return;
			}

			/** Copies one folder, then everything under it.
			 *
			 * The root copy is always its own break point -- it lands at the top of
			 * the saver's drive with nothing above it to inherit from -- so it needs
			 * the source's *effective* key material, not columns that may be NULL
			 * because the source inherits. A descendant whose effective key material
			 * is byte-identical to its new parent's inherits instead, so re-keying
			 * the saved copy later reaches the whole tree; one whose material
			 * differs (a plaintext folder under an encrypted one, say) becomes its
			 * own break point, because inheriting would relabel bytes it doesn't
			 * describe. */
			const copyNode = (
				node: SaveNode,
				parent: DirectoryRow | null,
			): DirectoryRow => {
				const inherits =
					parent !== null &&
					node.eff.mode === resolveDirectoryEncryption(db, parent).mode &&
					blobsEqual(
						node.eff.keyBlob,
						resolveDirectoryEncryption(db, parent).keyBlob,
					);
				const slug = newSlug();
				db.run(
					`INSERT INTO directories (
         owner_id, slug, title, parent_directory_id, encryption_mode, enc_key_blob,
         enc_access_blob, access_is_password, encryption_overridden, key_check_blob,
         total_bytes, saved_from_directory_id, created_at
       ) VALUES ($ownerId, $slug, $title, $parentId, $enc, $encKey, $encAccess, $isPassword,
         $overridden, $keyCheck, $totalBytes, $savedFrom, $now)`,
					{
						$ownerId: user.id,
						$slug: slug,
						$title: node.source.title,
						$parentId: parent ? parent.id : null,
						$enc: node.eff.mode,
						$encKey:
							inherits || !node.eff.keyBlob
								? null
								: Buffer.from(node.eff.keyBlob),
						$encAccess:
							inherits || !node.eff.accessBlob
								? null
								: Buffer.from(node.eff.accessBlob),
						$isPassword: !inherits && node.eff.passwordLocked ? 1 : 0,
						$overridden: inherits ? 0 : 1,
						$keyCheck: inherits ? null : node.eff.keyCheckBlob,
						$totalBytes: node.files.reduce((sum, f) => sum + f.size_bytes, 0),
						// Only the entry folder records what it was saved from -- that is
						// what the "already saved" check keys on, and a descendant isn't
						// separately saveable.
						$savedFrom: parent === null ? node.source.id : null,
						$now: nowIso(),
					},
				);
				const copy = db.get<DirectoryRow>(
					"SELECT * FROM directories WHERE id = last_insert_rowid()",
				)!;
				db.run(
					"INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
					{ $dirId: copy.id, $slug: slug, $now: nowIso() },
				);
				copyFilesInto(node, copy);
				for (const child of node.children) copyNode(child, copy);
				return copy;
			};

			let savedFiles = 0;
			function copyFilesInto(node: SaveNode, target: DirectoryRow): void {
				for (const source of node.files) {
					// Same reasoning as the directory row above: the copy is a break
					// point, so it needs the resolved key, not the source's own columns.
					const fileEff = resolveFileEncryption(db, source);
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
           enc_key_blob, enc_access_blob, access_is_password, compressed, archived, archive_codec,
           archive_original_stored_size_bytes, archive_saved_bytes, archive_after_idle_days,
           lifecycle_state, is_permanent, delete_if_idle_days, auto_unarchive_on_download, created_at
         ) VALUES ($ownerId, $dirId, $blobId, $path, $filename, 'saved', $savedFrom, $size, $storedSize, $ct, $enc,
           $encKey, $encAccess, $fileIsPassword, $compressed, $archived, $archiveCodec, $archiveOrigStored, $archiveSaved,
           $archiveAfterIdle, $lifecycle, 1, $deleteIfIdle, $autoUnarchive, $now)`,
						{
							$ownerId: user.id,
							$dirId: target.id,
							$blobId: source.blob_id,
							$path: source.storage_path,
							$filename: source.original_filename,
							$savedFrom: source.id,
							$size: source.size_bytes,
							$storedSize: source.stored_size_bytes,
							$ct: source.content_type,
							$enc: fileEff.mode,
							$encKey: fileEff.keyBlob ? Buffer.from(fileEff.keyBlob) : null,
							$encAccess: fileEff.accessBlob
								? Buffer.from(fileEff.accessBlob)
								: null,
							$fileIsPassword: fileEff.passwordLocked ? 1 : 0,
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
					const copied = db.get<FileRow>(
						"SELECT * FROM files WHERE id = last_insert_rowid()",
					)!;
					db.run(
						"INSERT INTO links (file_id, slug, use_count, active, created_at) VALUES ($fid, $slug, 0, 1, $now)",
						{
							$fid: copied.id,
							$slug: newSlug(),
							$now: nowIso(),
						},
					);
					savedFiles += 1;
				}
			}

			const newDir = copyNode(tree, null);

			recordAudit(db, {
				actor: user.username,
				action: "directory.saved",
				target: `directory:${sourceDir.id}->directory:${newDir.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`directory saved source_directory_id=${sourceDir.id} saved_directory_id=${newDir.id} owner_id=${user.id} saved_files=${savedFiles}`,
			);

			await commitQuota(state, reservation.uid, logicalBytes);
			res.json({
				id: newDir.id,
				slug: newDir.slug,
				url: dirUrl(req, newDir.slug),
				saved_files: savedFiles,
				source_type: "saved",
				access_key: recoverDirAccessKey(state, newDir),
			});
		}),
	);

	router.get(
		"/d/:slug/zip",
		asyncHandler(async (req, res) => {
			const resolved = resolveDirectory(db, req.params.slug);
			if (!resolved) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const d = publicSubdirectory(db, resolved.directory, req.query.dir);
			if (!d) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const dirEff = resolveDirectoryEncryption(db, d);
			if (dirEff.mode === "client") {
				res.status(400).json({
					detail:
						"end-to-end encrypted bundle — download from the directory page",
				});
				return;
			}
			const ek = typeof req.query.ek === "string" ? req.query.ek : null;
			const access = verifyDirAccessKey(state, d, ek);
			if (!access.ok) {
				res.status(access.status).json({ detail: access.detail });
				return;
			}

			// The zip follows the subtree, but only as far as this key reaches.
			// A descendant that broke away with a key of its own is exactly what a
			// break point is *for* -- including it here would hand the whole point
			// of it to anyone holding the folder above. Plaintext descendants are
			// included: they need no key from anyone.
			const scope = keyScope(dirEff, `dir:${d.id}`);
			const entitled = (eff: EffectiveEncryption, own: string): boolean =>
				eff.mode === "none" || keyScope(eff, own) === scope;

			const members: { file: FileRow; path: string[] }[] = [];
			const walked = new Set<number>();
			const walk = (dir: DirectoryRow, path: string[]): void => {
				if (walked.has(dir.id)) return;
				walked.add(dir.id);
				for (const { file } of publicFiles(db, dir.id)) {
					if (entitled(resolveFileEncryption(db, file), `file:${file.id}`)) {
						members.push({ file, path });
					}
				}
				for (const sub of db.all<DirectoryRow>(
					"SELECT * FROM directories WHERE parent_directory_id = $id ORDER BY title ASC",
					{ $id: dir.id },
				)) {
					if (!entitled(resolveDirectoryEncryption(db, sub), `dir:${sub.id}`)) {
						continue;
					}
					walk(sub, [...path, sub.title]);
				}
			};
			walk(d, []);

			if (!members.length) {
				res.status(404).json({ detail: "directory is empty" });
				return;
			}
			if (!consumeDirUse(db, req.params.slug)) {
				res.status(404).json({ detail: "not found" });
				return;
			}

			const zipName =
				(d.title || "bundle").trim().replace(/"/g, "") || "bundle";
			res.set(SECURITY_HEADERS);
			res.setHeader("Content-Type", "application/zip");
			res.setHeader(
				"Content-Disposition",
				`attachment; filename="${zipName}.zip"`,
			);
			const archive = new ZipArchive({ store: true });
			archive.on("error", (err: Error) => {
				if (!res.headersSent) res.status(500).json({ detail: "zip failed" });
				else res.destroy();
				log.error(`directory zip failed directory_id=${d.id}: ${err.message}`);
			});
			archive.pipe(res);

			const masterKey = getMasterKey(state.settings);
			// One namespace per folder: two files can share a name in the zip as
			// long as they sat in different folders in the source.
			const seenByPath = new Map<string, Set<string>>();
			const cleanup: string[] = [];
			try {
				for (const { file: f, path } of members) {
					// A member the server cannot decrypt would land in the zip as
					// ciphertext, which is worse than not being there at all.
					const memberMode = resolveFileEncryption(db, f).mode;
					if (memberMode === "client" || memberMode === "sealed") continue;
					const prefix = path.map((p) => safeArcsegment(p)).join("/");
					let seen = seenByPath.get(prefix);
					if (!seen) {
						seen = new Set<string>();
						seenByPath.set(prefix, seen);
					}
					const name = safeArcname(f.original_filename, seen);
					const [src, isTemp] = await memberSource(db, masterKey, f);
					if (isTemp) cleanup.push(src);
					archive.file(src, { name: prefix ? `${prefix}/${name}` : name });
				}
				recordAudit(db, {
					actor: "anonymous",
					action: "directory.downloaded",
					target: `directory:${d.id}`,
					ip: clientIp(state, req),
				});
				await archive.finalize();
			} catch (err) {
				if (!res.headersSent) {
					if (err instanceof HttpError)
						res.status(err.status).json({ detail: err.detail });
					else res.status(500).json({ detail: "zip failed" });
				} else {
					res.destroy();
				}
				log.error(
					`directory zip failed directory_id=${d.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
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

	router.get("/d/:slug", (req, res) => {
		const resolved = resolveDirectory(db, req.params.slug);
		const meta = resolved ? directoryPageMeta(req, db, resolved.directory) : "";
		const content = renderSpa(meta);
		res.set({
			...SECURITY_HEADERS,
			"Content-Type": "text/html; charset=utf-8",
		});
		res.send(content);
	});

	return router;
}
