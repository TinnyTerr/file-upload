import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import {
	type DirectoryRow,
	nowIso,
	type RemoteUploadJobRow,
} from "../db/rows.ts";
import { getDirectory, isEditor } from "../directoryTree.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireActiveUser, requirePermission } from "../middleware/deps.ts";
import { beginOutbound } from "../outbound.ts";
import { ensurePermissions } from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import { storageRoot } from "../storage/paths.ts";
import { checkUploadHalt, finalizeStoredFile } from "./files.ts";

const log = getLogger("app.routes.remote_upload");
const CHUNK = 256 * 1024;
// The most response head (status line + headers) we will accumulate while
// looking for the blank line that ends it. The body never sits in memory.
const HEADER_ALLOWANCE = 64 * 1024;

/** Mirrors app/routes/remote_upload.py::_is_public_ip. */
function isPublicIp(value: string): boolean {
	if (isIPv4(value)) {
		const parts = value.split(".").map(Number);
		const [a, b] = parts;
		if (a === 10) return false;
		if (a === 172 && b! >= 16 && b! <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 127) return false;
		if (a === 169 && b === 254) return false;
		if (a! >= 224) return false; // multicast/reserved
		if (value === "0.0.0.0") return false;
		return true;
	}
	if (isIPv6(value)) {
		const lower = value.toLowerCase();
		if (lower === "::1" || lower === "::") return false;
		if (
			lower.startsWith("fe80:") ||
			lower.startsWith("fc") ||
			lower.startsWith("fd")
		)
			return false;
		if (lower.startsWith("ff")) return false; // multicast
		if (lower.startsWith("::ffff:")) return isPublicIp(lower.slice(7));
		return true;
	}
	return false;
}

async function resolvePublicAddress(hostname: string): Promise<string> {
	let addresses: { address: string }[];
	try {
		addresses = await dnsLookup(hostname, { all: true });
	} catch {
		throw new HttpError(400, "could not resolve remote host");
	}
	if (!addresses.length)
		throw new HttpError(400, "could not resolve remote host");
	for (const { address } of addresses) {
		if (!isPublicIp(address))
			throw new HttpError(
				400,
				"remote host resolves to a private or local address",
			);
	}
	return addresses[0]!.address;
}

function validatePublicHttpUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new HttpError(400, "only public http/https URLs are allowed");
	}
	if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
		throw new HttpError(400, "only public http/https URLs are allowed");
	}
	return parsed;
}

function filenameFromUrl(parsed: URL, fallback: string): string {
	const name =
		decodeURIComponent(parsed.pathname.split("/").pop() ?? "") || fallback;
	return name.slice(0, 1024) || fallback;
}

/**
 * Incremental HTTP/1.1 chunked-transfer decoder: size-line (hex, optionally
 * with extensions after a `;`) -> data -> CRLF, repeated until the 0-length
 * chunk, then trailers up to the empty line. Fed the raw socket bytes as they
 * arrive and hands back payload pieces, so the body streams to disk instead
 * of being assembled in memory first. Writing the raw framing straight to
 * disk (the original behaviour) corrupted every chunked response; buffering
 * the whole body to decode it (the next one) held up to `max_file_bytes` --
 * 10 GiB by default -- in RAM per job.
 */
export class ChunkedDecoder {
	private buf: Buffer = Buffer.alloc(0);
	private remaining = 0;
	private state: "size" | "data" | "crlf" | "trailer" | "done" = "size";

	get done(): boolean {
		return this.state === "done";
	}

	push(chunk: Buffer): Buffer[] {
		const out: Buffer[] = [];
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		let off = 0;
		for (;;) {
			if (this.state === "size") {
				const lineEnd = this.buf.indexOf("\r\n", off);
				if (lineEnd === -1) {
					if (this.buf.length - off > 1024) throw malformedChunked();
					break;
				}
				const sizeLine = this.buf
					.subarray(off, lineEnd)
					.toString("latin1")
					.split(";")[0]!
					.trim();
				if (!/^[0-9a-fA-F]{1,16}$/.test(sizeLine)) throw malformedChunked();
				const size = Number.parseInt(sizeLine, 16);
				off = lineEnd + 2;
				if (size === 0) {
					this.state = "trailer";
					continue;
				}
				this.remaining = size;
				this.state = "data";
			} else if (this.state === "data") {
				const available = this.buf.length - off;
				if (available === 0) break;
				const take = Math.min(available, this.remaining);
				out.push(this.buf.subarray(off, off + take));
				off += take;
				this.remaining -= take;
				if (this.remaining === 0) this.state = "crlf";
			} else if (this.state === "crlf") {
				if (this.buf.length - off < 2) break;
				if (this.buf[off] !== 0x0d || this.buf[off + 1] !== 0x0a) {
					throw malformedChunked();
				}
				off += 2;
				this.state = "size";
			} else if (this.state === "trailer") {
				const lineEnd = this.buf.indexOf("\r\n", off);
				if (lineEnd === -1) break;
				const empty = lineEnd === off;
				off = lineEnd + 2;
				if (empty) this.state = "done";
			} else {
				// Anything after the terminator is not ours to interpret.
				off = this.buf.length;
				break;
			}
		}
		this.buf = this.buf.subarray(off);
		return out;
	}
}

function malformedChunked(): HttpError {
	return new HttpError(400, "malformed chunked response from remote host");
}

interface DownloadResult {
	filename: string;
	contentType: string;
	sizeBytes: number;
}

/** Resolves + validates the host, connects to the exact validated IP (closing
 * the DNS-rebinding TOCTOU window), then streams the response body to
 * `destination` -- decoded, under backpressure, never held in memory -- with a
 * hard byte cap. Follows up to 6 redirects, re-validating
 * each hop. Mirrors app/routes/remote_upload.py::download_remote_url +
 * _open_pinned. */
async function downloadRemoteUrl(
	url: string,
	destination: string,
	maxBytes: number,
): Promise<DownloadResult> {
	let current = url;
	for (let redirect = 0; redirect < 6; redirect++) {
		const parsed = validatePublicHttpUrl(current);
		const host = parsed.hostname;
		const port = Number(
			parsed.port || (parsed.protocol === "https:" ? 443 : 80),
		);
		const ip = await resolvePublicAddress(host);

		const target = parsed.pathname + parsed.search;
		const call = beginOutbound("remote-upload", "GET", current);
		const result = await new Promise<
			| { status: number; headers: Record<string, string>; sizeBytes: number }
			| { redirect: string; status: number }
		>((resolve, reject) => {
			const requestLine = `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: fileupload-remote-fetch/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
			const onSocket = (
				socket: import("node:net").Socket | import("node:tls").TLSSocket,
			) => {
				// Phase 1 accumulates only the response head; phase 2 streams the
				// body straight to disk, decoded, under a running byte cap.
				let head: Buffer = Buffer.alloc(0);
				let headerDone = false;
				let status = 0;
				let headers: Record<string, string> = {};
				let decoder: ChunkedDecoder | null = null;
				let out: import("node:fs").WriteStream | null = null;
				let written = 0;
				let settled = false;

				const fail = (err: Error) => {
					if (settled) return;
					settled = true;
					socket.destroy();
					if (out) {
						out.destroy();
						try {
							unlinkSync(destination);
						} catch {
							// nothing was written yet
						}
					}
					reject(err);
				};
				const succeed = (value: Parameters<typeof resolve>[0]) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};

				// An idle timer, not a duration cap: a legitimate multi-GB pull
				// runs for a long time, so what gets policed is a stall.
				socket.setTimeout(15000, () => {
					fail(new HttpError(400, "remote download timed out"));
				});
				socket.write(requestLine);

				const writeBody = (pieces: Buffer[]) => {
					for (const piece of pieces) {
						if (!piece.length) continue;
						written += piece.length;
						if (written > maxBytes) {
							fail(new HttpError(413, "remote file exceeds max file size"));
							return;
						}
						if (!out!.write(piece)) {
							socket.pause();
							out!.once("drain", () => socket.resume());
						}
					}
				};

				socket.on("data", (d: Buffer) => {
					if (settled) return;
					if (!headerDone) {
						head = head.length ? Buffer.concat([head, d]) : d;
						const headerEnd = head.indexOf("\r\n\r\n");
						if (headerEnd === -1) {
							if (head.length > HEADER_ALLOWANCE) {
								fail(
									new HttpError(
										400,
										"remote download failed: malformed response",
									),
								);
							}
							return;
						}
						headerDone = true;
						const headerText = head.subarray(0, headerEnd).toString("latin1");
						const [statusLine, ...headerLines] = headerText.split("\r\n");
						status = Number(statusLine!.split(" ")[1]);
						headers = {};
						for (const line of headerLines) {
							const idx = line.indexOf(":");
							if (idx === -1) continue;
							headers[line.slice(0, idx).trim().toLowerCase()] = line
								.slice(idx + 1)
								.trim();
						}
						if ([301, 302, 303, 307, 308].includes(status)) {
							const location = headers.location;
							if (!location) {
								fail(new HttpError(400, "remote redirect missing location"));
								return;
							}
							socket.destroy();
							succeed({
								redirect: new URL(location, current).toString(),
								status,
							});
							return;
						}
						if (status >= 400) {
							// The caller turns this into an error; the body is noise.
							socket.destroy();
							succeed({ status, headers, sizeBytes: 0 });
							return;
						}
						if (
							(headers["transfer-encoding"] ?? "")
								.toLowerCase()
								.includes("chunked")
						) {
							decoder = new ChunkedDecoder();
						}
						mkdirSync(join(destination, ".."), { recursive: true });
						out = createWriteStream(destination);
						out.on("error", (err: Error) =>
							fail(
								new HttpError(400, `remote download failed: ${err.message}`),
							),
						);
						d = head.subarray(headerEnd + 4);
						head = Buffer.alloc(0);
						if (!d.length) return;
					}
					try {
						writeBody(decoder ? decoder.push(d) : [d]);
					} catch (err) {
						fail(
							err instanceof HttpError
								? err
								: new HttpError(
										400,
										`remote download failed: ${err instanceof Error ? err.message : String(err)}`,
									),
						);
					}
				});
				socket.on("error", (err: Error) =>
					fail(new HttpError(400, `remote download failed: ${err.message}`)),
				);
				socket.on("end", () => {
					if (settled) return;
					if (!headerDone || !out) {
						fail(
							new HttpError(400, "remote download failed: malformed response"),
						);
						return;
					}
					if (decoder && !decoder.done) {
						fail(malformedChunked());
						return;
					}
					const finished = out;
					out = null;
					finished.end(() => succeed({ status, headers, sizeBytes: written }));
				});
			};
		}).then(
			(resolved) => {
				call.ok(resolved.status);
				return resolved;
			},
			(err: unknown) => {
				call.fail(err);
				throw err;
			},
		);

		if ("redirect" in result) {
			current = result.redirect;
			continue;
		}
		if (result.status >= 400) {
			throw new HttpError(
				400,
				`remote download failed with HTTP ${result.status}`,
			);
		}
		const ctype = result.headers["content-type"];
		const contentType =
			(ctype ? ctype.split(";")[0]!.trim() : "") || "application/octet-stream";
		return {
			filename: filenameFromUrl(parsed, "remote-upload"),
			contentType,
			sizeBytes: result.sizeBytes,
		};
	}
	throw new HttpError(400, "too many remote redirects");
}

/** Mirrors app/routes/remote_upload.py. Delegates to files.ts's finalize
 * pipeline for the shared quota/compress/encrypt/link-mint logic. */
export function remoteUploadRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.post(
		"/remote-upload",
		requireSession(state),
		requireCsrf,
		requirePermission(state, "can_upload"),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			checkUploadHalt(state, user.id);
			const body = req.body ?? {};
			const url = String(body.url ?? "");

			// Optional destination folder. `finalizeStoredFile` derives the
			// encryption mode from it, so a URL pulled into an encrypted folder is
			// encrypted on arrival exactly like a browser upload into that folder.
			let directory: DirectoryRow | null = null;
			const rawDir = body.directory_id;
			if (rawDir !== undefined && rawDir !== null && rawDir !== "") {
				const dirId = Number(rawDir);
				if (!Number.isInteger(dirId)) {
					throw new HttpError(400, "invalid directory_id");
				}
				directory = getDirectory(db, dirId);
				if (!directory) throw new HttpError(404, "directory not found");
				if (!isEditor(db, directory, user)) {
					throw new HttpError(403, "not your directory");
				}
			}

			const perm = ensurePermissions(db, user.id, {
				master: user.role === "master",
			});
			const rand = randomBytes(32).toString("hex");
			const relPath = `${rand.slice(0, 2)}/${rand.slice(2, 4)}/${rand.slice(4)}`;
			const work = `${join(storageRoot(), relPath)}.remote.work`;

			db.run(
				"INSERT INTO remote_upload_jobs (owner_id, url, status, created_at) VALUES ($ownerId, $url, 'running', $now)",
				{
					$ownerId: user.id,
					$url: url,
					$now: nowIso(),
				},
			);
			const job = db.get<RemoteUploadJobRow>(
				"SELECT * FROM remote_upload_jobs WHERE id = last_insert_rowid()",
			)!;

			try {
				// Validated here (inside the try) rather than before job creation so a
				// thrown HttpError is caught by the same handler that marks the job
				// failed, instead of becoming an unhandled rejection (asyncHandler
				// covers that too, belt-and-suspenders).
				validatePublicHttpUrl(url);
				const meta = await downloadRemoteUrl(url, work, perm.max_file_bytes);
				const usedBytes =
					db.get<{ total: number | null }>(
						"SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id",
						{ $id: user.id },
					)?.total ?? 0;
				if (usedBytes + meta.sizeBytes > perm.quota_bytes) {
					throw new HttpError(413, "remote upload would exceed your quota");
				}

				const result = await finalizeStoredFile({
					state,
					req,
					user,
					perm,
					directory,
					workPath: work,
					relPath,
					stored: meta.sizeBytes,
					contentType: meta.contentType,
					encryptionMode: "none",
					compress: false,
					randomizeFilename: false,
					originalFilename:
						body.original_filename || meta.filename || "remote-upload",
					isPermanent: true,
					tempDays: null,
					deleteIfIdleDays: null,
					archiveAfterIdleDays: null,
					autoUnarchiveOnDownload: true,
					maxUses: null,
					expiresInSeconds: null,
					sourceType: "remote",
				});

				db.run(
					"UPDATE remote_upload_jobs SET status = 'completed', file_id = $fileId, completed_at = $now WHERE id = $id",
					{
						$fileId: Number(result.file_id),
						$now: nowIso(),
						$id: job.id,
					},
				);
				recordAudit(db, {
					actor: user.username,
					action: "remote_upload.completed",
					target: `remote_job:${job.id}`,
					ip: clientIp(state, req),
				});
				log.info(
					`remote upload completed job_id=${job.id} file_id=${result.file_id} owner_id=${user.id}`,
				);
				res.json({
					job_id: job.id,
					status: "completed",
					file_id: result.file_id,
					...result,
				});
			} catch (err) {
				try {
					unlinkSync(work);
				} catch {
					// best-effort
				}
				const detail =
					err instanceof HttpError
						? err.detail
						: err instanceof Error
							? err.message
							: String(err);
				db.run(
					"UPDATE remote_upload_jobs SET status = 'failed', error = $err, completed_at = $now WHERE id = $id",
					{
						$err: detail,
						$now: nowIso(),
						$id: job.id,
					},
				);
				log.warning(
					`remote upload failed job_id=${job.id} owner_id=${user.id} error=${detail}`,
				);
				if (err instanceof HttpError) {
					res.status(err.status).json({ detail: err.detail });
				} else {
					log.error(
						`unhandled remote upload error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
					);
					res.status(500).json({ detail: "internal server error" });
				}
			}
		}),
	);

	router.get("/remote-upload/:jobId", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const job = db.get<RemoteUploadJobRow>(
			"SELECT * FROM remote_upload_jobs WHERE id = $id",
			{ $id: req.params.jobId },
		);
		if (!job) {
			res.status(404).json({ detail: "not found" });
			return;
		}
		if (user.role !== "master" && job.owner_id !== user.id) {
			res.status(403).json({ detail: "not your remote upload" });
			return;
		}
		res.json({
			job_id: job.id,
			status: job.status,
			file_id: job.file_id,
			error: job.error,
			created_at: job.created_at,
			completed_at: job.completed_at,
		});
	});

	return router;
}
