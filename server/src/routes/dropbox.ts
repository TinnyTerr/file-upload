import { createHash, randomBytes } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import busboy from "busboy";
import type { Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { getMasterKey } from "../config.ts";
import { openBox, seal } from "../crypto/secretbox.ts";
import {
	type DirectoryRow,
	type DropboxLinkRow,
	type DropboxUploadRow,
	nowIso,
	type PermissionRow,
	type UserRow,
} from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import {
	clientIp,
	requestProtocol,
	requireSession,
} from "../middleware/auth.ts";
import { requireActiveUser } from "../middleware/deps.ts";
import { ensurePermissions } from "../permissions.ts";
import { present } from "../present.ts";
import { requireCsrf } from "../security/csrf.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";
import { checkRateLimit } from "../security/rateLimit.ts";
import type { FileHashes } from "../storage/blobs.ts";
import { storageRoot } from "../storage/paths.ts";
import { triggerWebhooks } from "../webhooks.ts";
import {
	assembleChunks,
	assemblyPath,
	canEditDirectory,
	chunkUploadSize,
	expectedChunkLen,
	finalizeStoredFile,
	isFinalizing,
	isLegacyPartsLayout,
	numChunks,
	partsDir,
	precheckDeclaredSize,
	prepareAssembly,
	receiveChunkAt,
	receivedIndices,
	replayFinalize,
	startFinalize,
	usedBytes,
} from "./files.ts";

const log = getLogger("app.routes.dropbox");

const DROPBOX_CHUNK_TOKEN_AAD = Buffer.from("dropbox-chunked-upload-v1");
const CHUNK_SESSION_TTL = 12 * 3600;
const TOKEN_SEAL_AAD = Buffer.from("dropbox-link-token-v1");
const PASSWORD_HEADER = "x-dropbox-password";
const MIN_PASSWORD_LEN = 8;
/** Wrong-or-missing password attempts allowed per link+IP per minute. */
const PASSWORD_ATTEMPTS_PER_MIN = 10;

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

interface DropboxChunkMeta {
	v: number;
	did: number;
	th: string;
	owner: number;
	rel: string;
	total: number;
	cs: number;
	n: number;
	fn: string;
	ct: string | null;
	enc: string;
	dir: number | null;
	exp: number;
}

function sealDropboxToken(state: AppState, meta: DropboxChunkMeta): string {
	const raw = Buffer.from(JSON.stringify(meta));
	return seal(
		getMasterKey(state.settings),
		raw,
		DROPBOX_CHUNK_TOKEN_AAD,
	).toString("base64url");
}

/** Mirrors app/routes/dropbox.py::_resolve_dropbox -- looks up an active,
 * unused, unexpired dropbox link by its raw token. */
function resolveDropbox(state: AppState, token: string): DropboxLinkRow {
	const row = state.db.get<DropboxLinkRow>(
		"SELECT * FROM dropbox_upload_links WHERE token_hash = $hash",
		{
			$hash: tokenHash(token),
		},
	);
	if (!row) throw new HttpError(404, "not found");
	if (!row.active || row.used_at !== null)
		throw new HttpError(
			410,
			row.unlimited
				? "this dropbox is closed"
				: "dropbox link has already been used",
		);
	if (row.expires_at !== null && row.expires_at < nowIso())
		throw new HttpError(410, "dropbox link expired");
	return row;
}

/**
 * Decode an upload token and check it was minted for this receive link —
 * *without* requiring the link to still be live.
 *
 * Split out of `openDropboxToken` for the finalize replay path. A finalize that
 * succeeded sets the link `active = 0, used_at = now`, so `resolveDropbox`
 * answers 410 "already been used" from then on. A client whose finalize request
 * died at a proxy timeout while the server was still assembling therefore hit
 * that 410 on its retry and concluded the upload had failed, when in fact the
 * file was stored. The replay has to be answerable after the link is spent.
 *
 * Safe to trust this far on its own: the token is an AEAD blob sealed under the
 * master key, so its `th` binding to this link can't be forged.
 */
function openDropboxChunkMeta(
	state: AppState,
	token: string,
	uploadId: string,
): DropboxChunkMeta {
	let meta: DropboxChunkMeta;
	try {
		const blob = Buffer.from(uploadId, "base64url");
		meta = JSON.parse(
			openBox(
				getMasterKey(state.settings),
				blob,
				DROPBOX_CHUNK_TOKEN_AAD,
			).toString("utf-8"),
		);
	} catch {
		throw new HttpError(400, "invalid upload token");
	}
	if (meta.th !== tokenHash(token)) {
		throw new HttpError(403, "upload token does not match receive link");
	}
	return meta;
}

/** Mirrors app/routes/dropbox.py::_open_dropbox_upload_token. */
function openDropboxToken(
	state: AppState,
	token: string,
	uploadId: string,
): { row: DropboxLinkRow; meta: DropboxChunkMeta } {
	const meta = openDropboxChunkMeta(state, token, uploadId);
	const row = resolveDropbox(state, token);
	if (meta.did !== row.id) {
		throw new HttpError(403, "upload token does not match receive link");
	}
	if (meta.exp < Date.now() / 1000) {
		try {
			// Sync, not the async rm() -- this isn't awaited (openDropboxToken is
			// synchronous), so the promise floated and the catch below never fired
			// on failure, matching routes/files.ts::openChunkToken's equivalent.
			rmSync(partsDir(meta.rel), { recursive: true, force: true });
		} catch {
			// best-effort
		}
		throw new HttpError(410, "upload session expired");
	}
	return { row, meta };
}

/** Gate for the two routes that mint an upload (`/upload` and `/upload/init`).
 * The chunk/status/finalize routes need no password of their own: they're
 * keyed by a sealed `upload_id` that only exists once init passed this. */
async function requireDropboxPassword(
	state: AppState,
	row: DropboxLinkRow,
	req: Request,
): Promise<void> {
	if (!row.password_hash) return;
	const verdict = checkRateLimit(
		`dropbox-pw:${row.id}:${clientIp(state, req)}`,
		PASSWORD_ATTEMPTS_PER_MIN,
	);
	if (!verdict.allowed) throw new HttpError(429, "too many attempts");
	const given = req.header(PASSWORD_HEADER);
	// 403, not 401: the SPA treats a 401 as a dead session.
	if (!given) throw new HttpError(403, "password required");
	if (!(await verifyPassword(given, row.password_hash))) {
		throw new HttpError(403, "wrong password");
	}
}

/** Books a completed upload against its link. One-time links are spent;
 * persistent ones stay open and accumulate totals plus a per-file log. */
function recordDropboxUpload(
	state: AppState,
	row: DropboxLinkRow,
	file: { fileId: number; filename: string; size: number; ip: string },
): void {
	const { db } = state;
	const now = nowIso();
	if (row.unlimited) {
		db.run(
			`UPDATE dropbox_upload_links
          SET upload_count = upload_count + 1, bytes_received = bytes_received + $size, last_used_at = $now
        WHERE id = $id`,
			{ $size: file.size, $now: now, $id: row.id },
		);
		db.run(
			`INSERT INTO dropbox_uploads (link_id, file_id, original_filename, size, ip, created_at)
       VALUES ($link, $file, $name, $size, $ip, $now)`,
			{
				$link: row.id,
				$file: file.fileId,
				$name: file.filename,
				$size: file.size,
				$ip: file.ip,
				$now: now,
			},
		);
		return;
	}
	db.run(
		"UPDATE dropbox_upload_links SET active = 0, used_at = $now WHERE id = $id",
		{ $now: now, $id: row.id },
	);
}

/** Mirrors app/routes/dropbox.py::_dropbox_upload_context -- resolves the
 * dropbox link's owner (and target directory, if any) so the upload is
 * accounted against the link owner's quota/permissions, not the anonymous
 * uploader. */
function dropboxUploadContext(
	state: AppState,
	row: DropboxLinkRow,
): { owner: UserRow; directory: DirectoryRow | null; perm: PermissionRow } {
	const { db } = state;
	const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: row.owner_id,
	});
	if (!owner) throw new HttpError(404, "owner not found");
	let directory: DirectoryRow | null = null;
	if (row.target_directory_id !== null) {
		directory =
			db.get<DirectoryRow>("SELECT * FROM directories WHERE id = $id", {
				$id: row.target_directory_id,
			}) ?? null;
		if (!directory) throw new HttpError(404, "directory not found");
	}
	const perm = ensurePermissions(db, owner.id, {
		master: owner.role === "master",
	});
	return { owner, directory, perm };
}

/** Mounted at /api with no further prefix -- this router owns two unrelated
 * path families (/dropbox-links for owners, /dropbox/:token for anonymous
 * uploaders), so each route spells out its own prefix. */
export function dropboxRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	// ── owner-side link management ──────────────────────────────────────
	router.post(
		"/dropbox-links",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = present(req.currentUser);
			const body = req.body ?? {};
			const targetDirectoryId: number | null = body.target_directory_id ?? null;
			let ownerId = user.id;
			const unlimited = body.unlimited === true;
			const name = cleanName(body.name);
			const password = typeof body.password === "string" ? body.password : "";
			if (unlimited && !password) {
				res
					.status(400)
					.json({ detail: "a persistent dropbox needs a password" });
				return;
			}
			if (password && password.length < MIN_PASSWORD_LEN) {
				res.status(400).json({
					detail: `password must be at least ${MIN_PASSWORD_LEN} characters`,
				});
				return;
			}
			const passwordHash = password ? await hashPassword(password) : null;

			if (targetDirectoryId !== null) {
				const directory = db.get<DirectoryRow>(
					"SELECT * FROM directories WHERE id = $id",
					{ $id: targetDirectoryId },
				);
				if (!directory) {
					res.status(404).json({ detail: "directory not found" });
					return;
				}
				if (!canEditDirectory(state, directory.id, user)) {
					res.status(403).json({ detail: "not your directory" });
					return;
				}
				ownerId = directory.owner_id;
			}

			// Deactivate existing active one-time links for this exact target to
			// prevent unbounded accumulation. Persistent boxes are managed by hand
			// and many can point at the same folder.
			const existing = unlimited
				? []
				: db.all<DropboxLinkRow>(
						"SELECT * FROM dropbox_upload_links WHERE owner_id = $ownerId AND target_directory_id IS $dirId AND active = 1 AND unlimited = 0",
						{ $ownerId: ownerId, $dirId: targetDirectoryId },
					);
			for (const elink of existing) {
				db.run("UPDATE dropbox_upload_links SET active = 0 WHERE id = $id", {
					$id: elink.id,
				});
				recordAudit(db, {
					actor: "system",
					action: "dropbox_link.cancelled",
					target: `dropbox:${elink.id}`,
					ip: "127.0.0.1",
				});
			}

			// A persistent box has no expiry unless one is asked for; a one-time
			// link keeps its 1h default and 30d cap.
			let expiresAt: string | null = null;
			if (!unlimited || body.expires_in_seconds != null) {
				const expiresInSeconds = Math.min(
					Math.max(Number(body.expires_in_seconds ?? 3600), 60),
					60 * 60 * 24 * (unlimited ? 3650 : 30),
				);
				expiresAt = new Date(
					Date.now() + expiresInSeconds * 1000,
				).toISOString();
			}
			const token = randomBytes(32).toString("base64url");
			db.run(
				`INSERT INTO dropbox_upload_links
         (owner_id, target_directory_id, token_hash, active, expires_at, created_at,
          name, password_hash, unlimited, token_sealed)
       VALUES ($ownerId, $dirId, $hash, 1, $expiresAt, $now,
               $name, $pw, $unlimited, $sealed)`,
				{
					$ownerId: ownerId,
					$dirId: targetDirectoryId,
					$hash: tokenHash(token),
					$expiresAt: expiresAt,
					$now: nowIso(),
					$name: name,
					$pw: passwordHash,
					$unlimited: unlimited ? 1 : 0,
					$sealed: unlimited ? sealLinkToken(state, token) : null,
				},
			);
			const row = present(
				db.get<DropboxLinkRow>(
					"SELECT * FROM dropbox_upload_links WHERE id = last_insert_rowid()",
				),
			);
			recordAudit(db, {
				actor: user.username,
				action: unlimited
					? "dropbox_link.created_persistent"
					: "dropbox_link.created",
				target: `dropbox:${row.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`dropbox link created id=${row.id} owner_id=${ownerId} directory_id=${targetDirectoryId} expires_at=${expiresAt}`,
			);

			const base = `${requestProtocol(state.settings, req)}://${req.get("host")}`;
			res.json({
				id: row.id,
				token,
				url: `${base}/?receive=${encodeURIComponent(token)}`,
				upload_url: `${base}/dropbox/${token}/upload`,
				target_directory_id: targetDirectoryId,
				expires_at: expiresAt,
				name,
				unlimited,
				has_password: passwordHash !== null,
			});
		}),
	);

	// Everything the owner has, newest first. Persistent boxes carry their
	// sealed token back out so the URL can be copied again.
	router.get(
		"/dropbox-links",
		requireSession(state),
		requireActiveUser(state),
		(req, res) => {
			const user = present(req.currentUser);
			const rows = db.all<DropboxLinkRow>(
				`SELECT * FROM dropbox_upload_links
          WHERE owner_id = $owner AND (unlimited = 1 OR (active = 1 AND used_at IS NULL))
          ORDER BY id DESC`,
				{ $owner: user.id },
			);
			const base = `${requestProtocol(state.settings, req)}://${req.get("host")}`;
			res.json(
				rows.map((r) => {
					const token = r.token_sealed
						? openLinkToken(state, r.token_sealed)
						: null;
					return {
						id: r.id,
						name: r.name,
						target_directory_id: r.target_directory_id,
						unlimited: !!r.unlimited,
						has_password: !!r.password_hash,
						active: !!r.active,
						expires_at: r.expires_at,
						created_at: r.created_at,
						upload_count: r.upload_count,
						bytes_received: r.bytes_received,
						last_used_at: r.last_used_at,
						token,
						url: token ? `${base}/?receive=${encodeURIComponent(token)}` : null,
					};
				}),
			);
		},
	);

	router.get(
		"/dropbox-links/:id/uploads",
		requireSession(state),
		requireActiveUser(state),
		(req, res) => {
			const row = ownedLink(state, req, res);
			if (!row) return;
			const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
			res.json(
				db.all<DropboxUploadRow>(
					"SELECT * FROM dropbox_uploads WHERE link_id = $id ORDER BY id DESC LIMIT $limit",
					{ $id: row.id, $limit: limit },
				),
			);
		},
	);

	// Rename, pause/resume, or change the password. A persistent box can't have
	// its password removed: the password is the only thing guarding an
	// open-ended, expiry-less drop point.
	router.patch(
		"/dropbox-links/:id",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = present(req.currentUser);
			const row = ownedLink(state, req, res);
			if (!row) return;
			const body = req.body ?? {};
			if ("name" in body) {
				db.run("UPDATE dropbox_upload_links SET name = $n WHERE id = $id", {
					$n: cleanName(body.name),
					$id: row.id,
				});
			}
			if (typeof body.active === "boolean") {
				db.run("UPDATE dropbox_upload_links SET active = $a WHERE id = $id", {
					$a: body.active ? 1 : 0,
					$id: row.id,
				});
			}
			if ("password" in body) {
				const pw = body.password;
				if (pw === null || pw === "") {
					if (row.unlimited) {
						res
							.status(400)
							.json({ detail: "a persistent dropbox needs a password" });
						return;
					}
					db.run(
						"UPDATE dropbox_upload_links SET password_hash = NULL WHERE id = $id",
						{ $id: row.id },
					);
				} else if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LEN) {
					res.status(400).json({
						detail: `password must be at least ${MIN_PASSWORD_LEN} characters`,
					});
					return;
				} else {
					db.run(
						"UPDATE dropbox_upload_links SET password_hash = $h WHERE id = $id",
						{ $h: await hashPassword(pw), $id: row.id },
					);
				}
			}
			recordAudit(db, {
				actor: user.username,
				action: "dropbox_link.updated",
				target: `dropbox:${row.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "ok" });
		}),
	);

	// Hard delete, including the receive log. (DELETE /dropbox-links/:token
	// below only deactivates.)
	router.delete(
		"/dropbox-links/by-id/:id",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = present(req.currentUser);
			const row = ownedLink(state, req, res);
			if (!row) return;
			db.run("DELETE FROM dropbox_upload_links WHERE id = $id", {
				$id: row.id,
			});
			recordAudit(db, {
				actor: user.username,
				action: "dropbox_link.deleted",
				target: `dropbox:${row.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "deleted" });
		},
	);

	router.delete(
		"/dropbox-links/:token",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = present(req.currentUser);
			const row = db.get<DropboxLinkRow>(
				"SELECT * FROM dropbox_upload_links WHERE token_hash = $hash",
				{
					$hash: tokenHash(req.params.token),
				},
			);
			if (!row) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (row.owner_id !== user.id && user.role !== "master") {
				res.status(403).json({ detail: "not your link" });
				return;
			}
			if (!row.active) {
				res.status(410).json({ detail: "link already inactive" });
				return;
			}
			db.run("UPDATE dropbox_upload_links SET active = 0 WHERE id = $id", {
				$id: row.id,
			});
			recordAudit(db, {
				actor: user.username,
				action: "dropbox_link.cancelled",
				target: `dropbox:${row.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "cancelled" });
		},
	);

	// ── public (unauthenticated, token-gated) upload surface ────────────
	router.get("/dropbox/:token", (req, res) => {
		try {
			const row = resolveDropbox(state, req.params.token);
			res.json({
				status: "active",
				target_directory_id: row.target_directory_id,
				expires_at: row.expires_at,
				name: row.name,
				unlimited: !!row.unlimited,
				password_required: !!row.password_hash,
			});
		} catch (err) {
			respondError(res, err);
		}
	});

	router.post("/dropbox/:token/upload/init", async (req, res) => {
		try {
			const row = resolveDropbox(state, req.params.token);
			await requireDropboxPassword(state, row, req);
			const { owner, directory, perm } = dropboxUploadContext(state, row);
			const body = req.body ?? {};
			const totalSize = Number(body.total_size ?? 0);
			precheckDeclaredSize(state, owner, perm, totalSize);

			const chunkSize = chunkUploadSize();
			const n = numChunks(totalSize, chunkSize);
			const rand = randomBytes(32).toString("hex");
			const relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
			mkdirSync(join(storageRoot(), rand.slice(0, 2), rand.slice(2, 4)), {
				recursive: true,
			});
			mkdirSync(partsDir(relPath), { recursive: true });
			prepareAssembly(relPath);

			const meta: DropboxChunkMeta = {
				v: 1,
				did: row.id,
				th: row.token_hash,
				owner: owner.id,
				rel: relPath,
				total: totalSize,
				cs: chunkSize,
				n,
				fn: String(body.original_filename ?? "upload"),
				ct: body.content_type ?? null,
				enc: directory ? directory.encryption_mode : "none",
				dir: directory ? directory.id : null,
				exp: Math.floor(Date.now() / 1000) + CHUNK_SESSION_TTL,
			};
			log.info(
				`dropbox chunked upload initialized id=${row.id} owner_id=${owner.id} total_bytes=${totalSize} chunks=${n} chunk_size=${chunkSize}`,
			);
			res.json({
				upload_id: sealDropboxToken(state, meta),
				chunk_size: chunkSize,
				num_chunks: n,
				total: totalSize,
				received: [],
			});
		} catch (err) {
			respondError(res, err);
		}
	});

	router.get("/dropbox/:token/upload/status", (req, res) => {
		try {
			const { meta } = openDropboxToken(
				state,
				req.params.token,
				String(req.query.upload_id ?? ""),
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

	router.post("/dropbox/:token/upload/chunk", (req, res, next) => {
		let meta: DropboxChunkMeta;
		try {
			({ meta } = openDropboxToken(
				state,
				req.params.token,
				String(req.query.upload_id ?? ""),
			));
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
		receiveChunkAt(
			req,
			res,
			next,
			{ parts, relPath: meta.rel, index, expected, chunkSize: meta.cs },
			() => res.json({ index, num_chunks: meta.n }),
		);
	});

	router.post(
		"/dropbox/:token/upload/finalize",
		asyncHandler(async (req, res) => {
			try {
				const uploadId = String(req.body?.upload_id ?? "");
				// Decoded before the link is resolved, and replayed before anything
				// else: a finalize that already succeeded spent the link (410 from
				// `resolveDropbox`) and removed the `.parts` dir (410 here), so both
				// of those checks would turn a stored file's poll into a failure.
				const early = openDropboxChunkMeta(state, req.params.token, uploadId);
				if (replayFinalize(res, early.rel, `dropbox id=${early.did}`)) return;

				const { row, meta } = openDropboxToken(
					state,
					req.params.token,
					uploadId,
				);
				const { owner, directory, perm } = dropboxUploadContext(state, row);

				const relPath = meta.rel;
				const parts = partsDir(relPath);
				// This route had no finalize serialization at all, so two uploaders
				// (or one client polling) could finalize the same upload
				// concurrently — two passes racing to rename onto the same path, and
				// a `dropbox.uploaded` audit entry for each.
				if (isFinalizing(relPath)) {
					res.status(409).json({ detail: "upload busy, retry shortly" });
					return;
				}
				if (!existsSync(parts)) {
					res.status(410).json({ detail: "upload session gone" });
					return;
				}
				const received = new Set(receivedIndices(parts, meta.n));
				const missing: number[] = [];
				for (let i = 0; i < meta.n; i++) if (!received.has(i)) missing.push(i);
				if (missing.length) {
					log.info(
						`dropbox chunked upload finalize incomplete id=${row.id} missing_count=${missing.length}`,
					);
					res.status(409).json({
						detail: {
							error: "upload incomplete",
							missing: missing.slice(0, 512),
						},
					});
					return;
				}

				// Chunks were written straight to their offsets, so the assembly is
				// already complete and this is a stat, not a copy. A session staged
				// before that change still needs concatenating first.
				const work = assemblyPath(relPath);
				let plainHashes: FileHashes | undefined;
				if (isLegacyPartsLayout(parts, meta.n)) {
					plainHashes = await assembleChunks(parts, work, meta.n);
				}
				const stored = existsSync(work) ? statSync(work).size : -1;
				if (stored !== meta.total) {
					res.status(400).json({ detail: "assembled size mismatch" });
					return;
				}

				// Read while the socket is still up — see FinalizeOpts.requestOrigin.
				const requestOrigin = {
					ip: clientIp(state, req),
					baseUrl: `${requestProtocol(state.settings, req)}://${req.get("host")}`,
				};
				startFinalize(res, relPath, `dropbox id=${row.id}`, async () => {
					const result = await finalizeStoredFile({
						state,
						req,
						user: owner,
						perm,
						directory,
						requestOrigin,
						workPath: work,
						relPath,
						stored,
						plainHashes,
						contentType: meta.ct,
						encryptionMode: meta.enc,
						compress: false,
						randomizeFilename: false,
						originalFilename: meta.fn,
						isPermanent: true,
						tempDays: null,
						deleteIfIdleDays: null,
						archiveAfterIdleDays: null,
						autoUnarchiveOnDownload: true,
						maxUses: null,
						expiresInSeconds: null,
						sourceType: "dropbox",
					});
					recordDropboxUpload(state, row, {
						fileId: Number(result.file_id),
						filename: meta.fn,
						size: meta.total,
						ip: requestOrigin.ip,
					});
					recordAudit(db, {
						actor: "dropbox",
						action: "dropbox.uploaded",
						target: `dropbox:${row.id}:file:${result.file_id}`,
						ip: requestOrigin.ip,
					});
					void triggerWebhooks(state, owner.id, "dropbox.received", {
						file_id: result.file_id,
						original_filename: meta.fn,
						dropbox_id: row.id,
						dropbox_name: row.name,
					}).catch(() => {});
					await rm(parts, { recursive: true, force: true });
					log.info(
						`dropbox chunked upload completed id=${row.id} file_id=${result.file_id} owner_id=${owner.id}`,
					);
					return result;
				});
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	router.post("/dropbox/:token/upload", async (req, res) => {
		let row: DropboxLinkRow;
		let owner: UserRow;
		let directory: DirectoryRow | null;
		let perm: PermissionRow;
		try {
			row = resolveDropbox(state, req.params.token);
			await requireDropboxPassword(state, row, req);
			({ owner, directory, perm } = dropboxUploadContext(state, row));
		} catch (err) {
			respondError(res, err);
			return;
		}

		// Pre-check against Content-Length if the client declares it -- rejects
		// obviously oversized uploads before any bytes are streamed to disk.
		// Ignored if unreliable/absent; the per-write cap below still applies.
		const declared = req.header("content-length");
		if (declared !== undefined) {
			try {
				precheckDeclaredSize(state, owner, perm, Number(declared));
			} catch {
				// best-effort, see app/routes/dropbox.py::upload_to_dropbox
			}
		}

		const rand = randomBytes(32).toString("hex");
		const relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
		const basePath = join(storageRoot(), relPath);
		mkdirSync(join(basePath, ".."), { recursive: true });
		const work = `${basePath}.dropbox.work`;

		let originalFilename = "upload";
		let contentType: string | null = null;
		let written = 0;
		let fileSeen = false;
		let handled = false;

		// The route is `file` + `original_filename` multipart fields (busboy),
		// mirroring FastAPI's UploadFile + Form parsing.
		const bb = busboy({ headers: req.headers });
		const out = createWriteStream(work);
		let writeDone: Promise<void> | null = null;

		bb.on("field", (name, value) => {
			if (name === "original_filename") originalFilename = value;
		});
		bb.on("file", (_name, stream, info) => {
			fileSeen = true;
			contentType = info.mimeType || null;
			stream.on("data", (chunk: Buffer) => {
				if (handled) return;
				written += chunk.length;
				if (written > perm.max_file_bytes) {
					handled = true;
					out.destroy();
					stream.destroy();
					try {
						unlinkSync(work);
					} catch {
						// best-effort
					}
					if (!res.headersSent)
						res.status(413).json({ detail: "file exceeds max file size" });
					return;
				}
				out.write(chunk);
			});
			writeDone = new Promise((resolve, reject) => {
				stream.on("end", () => out.end(() => resolve()));
				stream.on("error", (err) => {
					out.destroy();
					reject(err instanceof Error ? err : new Error(String(err)));
				});
			});
		});
		bb.on("close", () => {
			if (handled) return;
			if (!fileSeen || !writeDone) {
				res.status(400).json({ detail: "no file uploaded" });
				return;
			}
			handled = true;
			writeDone
				.then(async () => {
					if (usedBytes(state, owner.id) + written > perm.quota_bytes) {
						throw new HttpError(413, "upload would exceed owner quota");
					}
					const result = await finalizeStoredFile({
						state,
						req,
						user: owner,
						perm,
						directory,
						workPath: work,
						relPath,
						stored: written,
						contentType,
						encryptionMode: directory ? directory.encryption_mode : "none",
						compress: false,
						randomizeFilename: false,
						originalFilename,
						isPermanent: true,
						tempDays: null,
						deleteIfIdleDays: null,
						archiveAfterIdleDays: null,
						autoUnarchiveOnDownload: true,
						maxUses: null,
						expiresInSeconds: null,
						sourceType: "dropbox",
					});
					recordDropboxUpload(state, row, {
						fileId: Number(result.file_id),
						filename: originalFilename,
						size: written,
						ip: clientIp(state, req),
					});
					recordAudit(db, {
						actor: "dropbox",
						action: "dropbox.uploaded",
						target: `dropbox:${row.id}:file:${result.file_id}`,
						ip: clientIp(state, req),
					});
					void triggerWebhooks(state, owner.id, "dropbox.received", {
						file_id: result.file_id,
						original_filename: originalFilename,
						dropbox_id: row.id,
						dropbox_name: row.name,
					}).catch(() => {});
					log.info(
						`dropbox upload completed id=${row.id} file_id=${result.file_id} owner_id=${owner.id}`,
					);
					return result;
				})
				.then((result) => res.json(result))
				.catch((err) => {
					try {
						if (existsSync(work)) unlinkSync(work);
					} catch {
						// best-effort
					}
					log.error(
						`dropbox upload failed id=${row.id} owner_id=${owner.id} bytes=${written}`,
					);
					respondError(res, err);
				});
		});
		bb.on("error", (err: unknown) => {
			try {
				if (existsSync(work)) unlinkSync(work);
			} catch {
				// best-effort
			}
			respondError(res, err);
		});
		req.pipe(bb);
	});

	return router;
}

function cleanName(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim().slice(0, 80);
	return t || null;
}

function sealLinkToken(state: AppState, token: string): string {
	return seal(
		getMasterKey(state.settings),
		Buffer.from(token),
		TOKEN_SEAL_AAD,
	).toString("base64url");
}

function openLinkToken(state: AppState, sealed: string): string | null {
	try {
		return openBox(
			getMasterKey(state.settings),
			Buffer.from(sealed, "base64url"),
			TOKEN_SEAL_AAD,
		).toString("utf-8");
	} catch {
		return null;
	}
}

/** Loads `:id` and checks the caller owns it (masters may manage any). Writes
 * the 404/403 itself and returns null so the handler can just bail. */
function ownedLink(
	state: AppState,
	req: Request,
	res: Response,
): DropboxLinkRow | null {
	const user = present(req.currentUser);
	const row = state.db.get<DropboxLinkRow>(
		"SELECT * FROM dropbox_upload_links WHERE id = $id",
		{ $id: Number(req.params.id) },
	);
	if (!row) {
		res.status(404).json({ detail: "not found" });
		return null;
	}
	if (row.owner_id !== user.id && user.role !== "master") {
		res.status(403).json({ detail: "not your link" });
		return null;
	}
	return row;
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
