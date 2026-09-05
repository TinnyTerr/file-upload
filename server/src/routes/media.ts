/**
 * Media library ("watch") -- a Netflix-shaped view over folders that have been
 * published with `directories.is_library`.
 *
 * Two audiences, one router:
 *
 *   - `library_visibility = 'public'` collections are browsable and streamable
 *     with no account at all, like a share link whose slug is the credential.
 *   - `'restricted'` collections need an account holding `can_watch_media`
 *     (the owner and masters always qualify).
 *
 * External players don't carry a session cookie, so restricted media is also
 * reachable with a **play key** (media/playKeys.ts): a sealed token pasted onto
 * the stream URL as `?k=`, minted per file or per collection, revocable, and
 * expiring. That is the mpv path:
 *
 *     mpv "https://host/api/media/stream/12?k=<token>"
 *     mpv "https://host/api/media/library/<slug>/playlist.m3u?k=<token>"
 *
 * Seeking: a file stored untransformed is served with `Accept-Ranges: bytes`
 * and honours Range, so mpv can seek. A server-encrypted, compressed or
 * archived file has to be reproduced from byte zero (storage/streaming.ts), so
 * it streams 200-only and the player can't seek it. `entries[].seekable` says
 * which is which rather than leaving the client to guess.
 */

import { createReadStream, existsSync } from "node:fs";
import { type Request, Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { touchBlobAccess } from "../cluster/cacheEviction.ts";
import { resolveFileEncryption } from "../crypto/effectiveEncryption.ts";
import {
	type DirectoryRow,
	type FileRow,
	type MediaPlayKeyRow,
	nowIso,
	type UserRow,
} from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import {
	clampTtl,
	listPlayKeys,
	mintPlayKey,
	playKeyCoversFile,
	revokePlayKey,
	touchPlayKey,
	verifyPlayKey,
} from "../media/playKeys.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { optionalOauthViewer, requireActiveUser } from "../middleware/deps.ts";
import { BYTES_HEADERS } from "../middleware/securityHeaders.ts";
import { ensurePermissions } from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { backfillMediaInfo } from "../storage/mediaProbe.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";
import {
	ensureBlobAvailable,
	isDirectlyStreamable,
	PlaintextUnavailable,
	plaintextStream,
	statOrNull,
} from "../storage/streaming.ts";
import { getOrCreateThumbnail } from "../storage/thumbnail.ts";

const log = getLogger("app.routes.media");
const CHUNK = 256 * 1024;

const VISIBILITIES = new Set(["public", "restricted"]);
const KINDS = new Set(["movie", "series"]);

/** A folder's playable children: what the library actually lists. */
function isPlayable(ct: string): boolean {
	return ct.startsWith("video/") || ct.startsWith("audio/");
}

interface BlobMediaRow {
	media_width: number | null;
	media_height: number | null;
	media_duration_seconds: number | null;
}

/** Resolves the caller's account from the session cookie without demanding one.
 * Browsing the public library must work logged-out, so this returns null rather
 * than answering 401 -- the per-collection visibility check does the gating. */
function optionalViewer(state: AppState, req: Request): UserRow | null {
	// An OAuth token carrying media:read identifies a viewer just as a session
	// cookie does; canWatch() below still re-checks can_watch_media, so the
	// token can never widen what its user may see.
	const oauthViewer = optionalOauthViewer(state, req, "media:read");
	if (oauthViewer) return oauthViewer;
	const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
	if (!cookie) return null;
	const row = state.sessionManager.resolve(state.db, cookie);
	if (!row) return null;
	const user = state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: row.user_id,
	});
	if (!user || user.must_change_credentials) return null;
	return user;
}

/** Entitlement for a published collection. Owner and master always pass;
 * everyone else needs can_watch_media, and only for restricted collections. */
function canWatch(
	state: AppState,
	dir: DirectoryRow,
	viewer: UserRow | null,
): boolean {
	if (!dir.is_library) return false;
	if (dir.library_visibility === "public") return true;
	if (!viewer) return false;
	if (viewer.role === "master" || dir.owner_id === viewer.id) return true;
	const perm = ensurePermissions(state.db, viewer.id, {
		master: viewer.role === "master",
	});
	return !!perm.can_watch_media;
}

/** Publishing/editing a collection is an ownership act, not a watching one. */
function canCurate(dir: DirectoryRow, user: UserRow): boolean {
	return user.role === "master" || dir.owner_id === user.id;
}

function publishedDir(db: Db, slug: string): DirectoryRow | null {
	const dir = db.get<DirectoryRow>(
		"SELECT * FROM directories WHERE slug = $slug AND is_library = 1",
		{ $slug: slug },
	);
	return dir ?? null;
}

function playableFiles(db: Db, directoryId: number): FileRow[] {
	return db
		.all<FileRow>(
			`SELECT * FROM files WHERE directory_id = $dir
       ORDER BY original_filename COLLATE NOCASE ASC`,
			{ $dir: directoryId },
		)
		.filter((f) => isPlayable(f.content_type));
}

function baseUrl(req: Request): string {
	return `${req.protocol}://${req.get("host")}`;
}

function serializeEntry(db: Db, f: FileRow) {
	const blob = f.blob_id
		? db.get<BlobMediaRow>(
				"SELECT media_width, media_height, media_duration_seconds FROM content_blobs WHERE id = $id",
				{ $id: f.blob_id },
			)
		: undefined;
	return {
		file_id: f.id,
		title: f.original_filename,
		content_type: f.content_type,
		size_bytes: f.size_bytes,
		kind: f.content_type.startsWith("audio/") ? "audio" : "video",
		duration_seconds: blob?.media_duration_seconds ?? null,
		width: blob?.media_width ?? null,
		height: blob?.media_height ?? null,
		// Client-encrypted media can't be played by an external player at all --
		// only the browser holds the key -- so flag it rather than hand out a
		// stream URL that yields ciphertext.
		client_encrypted: ["client", "sealed"].includes(
			resolveFileEncryption(db, f).mode,
		),
		// See the module docstring: transformed files stream from byte zero only.
		seekable: isDirectlyStreamable(db, f),
		archived: !!f.archived,
	};
}

function serializeCollection(
	db: Db,
	dir: DirectoryRow,
	viewer: UserRow | null,
	opts: { withEntries?: boolean } = {},
) {
	const entries = playableFiles(db, dir.id);
	const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: dir.owner_id,
	});
	const durations = entries
		.map((f) =>
			f.blob_id
				? (db.get<BlobMediaRow>(
						"SELECT media_duration_seconds FROM content_blobs WHERE id = $id",
						{ $id: f.blob_id },
					)?.media_duration_seconds ?? 0)
				: 0,
		)
		.reduce((a, b) => a + b, 0);

	return {
		slug: dir.slug,
		directory_id: dir.id,
		title: dir.title,
		overview: dir.library_overview,
		kind: dir.library_kind,
		visibility: dir.library_visibility,
		entry_count: entries.length,
		total_duration_seconds: durations || null,
		published_at: dir.library_published_at,
		uploader: dir.hide_uploader || !owner ? null : { username: owner.username },
		has_poster: entries.length > 0 || dir.library_poster_file_id !== null,
		can_curate: viewer ? canCurate(dir, viewer) : false,
		...(opts.withEntries
			? { entries: entries.map((f) => serializeEntry(db, f)) }
			: {}),
	};
}

/** The file a collection's cover art is rendered from: the curated poster if it
 * still lives in the folder, else the first playable entry. */
function posterFile(db: Db, dir: DirectoryRow): FileRow | null {
	if (dir.library_poster_file_id) {
		const f = db.get<FileRow>(
			"SELECT * FROM files WHERE id = $id AND directory_id = $dir",
			{ $id: dir.library_poster_file_id, $dir: dir.id },
		);
		if (f) return f;
	}
	return playableFiles(db, dir.id)[0] ?? null;
}

function parseRange(header: string, fileSize: number): [number, number] | null {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	const [, s, e] = m;
	let start: number;
	let end: number;
	if (s) {
		start = Number(s);
		end = e ? Number(e) : fileSize - 1;
		if (end >= fileSize) end = fileSize - 1;
	} else if (e) {
		const suffix = Number(e);
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		return null;
	}
	if (start > end || start >= fileSize) return null;
	return [start, end];
}

/** Authorizes a stream request by either credential: a session with watch
 * entitlement, or a play key whose scope covers this exact file. Returns the
 * play key row (when that was the credential) so the caller can touch it. */
function authorizeStream(
	state: AppState,
	req: Request,
	f: FileRow,
	dir: DirectoryRow,
):
	| { ok: true; keyRow: MediaPlayKeyRow | null }
	| { ok: false; error: HttpError } {
	if (dir.library_visibility === "public") return { ok: true, keyRow: null };

	const token = typeof req.query.k === "string" ? req.query.k : null;
	if (token) {
		const result = verifyPlayKey(state, token, clientIp(state, req));
		if (!result.ok) {
			if (result.reason === "wrong_node") {
				return {
					ok: false,
					error: new HttpError(
						403,
						`play key was issued by a different cluster node (${result.nodeId || "unknown"}); stream from that node or mint a key here`,
					),
				};
			}
			const detail =
				result.reason === "expired"
					? "play key expired"
					: result.reason === "revoked"
						? "play key revoked"
						: result.reason === "ip_mismatch"
							? "play key is bound to a different address"
							: "invalid play key";
			return { ok: false, error: new HttpError(401, detail) };
		}
		if (!playKeyCoversFile(result, f.id, f.directory_id)) {
			return {
				ok: false,
				error: new HttpError(403, "play key does not cover this title"),
			};
		}
		// The key's holder still has to be entitled *now* -- revoking
		// can_watch_media or deleting the account must kill outstanding keys
		// without anyone having to hunt them down individually.
		const keyUser = state.db.get<UserRow>(
			"SELECT * FROM users WHERE id = $id",
			{ $id: result.row.user_id },
		);
		if (!keyUser || !canWatch(state, dir, keyUser)) {
			return {
				ok: false,
				error: new HttpError(403, "play key owner is no longer entitled"),
			};
		}
		return { ok: true, keyRow: result.row };
	}

	const viewer = optionalViewer(state, req);
	if (!canWatch(state, dir, viewer)) {
		return {
			ok: false,
			error: new HttpError(
				viewer ? 403 : 401,
				viewer
					? "not entitled to this title"
					: "authentication or a play key (?k=) is required",
			),
		};
	}
	return { ok: true, keyRow: null };
}

/** Resolves a file id to (file, its published collection), 404ing on anything
 * that isn't in a library folder -- the media routes must never become a second
 * way to read arbitrary files. */
function resolvePublishedFile(
	db: Db,
	fileId: number,
): { file: FileRow; dir: DirectoryRow } | null {
	if (!Number.isInteger(fileId)) return null;
	const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
		$id: fileId,
	});
	if (!f || f.directory_id === null || !isPlayable(f.content_type)) return null;
	const dir = db.get<DirectoryRow>(
		"SELECT * FROM directories WHERE id = $id AND is_library = 1",
		{ $id: f.directory_id },
	);
	if (!dir) return null;
	return { file: f, dir };
}

/** Locates a file's bytes, pulling them from a peer first if this node's copy
 * is missing (cache-mode nodes, local disk loss). */
async function localPath(state: AppState, f: FileRow): Promise<string | null> {
	let fullPath: string;
	try {
		fullPath = safeJoin(storageRoot(), f.storage_path);
	} catch {
		return null;
	}
	if (!existsSync(fullPath)) await ensureBlobAvailable(state, f, fullPath);
	return existsSync(fullPath) ? fullPath : null;
}

export function mediaRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	// ---------------------------------------------------------------- browse

	/** The library index. Anonymous callers see public collections; an entitled
	 * account additionally sees restricted ones. */
	router.get("/library", (req, res) => {
		const viewer = optionalViewer(state, req);
		const rows = db.all<DirectoryRow>(
			"SELECT * FROM directories WHERE is_library = 1 ORDER BY library_published_at DESC",
		);
		const visible = rows.filter((d) => canWatch(state, d, viewer));
		res.json({
			collections: visible.map((d) => serializeCollection(db, d, viewer)),
			viewer: viewer
				? { username: viewer.username, can_watch_media: true }
				: null,
		});
	});

	router.get("/library/:slug", (req, res) => {
		const dir = publishedDir(db, req.params.slug);
		if (!dir) throw new HttpError(404, "not found");
		const viewer = optionalViewer(state, req);
		if (!canWatch(state, dir, viewer)) {
			// Deliberately 404, not 403: a restricted collection's existence and
			// title shouldn't be discoverable by slug-guessing.
			throw new HttpError(404, "not found");
		}
		res.json(serializeCollection(db, dir, viewer, { withEntries: true }));
	});

	/** Cover art. Small cached JPEG, same generator as share-link thumbnails. */
	router.get(
		"/library/:slug/poster",
		asyncHandler(async (req, res) => {
			const dir = publishedDir(db, req.params.slug);
			if (!dir) throw new HttpError(404, "not found");
			const viewer = optionalViewer(state, req);
			if (!canWatch(state, dir, viewer)) throw new HttpError(404, "not found");

			const f = posterFile(db, dir);
			if (!f) throw new HttpError(404, "no poster available");
			// Cover art comes from a thumbnail of the raw bytes, so anything
			// transformed at rest simply has no poster.
			if (
				resolveFileEncryption(db, f).mode !== "none" ||
				f.compressed ||
				f.archived
			) {
				throw new HttpError(404, "no poster available");
			}
			const fullPath = await localPath(state, f);
			if (!fullPath) throw new HttpError(404, "no poster available");
			const thumb = await getOrCreateThumbnail(f.id, fullPath, f.content_type);
			if (!thumb) throw new HttpError(404, "no poster available");
			const size = statOrNull(thumb)?.size ?? 0;
			res.writeHead(200, {
				...BYTES_HEADERS,
				"Content-Type": "image/jpeg",
				"Content-Length": String(size),
				"Cache-Control": "private, max-age=3600",
			});
			createReadStream(thumb, { highWaterMark: CHUNK }).pipe(res);
		}),
	);

	/** An m3u playlist of the whole collection, so `mpv <url>` plays a season in
	 * order. The caller's `?k=` is propagated onto every entry -- a
	 * collection-scoped key covers them all, which is the point of that scope. */
	router.get(
		"/library/:slug/playlist.m3u",
		asyncHandler(async (req, res) => {
			const dir = publishedDir(db, req.params.slug);
			if (!dir) throw new HttpError(404, "not found");

			const entries = playableFiles(db, dir.id).filter(
				(f) =>
					!["client", "sealed"].includes(resolveFileEncryption(db, f).mode),
			);
			if (entries.length === 0) throw new HttpError(404, "nothing to play");

			// Authorize against the first entry: every file here shares one
			// collection, so entitlement is uniform across them.
			const auth = authorizeStream(state, req, entries[0]!, dir);
			if (!auth.ok) throw auth.error;
			if (auth.keyRow) touchPlayKey(db, auth.keyRow);

			const token = typeof req.query.k === "string" ? req.query.k : null;
			const suffix = token ? `?k=${encodeURIComponent(token)}` : "";
			const lines = ["#EXTM3U"];
			for (const f of entries) {
				const blob = f.blob_id
					? db.get<BlobMediaRow>(
							"SELECT media_duration_seconds FROM content_blobs WHERE id = $id",
							{ $id: f.blob_id },
						)
					: undefined;
				const secs = blob?.media_duration_seconds ?? -1;
				lines.push(`#EXTINF:${secs},${f.original_filename}`);
				lines.push(`${baseUrl(req)}/api/media/stream/${f.id}${suffix}`);
			}
			res.writeHead(200, {
				...BYTES_HEADERS,
				"Content-Type": "audio/x-mpegurl; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Disposition": `attachment; filename="${dir.slug}.m3u"`,
			});
			res.end(`${lines.join("\n")}\n`);
		}),
	);

	router.get(
		"/entry/:fileId/thumbnail",
		asyncHandler(async (req, res) => {
			const found = resolvePublishedFile(db, Number(req.params.fileId));
			if (!found) throw new HttpError(404, "not found");
			const { file: f, dir } = found;
			const auth = authorizeStream(state, req, f, dir);
			if (!auth.ok) throw auth.error;
			if (
				resolveFileEncryption(db, f).mode !== "none" ||
				f.compressed ||
				f.archived
			) {
				throw new HttpError(404, "no thumbnail available");
			}
			const fullPath = await localPath(state, f);
			if (!fullPath) throw new HttpError(404, "no thumbnail available");
			const thumb = await getOrCreateThumbnail(f.id, fullPath, f.content_type);
			if (!thumb) throw new HttpError(404, "no thumbnail available");
			const size = statOrNull(thumb)?.size ?? 0;
			res.writeHead(200, {
				...BYTES_HEADERS,
				"Content-Type": "image/jpeg",
				"Content-Length": String(size),
				"Cache-Control": "private, max-age=3600",
			});
			createReadStream(thumb, { highWaterMark: CHUNK }).pipe(res);
		}),
	);

	// ---------------------------------------------------------------- stream

	/** The playback endpoint. `?k=` is the mpv credential; a browser on the
	 * watch page authenticates with its session cookie instead. */
	router.get(
		"/stream/:fileId",
		asyncHandler(async (req, res) => {
			const found = resolvePublishedFile(db, Number(req.params.fileId));
			if (!found) throw new HttpError(404, "not found");
			const { file: f, dir } = found;

			const auth = authorizeStream(state, req, f, dir);
			if (!auth.ok) throw auth.error;
			if (auth.keyRow) touchPlayKey(db, auth.keyRow);

			if (["client", "sealed"].includes(resolveFileEncryption(db, f).mode)) {
				throw new HttpError(
					409,
					"this title is end-to-end encrypted and can only be played in the browser that holds its key",
				);
			}

			const fullPath = await localPath(state, f);
			if (!fullPath) throw new HttpError(500, "file missing from storage");
			touchBlobAccess(db, f.blob_id);
			db.run("UPDATE files SET last_downloaded_at = $now WHERE id = $id", {
				$now: nowIso(),
				$id: f.id,
			});
			recordAudit(db, {
				actor: auth.keyRow
					? `playkey:${auth.keyRow.id}`
					: (optionalViewer(state, req)?.username ?? "anonymous"),
				action: "media.streamed",
				target: `file:${f.id}`,
				ip: clientIp(state, req),
			});

			const headers: Record<string, string> = {
				...BYTES_HEADERS,
				"Content-Type": f.content_type || "application/octet-stream",
				"Cache-Control": "private, no-store",
			};

			// Untransformed on disk: honour Range so the player can seek.
			if (isDirectlyStreamable(db, f)) {
				const fileSize = statOrNull(fullPath)?.size ?? f.stored_size_bytes;
				const rangeHeader = req.headers.range;
				if (rangeHeader) {
					const parsed = parseRange(rangeHeader, fileSize);
					if (!parsed) {
						res
							.status(416)
							.set({
								...BYTES_HEADERS,
								"Accept-Ranges": "bytes",
								"Content-Range": `bytes */${fileSize}`,
							})
							.end();
						return;
					}
					const [start, end] = parsed;
					res.writeHead(206, {
						...headers,
						"Accept-Ranges": "bytes",
						"Content-Range": `bytes ${start}-${end}/${fileSize}`,
						"Content-Length": String(end - start + 1),
					});
					const stream = createReadStream(fullPath, { start, end });
					stream.on("error", () => res.destroy());
					stream.pipe(res);
					return;
				}
				res.writeHead(200, {
					...headers,
					"Accept-Ranges": "bytes",
					"Content-Length": String(fileSize),
				});
				createReadStream(fullPath, { highWaterMark: CHUNK }).pipe(res);
				return;
			}

			// Encrypted / compressed / archived: reproducible only from byte zero,
			// so no Accept-Ranges and a 200 even if the player asked for a range.
			let source: AsyncGenerator<Buffer>;
			try {
				source = plaintextStream(state, f, fullPath);
			} catch (err) {
				if (err instanceof PlaintextUnavailable) {
					throw new HttpError(503, err.message);
				}
				throw err;
			}
			res.writeHead(200, {
				...headers,
				"Content-Length": String(f.size_bytes),
			});
			try {
				for await (const chunk of source) {
					if (!res.write(chunk))
						await new Promise((resolve) => res.once("drain", resolve));
				}
				res.end();
			} catch (err) {
				log.error(
					`media stream failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
				res.destroy();
			}
		}),
	);

	// ------------------------------------------------------------- curation

	/** Publish a folder into the library, or update its presentation. */
	router.put(
		"/library/:directoryId",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const dir = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: Number(req.params.directoryId) },
			);
			if (!dir) throw new HttpError(404, "folder not found");
			if (!canCurate(dir, user)) throw new HttpError(403, "not your folder");

			const body = (req.body ?? {}) as Record<string, unknown>;
			const visibility =
				typeof body.visibility === "string"
					? body.visibility
					: dir.library_visibility;
			if (!VISIBILITIES.has(visibility)) {
				throw new HttpError(400, "visibility must be 'public' or 'restricted'");
			}
			const kind = typeof body.kind === "string" ? body.kind : dir.library_kind;
			if (!KINDS.has(kind)) {
				throw new HttpError(400, "kind must be 'movie' or 'series'");
			}
			const overview =
				body.overview === null
					? null
					: typeof body.overview === "string"
						? body.overview.slice(0, 2000)
						: dir.library_overview;

			let posterFileId = dir.library_poster_file_id;
			if (body.poster_file_id === null) {
				posterFileId = null;
			} else if (typeof body.poster_file_id === "number") {
				const candidate = db.get<FileRow>(
					"SELECT * FROM files WHERE id = $id AND directory_id = $dir",
					{ $id: body.poster_file_id, $dir: dir.id },
				);
				if (!candidate) {
					throw new HttpError(400, "poster must be a file in this folder");
				}
				posterFileId = candidate.id;
			}

			// A folder with nothing playable in it would publish as an empty tile.
			const entries = playableFiles(db, dir.id);
			if (entries.length === 0) {
				throw new HttpError(
					400,
					"folder contains no video or audio files to publish",
				);
			}
			// Runtimes and resolutions are what make the collection view readable,
			// and nothing else in the codebase ever writes them -- so fill them in
			// here, once, for the files being published (storage/mediaProbe.ts).
			await backfillMediaInfo(db, entries);

			db.run(
				`UPDATE directories SET
           is_library = 1,
           library_visibility = $visibility,
           library_kind = $kind,
           library_overview = $overview,
           library_poster_file_id = $poster,
           library_published_at = COALESCE(library_published_at, $now)
         WHERE id = $id`,
				{
					$visibility: visibility,
					$kind: kind,
					$overview: overview,
					$poster: posterFileId,
					$now: nowIso(),
					$id: dir.id,
				},
			);
			recordAudit(db, {
				actor: user.username,
				action: dir.is_library ? "media.updated" : "media.published",
				target: `directory:${dir.id}`,
				ip: clientIp(state, req),
			});
			const updated = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: dir.id },
			)!;
			res.json(serializeCollection(db, updated, user, { withEntries: true }));
		}),
	);

	/** Unpublish. Outstanding play keys for the collection stop working with it
	 * -- resolvePublishedFile only ever resolves files in a library folder. */
	router.delete(
		"/library/:directoryId",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const dir = db.get<DirectoryRow>(
				"SELECT * FROM directories WHERE id = $id",
				{ $id: Number(req.params.directoryId) },
			);
			if (!dir) throw new HttpError(404, "folder not found");
			if (!canCurate(dir, user)) throw new HttpError(403, "not your folder");
			db.run(
				"UPDATE directories SET is_library = 0, library_published_at = NULL WHERE id = $id",
				{ $id: dir.id },
			);
			recordAudit(db, {
				actor: user.username,
				action: "media.unpublished",
				target: `directory:${dir.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "unpublished" });
		},
	);

	// ------------------------------------------------------------ play keys

	/** The caller's live keys. The token itself is never recoverable -- only
	 * what it covers, when it dies, and the id to revoke it by. */
	router.get(
		"/playkeys",
		requireSession(state),
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const rows = listPlayKeys(db, user.id);
			res.json({
				keys: rows.map((k) => ({
					id: k.id,
					label: k.label,
					file_id: k.file_id,
					directory_id: k.directory_id,
					scope: k.file_id ? "file" : "collection",
					bound_ip: k.bound_ip,
					expires_at: k.expires_at,
					created_at: k.created_at,
					last_used_at: k.last_used_at,
				})),
			});
		},
	);

	/** Mints a key. Body: {file_id | directory_id, ttl_seconds?, label?,
	 * bind_ip?}. Returns the play URL to paste into mpv -- shown once. */
	router.post(
		"/playkeys",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const body = (req.body ?? {}) as Record<string, unknown>;
			const fileId =
				typeof body.file_id === "number" ? body.file_id : undefined;
			const directoryId =
				typeof body.directory_id === "number" ? body.directory_id : undefined;
			if ((fileId === undefined) === (directoryId === undefined)) {
				throw new HttpError(
					400,
					"exactly one of file_id or directory_id is required",
				);
			}

			let dir: DirectoryRow;
			let target: FileRow | null = null;
			if (fileId !== undefined) {
				const found = resolvePublishedFile(db, fileId);
				if (!found) throw new HttpError(404, "title not found in the library");
				target = found.file;
				dir = found.dir;
			} else {
				const d = db.get<DirectoryRow>(
					"SELECT * FROM directories WHERE id = $id AND is_library = 1",
					{ $id: directoryId ?? 0 },
				);
				if (!d) throw new HttpError(404, "collection not found");
				dir = d;
			}
			if (!canWatch(state, dir, user)) {
				throw new HttpError(403, "not entitled to this title");
			}
			if (
				target &&
				["client", "sealed"].includes(resolveFileEncryption(db, target).mode)
			) {
				throw new HttpError(
					409,
					"end-to-end encrypted titles cannot be played outside the browser",
				);
			}

			const ttl = clampTtl(
				typeof body.ttl_seconds === "number" ? body.ttl_seconds : undefined,
			);
			const { row, token } = mintPlayKey(state, {
				userId: user.id,
				scope: target
					? { kind: "file", fileId: target.id }
					: { kind: "directory", directoryId: dir.id },
				ttlSeconds: ttl,
				label: typeof body.label === "string" ? body.label.slice(0, 120) : null,
				boundIp: body.bind_ip === true ? clientIp(state, req) : null,
			});

			recordAudit(db, {
				actor: user.username,
				action: "media.playkey_minted",
				target: target ? `file:${target.id}` : `directory:${dir.id}`,
				ip: clientIp(state, req),
			});

			const encoded = encodeURIComponent(token);
			const url = target
				? `${baseUrl(req)}/api/media/stream/${target.id}?k=${encoded}`
				: `${baseUrl(req)}/api/media/library/${dir.slug}/playlist.m3u?k=${encoded}`;
			res.status(201).json({
				id: row.id,
				scope: target ? "file" : "collection",
				file_id: row.file_id,
				directory_id: row.directory_id,
				label: row.label,
				bound_ip: row.bound_ip,
				expires_at: row.expires_at,
				key: token,
				url,
				mpv_command: `mpv "${url}"`,
			});
		},
	);

	router.delete(
		"/playkeys/:id",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			// Masters can revoke anyone's key; everyone else only their own.
			const scopedUser = user.role === "master" ? undefined : user.id;
			if (!revokePlayKey(db, Number(req.params.id), scopedUser)) {
				throw new HttpError(404, "play key not found");
			}
			recordAudit(db, {
				actor: user.username,
				action: "media.playkey_revoked",
				target: `playkey:${req.params.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "revoked" });
		},
	);

	return router;
}

/** Marks every play key belonging to a user as revoked. Called when an account
 * loses `can_watch_media` or is deleted, so outstanding tokens die with the
 * entitlement rather than running to their natural expiry. */
export function revokeUserPlayKeys(db: Db, userId: number): void {
	db.run(
		"UPDATE media_play_keys SET revoked_at = $now WHERE user_id = $userId AND revoked_at IS NULL",
		{ $now: nowIso(), $userId: userId },
	);
}
