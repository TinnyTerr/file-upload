import { createHash, randomBytes } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
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
	nowIso,
	type PermissionRow,
	type UserRow,
} from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireActiveUser } from "../middleware/deps.ts";
import { ensurePermissions } from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import { storageRoot } from "../storage/paths.ts";
import {
	canEditDirectory,
	chunkUploadSize,
	expectedChunkLen,
	finalizeStoredFile,
	numChunks,
	partsDir,
	precheckDeclaredSize,
	receivedIndices,
	usedBytes,
} from "./files.ts";

const log = getLogger("app.routes.dropbox");

const DROPBOX_CHUNK_TOKEN_AAD = Buffer.from("dropbox-chunked-upload-v1");
const CHUNK_SESSION_TTL = 12 * 3600;

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
		throw new HttpError(410, "dropbox link has already been used");
	if (row.expires_at !== null && row.expires_at < nowIso())
		throw new HttpError(410, "dropbox link expired");
	return row;
}

/** Mirrors app/routes/dropbox.py::_open_dropbox_upload_token. */
function openDropboxToken(
	state: AppState,
	token: string,
	uploadId: string,
): { row: DropboxLinkRow; meta: DropboxChunkMeta } {
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
	const row = resolveDropbox(state, token);
	if (meta.did !== row.id || meta.th !== row.token_hash) {
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
		(req, res) => {
			const user = req.currentUser!;
			const body = req.body ?? {};
			const targetDirectoryId: number | null = body.target_directory_id ?? null;
			let ownerId = user.id;

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

			// Deactivate existing active links for this exact target to prevent
			// unbounded accumulation.
			const existing = db.all<DropboxLinkRow>(
				"SELECT * FROM dropbox_upload_links WHERE owner_id = $ownerId AND target_directory_id IS $dirId AND active = 1",
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

			const expiresInSeconds = Math.min(
				Math.max(Number(body.expires_in_seconds ?? 3600), 60),
				60 * 60 * 24 * 30,
			);
			const token = randomBytes(32).toString("base64url");
			const expiresAt = new Date(
				Date.now() + expiresInSeconds * 1000,
			).toISOString();
			db.run(
				`INSERT INTO dropbox_upload_links (owner_id, target_directory_id, token_hash, active, expires_at, created_at)
       VALUES ($ownerId, $dirId, $hash, 1, $expiresAt, $now)`,
				{
					$ownerId: ownerId,
					$dirId: targetDirectoryId,
					$hash: tokenHash(token),
					$expiresAt: expiresAt,
					$now: nowIso(),
				},
			);
			const row = db.get<DropboxLinkRow>(
				"SELECT * FROM dropbox_upload_links WHERE id = last_insert_rowid()",
			)!;
			recordAudit(db, {
				actor: user.username,
				action: "dropbox_link.created",
				target: `dropbox:${row.id}`,
				ip: clientIp(state, req),
			});
			log.info(
				`dropbox link created id=${row.id} owner_id=${ownerId} directory_id=${targetDirectoryId} expires_at=${expiresAt}`,
			);

			const base = `${req.protocol}://${req.get("host")}`;
			res.json({
				id: row.id,
				token,
				url: `${base}/?receive=${encodeURIComponent(token)}`,
				upload_url: `${base}/dropbox/${token}/upload`,
				target_directory_id: targetDirectoryId,
				expires_at: expiresAt,
			});
		},
	);

	router.delete(
		"/dropbox-links/:token",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
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
			});
		} catch (err) {
			respondError(res, err);
		}
	});

	router.post("/dropbox/:token/upload/init", (req, res) => {
		try {
			const row = resolveDropbox(state, req.params.token);
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
		"/dropbox/:token/upload/finalize",
		asyncHandler(async (req, res) => {
			// Hoisted so the catch below can clean it up on failure -- mirrors
			// routes/files.ts's /upload/finalize, which unlinks its assembled `.part`
			// file on error so it doesn't silently inflate disk use past what quota
			// accounting reports until the stale-part sweep eventually catches it.
			let work: string | null = null;
			try {
				const uploadId = String(req.body?.upload_id ?? "");
				const { row, meta } = openDropboxToken(
					state,
					req.params.token,
					uploadId,
				);
				const { owner, directory, perm } = dropboxUploadContext(state, row);

				const relPath = meta.rel;
				const parts = partsDir(relPath);
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

				work = `${join(storageRoot(), relPath)}.dropbox.part`;
				const out = createWriteStream(work);
				for (let i = 0; i < meta.n; i++) {
					const chunkPath = join(parts, String(i));
					await new Promise<void>((resolve, reject) => {
						const rs = createReadStream(chunkPath);
						rs.on("error", reject);
						rs.on("end", resolve);
						rs.pipe(out, { end: false });
					});
				}
				await new Promise<void>((resolve) => out.end(resolve));
				const stored = statSync(work).size;
				if (stored !== meta.total) {
					unlinkSync(work);
					res.status(400).json({ detail: "assembled size mismatch" });
					return;
				}

				const result = await finalizeStoredFile({
					state,
					req,
					user: owner,
					perm,
					directory,
					workPath: work,
					relPath,
					stored,
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
				db.run(
					"UPDATE dropbox_upload_links SET active = 0, used_at = $now WHERE id = $id",
					{
						$now: nowIso(),
						$id: row.id,
					},
				);
				recordAudit(db, {
					actor: "dropbox",
					action: "dropbox.uploaded",
					target: `dropbox:${row.id}:file:${result.file_id}`,
					ip: clientIp(state, req),
				});
				await rm(parts, { recursive: true, force: true });
				log.info(
					`dropbox chunked upload completed id=${row.id} file_id=${result.file_id} owner_id=${owner.id}`,
				);
				res.json(result);
			} catch (err) {
				if (work) {
					try {
						unlinkSync(work);
					} catch {
						// best-effort
					}
				}
				respondError(res, err);
			}
		}),
	);

	router.post("/dropbox/:token/upload", (req, res) => {
		let row: DropboxLinkRow;
		let owner: UserRow;
		let directory: DirectoryRow | null;
		let perm: PermissionRow;
		try {
			row = resolveDropbox(state, req.params.token);
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
					// No local quota read here: `finalizeStoredFile` takes the
					// reservation from the master with the bytes that actually
					// arrived, which is the only figure worth checking -- an
					// anonymous dropbox uploader's declared size is a claim, and
					// `written` is the fact.
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
					db.run(
						"UPDATE dropbox_upload_links SET active = 0, used_at = $now WHERE id = $id",
						{
							$now: nowIso(),
							$id: row.id,
						},
					);
					recordAudit(db, {
						actor: "dropbox",
						action: "dropbox.uploaded",
						target: `dropbox:${row.id}:file:${result.file_id}`,
						ip: clientIp(state, req),
					});
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
