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
import { nowIso, type RemoteUploadJobRow } from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireActiveUser, requirePermission } from "../middleware/deps.ts";
import { ensurePermissions } from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import { storageRoot } from "../storage/paths.ts";
import { checkUploadHalt, finalizeStoredFile } from "./files.ts";

const log = getLogger("app.routes.remote_upload");
const CHUNK = 256 * 1024;
// Slack above the declared max file size to cover response headers riding
// along in the same accumulated buffer -- the byte cap below is enforced on
// the raw socket stream (headers + body), not the parsed body alone.
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

/** Decodes an HTTP/1.1 chunked-transfer body: size-line (hex, optionally with
 * chunk extensions after a `;`) -> data -> trailing CRLF, repeated until the
 * terminating 0-length chunk. Trailer headers (if any) are discarded -- we
 * don't need them. Writing the raw chunked framing straight to disk (the
 * previous behavior) corrupted every response served with
 * Transfer-Encoding: chunked. */
function decodeChunkedBody(raw: Buffer): Buffer {
	const parts: Buffer[] = [];
	let offset = 0;
	for (;;) {
		const lineEnd = raw.indexOf("\r\n", offset);
		if (lineEnd === -1)
			throw new HttpError(400, "malformed chunked response from remote host");
		const sizeLine = raw
			.subarray(offset, lineEnd)
			.toString("latin1")
			.split(";")[0]!
			.trim();
		const size = Number.parseInt(sizeLine, 16);
		if (!Number.isFinite(size) || size < 0) {
			throw new HttpError(400, "malformed chunked response from remote host");
		}
		offset = lineEnd + 2;
		if (size === 0) break;
		if (offset + size > raw.length) {
			throw new HttpError(400, "malformed chunked response from remote host");
		}
		parts.push(raw.subarray(offset, offset + size));
		offset += size;
		if (raw.subarray(offset, offset + 2).toString("latin1") !== "\r\n") {
			throw new HttpError(400, "malformed chunked response from remote host");
		}
		offset += 2;
	}
	return Buffer.concat(parts);
}

interface DownloadResult {
	filename: string;
	contentType: string;
	sizeBytes: number;
}

/** Resolves + validates the host, connects to the exact validated IP (closing
 * the DNS-rebinding TOCTOU window), then streams the response body to
 * `destination` with a hard byte cap. Follows up to 6 redirects, re-validating
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
		const result = await new Promise<
			| { status: number; headers: Record<string, string>; body: Buffer }
			| { redirect: string }
		>((resolve, reject) => {
			const requestLine = `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: fileupload-remote-fetch/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
			const onSocket = (
				socket: import("node:net").Socket | import("node:tls").TLSSocket,
			) => {
				socket.setTimeout(15000, () => {
					socket.destroy();
					reject(new HttpError(400, "remote download timed out"));
				});
				socket.write(requestLine);
				const chunks: Buffer[] = [];
				// Running total instead of only checking after Buffer.concat --
				// otherwise a malicious/misbehaving host can make us buffer
				// unbounded bytes before the length check ever runs.
				let total = 0;
				socket.on("data", (d: Buffer) => {
					total += d.length;
					if (total > maxBytes + HEADER_ALLOWANCE) {
						socket.destroy();
						reject(new HttpError(413, "remote file exceeds max file size"));
						return;
					}
					chunks.push(d);
				});
				socket.on("error", (err: Error) =>
					reject(new HttpError(400, `remote download failed: ${err.message}`)),
				);
				socket.on("end", () => {
					try {
						const raw = Buffer.concat(chunks);
						const headerEnd = raw.indexOf("\r\n\r\n");
						if (headerEnd === -1) {
							reject(
								new HttpError(
									400,
									"remote download failed: malformed response",
								),
							);
							return;
						}
						const headerText = raw.subarray(0, headerEnd).toString("latin1");
						// Explicit bare-Buffer annotation: decodeChunkedBody returns
						// Buffer<ArrayBufferLike>, which Buffer<ArrayBuffer> (the type
						// Buffer.concat/subarray infer) doesn't structurally accept.
						let bodyStart: Buffer = raw.subarray(headerEnd + 4);
						const [statusLine, ...headerLines] = headerText.split("\r\n");
						const status = Number(statusLine!.split(" ")[1]);
						const headers: Record<string, string> = {};
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
								reject(new HttpError(400, "remote redirect missing location"));
								return;
							}
							resolve({ redirect: new URL(location, current).toString() });
							return;
						}
						// The raw framing (hex size lines + CRLF delimiters) is not the
						// file's actual bytes -- decode it before it ever touches disk.
						if (
							(headers["transfer-encoding"] ?? "")
								.toLowerCase()
								.includes("chunked")
						) {
							bodyStart = decodeChunkedBody(bodyStart);
						}
						resolve({ status, headers, body: bodyStart });
					} catch (err) {
						reject(
							new HttpError(
								400,
								`remote download failed: ${err instanceof Error ? err.message : String(err)}`,
							),
						);
					}
				});
			};
			if (parsed.protocol === "https:") {
				const socket = tlsConnect({ host: ip, port, servername: host });
				socket.on("secureConnect", () => onSocket(socket));
				socket.on("error", (err: Error) =>
					reject(new HttpError(400, `remote download failed: ${err.message}`)),
				);
			} else {
				const socket = createConnection({ host: ip, port });
				socket.on("connect", () => onSocket(socket));
				socket.on("error", (err: Error) =>
					reject(new HttpError(400, `remote download failed: ${err.message}`)),
				);
			}
		});

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
		if (result.body.length > maxBytes) {
			throw new HttpError(413, "remote file exceeds max file size");
		}
		mkdirSync(join(destination, ".."), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			const out = createWriteStream(destination);
			out.on("error", reject);
			out.end(result.body, () => resolve());
		});
		const ctype = result.headers["content-type"];
		const contentType =
			(ctype ? ctype.split(";")[0]!.trim() : "") || "application/octet-stream";
		return {
			filename: filenameFromUrl(parsed, "remote-upload"),
			contentType,
			sizeBytes: result.body.length,
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
					directory: null,
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
