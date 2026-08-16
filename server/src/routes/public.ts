import { createReadStream, existsSync, statSync } from "node:fs";
import { type Request, type Response, Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { touchBlobAccess } from "../cluster/cacheEviction.ts";
import { getMasterKey } from "../config.ts";
import { decryptStream } from "../crypto/aead.ts";
import {
	keyScopeOf,
	resolveFileEncryption,
} from "../crypto/effectiveEncryption.ts";
import { sealKdfId } from "../crypto/passwordKey.ts";
import { openBox } from "../crypto/secretbox.ts";
import { type FileRow, nowIso, type UserRow } from "../db/rows.ts";
import { consumeUse, resolveActiveLink } from "../links.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp } from "../middleware/auth.ts";
import { checkLinkAccess } from "../security/accessLock.ts";
import { COOKIE_NAME } from "../security/sessions.ts";
import { escapeHtml, sendSpa } from "../spa.ts";
import { fileHashes } from "../storage/blobs.ts";
import { decompressStream } from "../storage/compress.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";
import {
	decompressFromDecrypted,
	decryptFromDecompressed,
	ensureBlobAvailable,
} from "../storage/streaming.ts";
import { getOrCreateThumbnail } from "../storage/thumbnail.ts";

const log = getLogger("app.public");
const CHUNK = 256 * 1024;

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

function contentDisposition(filename: string): string {
	const cleaned = [...filename]
		.filter((c) => c.codePointAt(0)! >= 0x20)
		.join("");
	const asciiFallback = cleaned
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is deliberate -- non-ASCII must degrade to "?" in the legacy filename param.
		.replace(/[^\x00-\x7F]/g, "?")
		.replace(/"/g, "_")
		.replace(/\\/g, "_");
	const encoded = encodeURIComponent(cleaned);
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
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

function streamRange(
	res: Response,
	path: string,
	start: number,
	end: number,
): void {
	const stream = createReadStream(path, { start, end });
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

/**
 * Whether a `Range` header asks for the *start* of the file.
 *
 * `/raw` charges the link one use per download, and a chunked or resumed
 * download is many requests for one download. The request covering byte zero is
 * the one that pays: every other range is a continuation of a transfer that has
 * already been accounted for, so it consumes no use, writes no audit row and
 * doesn't re-stamp `last_downloaded_at`.
 *
 * This is only ever consulted for a link with no `max_uses` (see
 * `rangesAllowed`), where `use_count` is a download counter rather than a
 * budget -- so the worst a hand-written `Range: bytes=1-` can do is under-count
 * a stat, never spend a use it should have spent.
 */
function isRangeStart(header: string | undefined): boolean {
	if (!header) return true;
	const m = /^bytes=(\d*)-/.exec(header.trim());
	if (!m) return true;
	return m[1] === "" ? false : Number(m[1]) === 0;
}

/**
 * Range is served only for links with an unlimited use budget.
 *
 * A limited-use link enforces its budget per request, and there is no way to
 * tell "the six parallel chunks of one download" from "six downloads" without
 * inventing a download session. Honouring Range there would either spend the
 * budget six ways or -- if continuations were free -- hand out the whole file
 * for `bytes=1-` at no cost, which is the budget gone entirely. So a
 * limited-use link doesn't advertise `Accept-Ranges` and answers the whole body
 * with a 200, which is what the spec says an ignored Range looks like. Same
 * reasoning as `/preview` refusing limited-use links outright.
 */
function rangesAllowed(link: { max_uses: number | null }): boolean {
	return link.max_uses === null;
}

/** Content types /preview knows how to serve inline. */
function previewableType(contentType: string | null): boolean {
	const ct = (contentType || "").toLowerCase();
	return (
		ct.startsWith("image/") ||
		ct.startsWith("video/") ||
		ct.startsWith("audio/") ||
		ct === "application/pdf" ||
		ct.startsWith("text/")
	);
}

/**
 * Whether `GET /file/:slug/preview` would serve this member's bytes.
 *
 * The gallery (see the public folder page) has to know *before* it renders a
 * `<video>` whether that element will get media or a 403, and only the server
 * knows about the storage transforms. Keep in step with the handler below --
 * this is the same decision, answered ahead of time.
 */
export function previewEligible(
	db: AppState["db"],
	f: FileRow,
	link: { max_uses: number | null },
): boolean {
	if (link.max_uses !== null) return false;
	if (!previewableType(f.content_type)) return false;
	if (f.archived) return false;
	const mode = resolveFileEncryption(db, f).mode;
	// `server` is served here too, gated on the same `?ek=` /raw wants; the
	// server holds no key at all for `client`/`sealed`.
	return mode === "none" || mode === "server";
}

function fileMetaTags(req: Request, state: AppState, slug: string): string {
	const link = resolveActiveLink(state.db, slug);
	if (!link) return "";
	const f = state.db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
		$id: link.file_id,
	});
	if (!f) return "";
	const title = escapeHtml(f.original_filename || "Shared file");
	const desc = escapeHtml(`${f.size_bytes} bytes`);
	const url = escapeHtml(
		`${req.protocol}://${req.get("host")}${req.originalUrl}`,
	);
	const tags = [
		`<meta property="og:title" content="${title}">`,
		`<meta property="og:description" content="${desc}">`,
		`<meta property="og:url" content="${url}">`,
		'<meta property="og:type" content="website">',
		`<meta name="twitter:title" content="${title}">`,
		`<meta name="twitter:description" content="${desc}">`,
	];
	const eligible =
		link.max_uses === null &&
		resolveFileEncryption(state.db, f).mode === "none" &&
		!f.compressed &&
		!f.archived;
	const previewUrl = escapeHtml(
		`${req.protocol}://${req.get("host")}/file/${slug}/preview`,
	);
	if (eligible && f.content_type.startsWith("image/")) {
		tags.push(`<meta property="og:image" content="${previewUrl}">`);
		tags.push('<meta name="twitter:card" content="summary_large_image">');
	} else if (eligible && f.content_type.startsWith("video/")) {
		tags.push(`<meta property="og:video" content="${previewUrl}">`);
		tags.push(
			`<meta property="og:video:type" content="${escapeHtml(f.content_type)}">`,
		);
	} else if (eligible && f.content_type.startsWith("audio/")) {
		tags.push(`<meta property="og:audio" content="${previewUrl}">`);
		tags.push(
			`<meta property="og:audio:type" content="${escapeHtml(f.content_type)}">`,
		);
	}
	return tags.join("\n");
}

/** Mirrors app/routes/public.py -- no auth required (link slug is the credential). */
export function publicRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/file/:slug/info", (req, res) => {
		const link = resolveActiveLink(db, req.params.slug);
		if (!link) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
			$id: link.file_id,
		});
		if (!f) {
			res.status(404).json({ detail: "not found" });
			return;
		}

		let uploader: {
			username: string;
			has_avatar: boolean;
			user_id: number;
		} | null = null;
		if (!link.hide_uploader) {
			const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: f.owner_id,
			});
			if (owner) {
				uploader = {
					username: owner.username,
					has_avatar: owner.avatar_data !== null,
					user_id: owner.id,
				};
			}
		}

		let alreadySaved = false;
		const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
		if (cookie) {
			const sessionRow = state.sessionManager.resolve(db, cookie);
			if (sessionRow) {
				const existing = db.get<FileRow>(
					"SELECT * FROM files WHERE owner_id = $uid AND saved_from_file_id = $fid",
					{
						$uid: sessionRow.user_id,
						$fid: f.id,
					},
				);
				alreadySaved = !!existing || f.owner_id === sessionRow.user_id;
			}
		}

		const eff = resolveFileEncryption(db, f);
		res.json({
			filename: f.original_filename,
			size_bytes: f.size_bytes,
			content_type: f.content_type,
			encryption_mode: eff.mode,
			// Tells the download page to ask for a password rather than paste a key.
			password_locked: eff.passwordLocked,
			// Sealed files are decrypted in the browser like client-mode ones. When
			// the key was derived from a password, these say how to rederive it --
			// a salt is not a secret, and the server keeps nothing else (see
			// crypto/passwordKey.ts).
			seal_salt: f.seal_salt
				? Buffer.from(f.seal_salt).toString("base64url")
				: null,
			seal_kdf: f.seal_salt ? sealKdfId() : null,
			compressed: !!f.compressed,
			archived: !!f.archived,
			lifecycle_state: f.lifecycle_state,
			max_uses: link.max_uses,
			use_count: link.use_count,
			expires_at: link.expires_at,
			hashes: fileHashes(db, f),
			uploader,
			already_saved: alreadySaved,
		});
	});

	router.get(
		"/file/:slug/raw",
		asyncHandler(async (req, res) => {
			const link = resolveActiveLink(db, req.params.slug);
			if (!link) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: link.file_id,
			});
			if (!f) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			// Inheriting files carry no key of their own -- the folder chain above
			// them does (crypto/effectiveEncryption.ts).
			const eff = resolveFileEncryption(db, f);
			const ek = typeof req.query.ek === "string" ? req.query.ek : null;
			// Password-locked links are throttled per slug in here; a random-token
			// link is still just a comparison (security/accessLock.ts).
			const access = checkLinkAccess(
				state,
				keyScopeOf(eff, `file:${f.id}`),
				eff,
				ek,
				{ allowMissingSecret: true },
			);
			if (!access.ok) {
				res.status(access.status).json({ detail: access.detail });
				return;
			}
			const needsDecrypt = eff.mode === "server";
			const needsDecompress = !!(f.compressed || f.archived);
			// A transformed blob has to be reproduced from byte zero, so Range is
			// ignored for it below and the answer is the whole body either way --
			// which makes such a request a download, not a continuation.
			const servesRange =
				rangesAllowed(link) && !needsDecrypt && !needsDecompress;
			const rangeHeader = servesRange ? req.headers.range : undefined;
			const continuation = !isRangeStart(rangeHeader);

			// One download, one use: only the request covering byte zero pays.
			if (!continuation) {
				if (!consumeUse(db, req.params.slug)) {
					res.status(404).json({ detail: "not found" });
					return;
				}
				db.run("UPDATE files SET last_downloaded_at = $now WHERE id = $id", {
					$now: nowIso(),
					$id: f.id,
				});
				recordAudit(db, {
					actor: "anonymous",
					action: "file.downloaded",
					target: `file:${f.id}`,
					ip: clientIp(state, req),
				});
			}

			let fullPath: string;
			try {
				fullPath = safeJoin(storageRoot(), f.storage_path);
			} catch {
				res.status(500).json({ detail: "invalid storage path" });
				return;
			}
			if (!existsSync(fullPath)) {
				// Cluster read-time failover: this node's copy is missing (e.g. a
				// cache-mode node that never held it, or local disk loss) -- try
				// pulling it from any active peer before giving up. No-op / cheap
				// when unclustered (fetchBlobFromPeers iterates zero rows).
				await ensureBlobAvailable(state, f, fullPath);
			}
			if (!existsSync(fullPath)) {
				res.status(500).json({ detail: "file missing from storage" });
				return;
			}
			touchBlobAccess(db, f.blob_id);

			const baseHeaders: Record<string, string> = {
				...SECURITY_HEADERS,
				"Content-Disposition": contentDisposition(f.original_filename),
				...(servesRange ? { "Accept-Ranges": "bytes" } : {}),
			};

			if (needsDecrypt) {
				if (!eff.keyBlob) {
					res.status(500).json({ detail: "encryption key not stored" });
					return;
				}
				let perFileKey: Buffer;
				try {
					perFileKey = openBox(
						getMasterKey(state.settings),
						Buffer.from(eff.keyBlob),
					);
				} catch {
					res.status(500).json({ detail: "failed to recover encryption key" });
					return;
				}

				if (needsDecompress) {
					if (f.archived && !f.auto_unarchive_on_download) {
						res
							.status(503)
							.json({ detail: "file is archived; contact admin to unarchive" });
						return;
					}
					res.writeHead(200, {
						...baseHeaders,
						"Content-Type": f.content_type || "application/octet-stream",
					});
					// Compression order mirrors the two possible producers: upload-time
					// compression wraps ENC(ZSTD(x)); the archive job produces ZSTD(ENC(x)).
					const source =
						f.archived && !f.compressed
							? decryptFromDecompressed(fullPath, f.size_bytes, perFileKey)
							: decompressFromDecrypted(fullPath, f.size_bytes, perFileKey);
					try {
						for await (const chunk of source) {
							if (!res.write(chunk))
								await new Promise((resolve) => res.once("drain", resolve));
						}
						res.end();
					} catch (err) {
						log.error(
							`raw download decrypt/decompress failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
						);
						res.destroy();
					}
					return;
				}

				res.writeHead(200, {
					...baseHeaders,
					"Content-Type": f.content_type || "application/octet-stream",
				});
				try {
					for await (const chunk of decryptStream(perFileKey, fullPath)) {
						if (!res.write(chunk))
							await new Promise((resolve) => res.once("drain", resolve));
					}
					res.end();
				} catch (err) {
					log.error(
						`raw download decrypt failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
					);
					res.destroy();
				}
				return;
			}

			if (needsDecompress) {
				if (f.archived && !f.auto_unarchive_on_download) {
					res
						.status(503)
						.json({ detail: "file is archived; contact admin to unarchive" });
					return;
				}
				res.writeHead(200, {
					...baseHeaders,
					"Content-Type": f.content_type,
					"Content-Length": String(f.size_bytes),
				});
				try {
					for await (const chunk of decompressStream(fullPath, f.size_bytes)) {
						if (!res.write(chunk))
							await new Promise((resolve) => res.once("drain", resolve));
					}
					res.end();
				} catch (err) {
					log.error(
						`raw download decompress failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
					);
					res.destroy();
				}
				return;
			}

			const fileSize = f.stored_size_bytes;
			if (rangeHeader) {
				const parsed = parseRange(rangeHeader, fileSize);
				if (!parsed) {
					res
						.status(416)
						.set({
							...SECURITY_HEADERS,
							"Accept-Ranges": "bytes",
							"Content-Range": `bytes */${fileSize}`,
						})
						.end();
					return;
				}
				const [start, end] = parsed;
				res.writeHead(206, {
					...baseHeaders,
					"Content-Type": f.content_type,
					"Content-Range": `bytes ${start}-${end}/${fileSize}`,
					"Content-Length": String(end - start + 1),
				});
				streamRange(res, fullPath, start, end);
				return;
			}

			res.writeHead(200, {
				...baseHeaders,
				"Content-Type": f.content_type,
				"Content-Length": String(fileSize),
			});
			createReadStream(fullPath, { highWaterMark: CHUNK }).pipe(res);
		}),
	);

	router.get(
		"/file/:slug/preview",
		asyncHandler(async (req, res) => {
			const link = resolveActiveLink(db, req.params.slug);
			if (!link) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (link.max_uses !== null) {
				res
					.status(403)
					.json({ detail: "limited-use links do not expose previews" });
				return;
			}
			const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: link.file_id,
			});
			if (!f) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (!previewableType(f.content_type)) {
				res.status(403).json({ detail: "preview unavailable" });
				return;
			}
			// Archived bytes are zstd-wrapped on cold storage and need the
			// unarchive path first; /raw is where that conversation happens.
			if (f.archived) {
				res.status(403).json({ detail: "preview unavailable" });
				return;
			}
			const eff = resolveFileEncryption(db, f);
			if (eff.mode === "client" || eff.mode === "sealed") {
				// The server has no key for these -- only the holder of the fragment
				// can turn them back into pixels, and it does that from /raw.
				res.status(403).json({ detail: "preview unavailable" });
				return;
			}
			if (eff.mode === "server") {
				// Same gate /raw applies, including the per-slug throttle when the
				// secret is a password. Preview consumes no link use, but a
				// limited-use link never reaches here at all (checked above).
				const ek = typeof req.query.ek === "string" ? req.query.ek : null;
				const access = checkLinkAccess(state, req.params.slug, eff, ek, {
					allowMissingSecret: true,
				});
				if (!access.ok) {
					res.status(access.status).json({ detail: access.detail });
					return;
				}
			}
			let fullPath: string;
			try {
				fullPath = safeJoin(storageRoot(), f.storage_path);
			} catch {
				res.status(500).json({ detail: "invalid storage path" });
				return;
			}
			if (!existsSync(fullPath)) {
				await ensureBlobAvailable(state, f, fullPath);
			}
			if (!existsSync(fullPath)) {
				res.status(500).json({ detail: "file missing from storage" });
				return;
			}
			touchBlobAccess(db, f.blob_id);

			// Anything stored transformed has to be reproduced from byte zero, so
			// it goes out 200-only with no Accept-Ranges -- the same rule the media
			// library's `seekable` flag reports (storage/streaming.ts). Archived
			// files were refused above, so the only compressed layering that can
			// reach here is upload-time ENC(ZSTD(x)).
			const needsDecrypt = eff.mode === "server";
			const needsDecompress = !!f.compressed;
			if (needsDecrypt || needsDecompress) {
				let source: AsyncIterable<Uint8Array>;
				if (needsDecrypt) {
					if (!eff.keyBlob) {
						res.status(500).json({ detail: "encryption key not stored" });
						return;
					}
					let perFileKey: Buffer;
					try {
						perFileKey = openBox(
							getMasterKey(state.settings),
							Buffer.from(eff.keyBlob),
						);
					} catch {
						res
							.status(500)
							.json({ detail: "failed to recover encryption key" });
						return;
					}
					source = needsDecompress
						? decompressFromDecrypted(fullPath, f.size_bytes, perFileKey)
						: decryptStream(perFileKey, fullPath);
				} else {
					source = decompressStream(fullPath, f.size_bytes);
				}
				res.writeHead(200, {
					...SECURITY_HEADERS,
					"Content-Type": f.content_type || "application/octet-stream",
				});
				try {
					for await (const chunk of source) {
						if (!res.write(chunk))
							await new Promise((resolve) => res.once("drain", resolve));
					}
					res.end();
				} catch (err) {
					log.error(
						`preview decrypt/decompress failed file_id=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
					);
					res.destroy();
				}
				return;
			}

			const fileSize = statSync(fullPath).size;
			const headers: Record<string, string> = {
				...SECURITY_HEADERS,
				"Accept-Ranges": "bytes",
			};
			const rangeHeader = req.headers.range;
			if (rangeHeader) {
				const parsed = parseRange(rangeHeader, fileSize);
				if (!parsed) {
					res
						.status(416)
						.set({
							...SECURITY_HEADERS,
							"Accept-Ranges": "bytes",
							"Content-Range": `bytes */${fileSize}`,
						})
						.end();
					return;
				}
				const [start, end] = parsed;
				res.writeHead(206, {
					...headers,
					"Content-Type": f.content_type,
					"Content-Range": `bytes ${start}-${end}/${fileSize}`,
					"Content-Length": String(end - start + 1),
				});
				streamRange(res, fullPath, start, end);
				return;
			}
			res.writeHead(200, {
				...headers,
				"Content-Type": f.content_type,
				"Content-Length": String(fileSize),
			});
			createReadStream(fullPath, { highWaterMark: CHUNK }).pipe(res);
		}),
	);

	/** Small, size-capped JPEG for og:image -- unlike /preview this never streams the
	 * raw original, so link-preview crawlers (which cap fetch size, e.g. ~8MB on
	 * Discord) can always render it regardless of how large the source file is. */
	router.get(
		"/file/:slug/thumbnail",
		asyncHandler(async (req, res) => {
			const link = resolveActiveLink(db, req.params.slug);
			if (!link) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			// Mirrors /preview's guard -- a limited-use link's thumbnail must not be
			// viewable without consuming a use.
			if (link.max_uses !== null) {
				res
					.status(403)
					.json({ detail: "limited-use links do not expose thumbnails" });
				return;
			}
			const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
				$id: link.file_id,
			});
			if (!f) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const ct = f.content_type || "";
			if (
				(!ct.startsWith("image/") && !ct.startsWith("video/")) ||
				resolveFileEncryption(db, f).mode !== "none" ||
				f.compressed ||
				f.archived
			) {
				res.status(403).json({ detail: "thumbnail unavailable" });
				return;
			}
			let fullPath: string;
			try {
				fullPath = safeJoin(storageRoot(), f.storage_path);
			} catch {
				res.status(500).json({ detail: "invalid storage path" });
				return;
			}
			if (!existsSync(fullPath)) {
				res.status(500).json({ detail: "file missing from storage" });
				return;
			}
			const thumbPath = await getOrCreateThumbnail(f.id, fullPath, ct);
			if (!thumbPath) {
				res.status(403).json({ detail: "thumbnail unavailable" });
				return;
			}
			const size = statSync(thumbPath).size;
			res.writeHead(200, {
				...SECURITY_HEADERS,
				"Content-Type": "image/jpeg",
				"Content-Length": String(size),
				"Cache-Control": "public, max-age=86400",
			});
			createReadStream(thumbPath, { highWaterMark: CHUNK }).pipe(res);
		}),
	);

	router.get("/file/:slug", (req, res) => {
		res.set(SECURITY_HEADERS);
		sendSpa(res, fileMetaTags(req, state, req.params.slug));
	});

	return router;
}
