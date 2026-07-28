import { randomBytes } from "node:crypto";
import { type Response, Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { setEnvValue } from "../config.ts";
import { nowIso, type TorrentJobRow, type UserRow } from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import {
	requireActiveUser,
	requireMaster,
	requirePermission,
} from "../middleware/deps.ts";
import { requireCsrf } from "../security/csrf.ts";
import {
	dispatchTorrent,
	errText,
	releaseDebridJob,
	type TorrentSource,
} from "../torrents/debrid.ts";
import { cleanupJobDir } from "../torrents/importer.ts";
import { IN_FLIGHT_STATUSES, retryJob } from "../torrents/poller.ts";
import {
	appVersion,
	deleteTorrent,
	infoHashFromMagnet,
	isConfigured,
} from "../torrents/qbittorrent.ts";
import * as rd from "../torrents/realdebrid.ts";

const log = getLogger("app.routes.torrents");

/** Max accepted .torrent metainfo file (base64-decoded). */
const MAX_TORRENT_FILE_BYTES = 2 * 1024 * 1024;
/** Concurrent in-flight torrents per user -- keeps one account from occupying
 * the whole host qBittorrent instance or the shared Real-Debrid slot budget. */
const MAX_ACTIVE_PER_USER = 5;

const IN_FLIGHT_SQL = IN_FLIGHT_STATUSES.map((s) => `'${s}'`).join(", ");

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

function nameFromMagnet(magnet: string): string | null {
	try {
		const dn = new URLSearchParams(magnet.slice(magnet.indexOf("?") + 1)).get(
			"dn",
		);
		return dn ? dn.slice(0, 512) : null;
	} catch {
		return null;
	}
}

/** Any torrent backend at all -- Real-Debrid, qBittorrent, or both. */
function torrentingAvailable(state: AppState): boolean {
	return rd.isConfigured(state.settings) || isConfigured(state.settings);
}

/** Last four characters only: enough for an admin to tell which token is
 * installed, useless to anyone who shouldn't have it. */
function maskKey(key: string): string | null {
	if (!key) return null;
	return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

function serializeJob(
	job: TorrentJobRow,
	ownerUsername?: string,
): Record<string, unknown> {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		provider: job.provider,
		debrid_status: job.debrid_status,
		fallback_reason: job.fallback_reason,
		progress: job.progress,
		size_bytes: job.size_bytes,
		downloaded_bytes: job.downloaded_bytes,
		dl_speed: job.dl_speed,
		eta_seconds: job.eta_seconds,
		info_hash: job.info_hash,
		directory_id: job.directory_id,
		imported_file_count: job.imported_file_count,
		error: job.error,
		created_at: job.created_at,
		updated_at: job.updated_at,
		completed_at: job.completed_at,
		...(ownerUsername !== undefined
			? { owner_username: ownerUsername, owner_id: job.owner_id }
			: {}),
	};
}

function loadOwnJob(
	state: AppState,
	user: UserRow,
	jobId: string,
): TorrentJobRow {
	const job = state.db.get<TorrentJobRow>(
		"SELECT * FROM torrent_jobs WHERE id = $id",
		{ $id: jobId },
	);
	if (!job) throw new HttpError(404, "not found");
	if (user.role !== "master" && job.owner_id !== user.id)
		throw new HttpError(403, "not your torrent");
	return job;
}

/** Torrent downloads, preferring Real-Debrid and falling back to a qBittorrent
 * instance on the host.
 *
 * With a Real-Debrid token installed, every torrent is handed to Real-Debrid --
 * cached or not, since Real-Debrid downloads what it doesn't already have --
 * and this server then pulls the finished files over HTTPS (torrents/debrid.ts).
 * qBittorrent takes over only when there is no token, the token is rejected, or
 * a job dies on Real-Debrid's side. Either way the scheduler's `torrent_poll`
 * job imports the result into the owner's storage through the normal upload
 * finalize pipeline (torrents/poller.ts + importer.ts). Mount at /api/torrents. */
export function torrentsRouter(state: AppState): Router {
	const router = Router();
	const { db, settings } = state;
	const perm = () => requirePermission(state, "can_use_torrents");

	router.get("/config", requireActiveUser(state), (_req, res) => {
		res.json({
			configured: torrentingAvailable(state),
			debrid_enabled: rd.isConfigured(settings),
			qbittorrent_configured: isConfigured(settings),
			save_path: settings.qbittorrentSavePath,
			max_active_per_user: MAX_ACTIVE_PER_USER,
		});
	});

	// Only magnets and uploaded .torrent files are accepted. Handing qBittorrent
	// an arbitrary http(s) URL to fetch would make it an SSRF proxy into the
	// host's network, which the remote-upload route guards against by pinning
	// validated public IPs (see routes/remoteUpload.ts) -- and the same URL
	// through Real-Debrid is just remote-upload with extra steps.
	router.post(
		"/",
		requireSession(state),
		requireCsrf,
		perm(),
		asyncHandler(async (req, res) => {
			try {
				if (!torrentingAvailable(state)) {
					throw new HttpError(
						503,
						"torrenting is not configured on this server",
					);
				}
				const user = req.currentUser!;
				const body = req.body ?? {};
				const magnet =
					typeof body.magnet === "string" ? body.magnet.trim() : "";
				const fileB64 =
					typeof body.torrent_file_b64 === "string"
						? body.torrent_file_b64
						: "";

				if (!magnet && !fileB64) {
					res
						.status(400)
						.json({ detail: "provide a magnet link or a .torrent file" });
					return;
				}
				if (magnet && !/^magnet:\?/i.test(magnet)) {
					res
						.status(400)
						.json({
							detail:
								"only magnet links are accepted here; upload the .torrent file instead",
						});
					return;
				}

				let torrentFile: { filename: string; bytes: Buffer } | undefined;
				if (!magnet) {
					const bytes = Buffer.from(
						fileB64.replace(/^data:[^,]*,/, ""),
						"base64",
					);
					if (!bytes.length) {
						res
							.status(400)
							.json({ detail: "torrent file is empty or not valid base64" });
						return;
					}
					if (bytes.length > MAX_TORRENT_FILE_BYTES) {
						res.status(413).json({ detail: "torrent file is too large" });
						return;
					}
					if (bytes[0] !== 0x64) {
						res
							.status(400)
							.json({ detail: "that file is not a .torrent metainfo file" });
						return;
					}
					const rawName =
						typeof body.filename === "string"
							? body.filename
							: "upload.torrent";
					torrentFile = {
						filename:
							rawName.replace(/[/\\]/g, "_").slice(0, 255) || "upload.torrent",
						bytes,
					};
				}

				const active = db.get<{ n: number }>(
					`SELECT COUNT(*) as n FROM torrent_jobs WHERE owner_id = $id AND status IN (${IN_FLIGHT_SQL})`,
					{ $id: user.id },
				)!.n;
				if (active >= MAX_ACTIVE_PER_USER) {
					res
						.status(429)
						.json({
							detail: `you already have ${MAX_ACTIVE_PER_USER} torrents in flight`,
						});
					return;
				}

				const tag = `fu-${randomBytes(8).toString("hex")}`;
				const source: TorrentSource = {
					magnet: magnet || undefined,
					file: torrentFile,
				};
				const name =
					(typeof body.name === "string" && body.name.trim().slice(0, 512)) ||
					(magnet
						? nameFromMagnet(magnet)
						: torrentFile!.filename.replace(/\.torrent$/i, "")) ||
					"torrent";

				const dispatch = await dispatchTorrent(state, source, tag);

				db.run(
					`INSERT INTO torrent_jobs (owner_id, name, source, info_hash, tag, save_path, provider, debrid_id,
           fallback_reason, status, created_at, updated_at)
         VALUES ($ownerId, $name, $source, $hash, $tag, $savePath, $provider, $debridId, $fallbackReason,
           'queued', $now, $now)`,
					{
						$ownerId: user.id,
						$name: name,
						$source: magnet
							? magnet.slice(0, 2048)
							: `file:${torrentFile!.filename}`,
						$hash: magnet ? infoHashFromMagnet(magnet) : null,
						$tag: tag,
						$savePath: dispatch.savePath,
						$provider: dispatch.provider,
						$debridId: dispatch.debridId,
						$fallbackReason: dispatch.fallbackReason,
						$now: nowIso(),
					},
				);
				const job = db.get<TorrentJobRow>(
					"SELECT * FROM torrent_jobs WHERE id = last_insert_rowid()",
				)!;
				recordAudit(db, {
					actor: user.username,
					action: "torrent.added",
					target: `torrent_job:${job.id}`,
					ip: clientIp(state, req),
				});
				log.info(
					`torrent added job_id=${job.id} owner_id=${user.id} tag=${tag} provider=${dispatch.provider}` +
						(dispatch.fallbackReason
							? ` fallback=${dispatch.fallbackReason}`
							: ""),
				);
				res.json(serializeJob(job));
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	router.get("/", perm(), (req, res) => {
		const user = req.currentUser!;
		const jobs = db.all<TorrentJobRow>(
			"SELECT * FROM torrent_jobs WHERE owner_id = $id ORDER BY id DESC LIMIT 200",
			{
				$id: user.id,
			},
		);
		res.json({
			torrents: jobs.map((j) => serializeJob(j)),
			configured: torrentingAvailable(state),
		});
	});

	router.get("/:jobId(\\d+)", perm(), (req, res) => {
		try {
			const job = loadOwnJob(state, req.currentUser!, req.params.jobId!);
			res.json(serializeJob(job));
		} catch (err) {
			respondError(res, err);
		}
	});

	// Re-runs a failed job: a debrid job whose transfer completed (typically a
	// quota failure the owner has since made room for) re-imports off disk, one
	// that never finished transferring is pulled from Real-Debrid again, and a
	// qBittorrent job re-imports its still-present download.
	router.post(
		"/:jobId(\\d+)/retry",
		requireSession(state),
		requireCsrf,
		perm(),
		asyncHandler(async (req, res) => {
			try {
				const user = req.currentUser!;
				const job = loadOwnJob(state, user, req.params.jobId!);
				if (job.status !== "failed") {
					res
						.status(409)
						.json({ detail: "only failed torrents can be retried" });
					return;
				}
				await retryJob(state, job);
				recordAudit(db, {
					actor: user.username,
					action: "torrent.retried",
					target: `torrent_job:${job.id}`,
					ip: clientIp(state, req),
				});
				res.json(
					serializeJob(
						db.get<TorrentJobRow>("SELECT * FROM torrent_jobs WHERE id = $id", {
							$id: job.id,
						})!,
					),
				);
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	// Cancels an in-flight torrent (removing it and its data from whichever
	// backend holds it) or clears a settled row. Already-imported files are
	// untouched -- they are ordinary files at that point and are deleted from the
	// files page.
	router.delete(
		"/:jobId(\\d+)",
		requireSession(state),
		requireCsrf,
		perm(),
		asyncHandler(async (req, res) => {
			try {
				const user = req.currentUser!;
				const job = loadOwnJob(state, user, req.params.jobId!);
				if (job.provider === "debrid") {
					await releaseDebridJob(state, job);
				} else {
					if (
						isConfigured(settings) &&
						job.info_hash &&
						job.status !== "completed"
					) {
						await deleteTorrent(settings, job.info_hash, true);
					}
					if (job.status !== "completed") cleanupJobDir(state, job);
				}
				db.run("DELETE FROM torrent_jobs WHERE id = $id", { $id: job.id });
				recordAudit(db, {
					actor: user.username,
					action: "torrent.removed",
					target: `torrent_job:${job.id}`,
					ip: clientIp(state, req),
				});
				log.info(
					`torrent removed job_id=${job.id} owner_id=${user.id} status=${job.status}`,
				);
				res.json({ status: "deleted" });
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	return router;
}

/** Real-Debrid account probe for the admin status card. Never throws. */
async function debridStatus(state: AppState): Promise<Record<string, unknown>> {
	const { settings } = state;
	const base = {
		configured: rd.hasApiKey(settings),
		enabled: settings.realDebridEnabled,
		/** Whether debrid is actually the active backend right now. */
		active: rd.isConfigured(settings),
		api_key_hint: maskKey(settings.realDebridApiKey),
	};
	if (!rd.hasApiKey(settings)) {
		return {
			...base,
			detail: "no API token set — every torrent goes to qBittorrent",
		};
	}
	try {
		const account = await rd.user(settings.realDebridApiKey);
		return {
			...base,
			connected: true,
			username: account.username,
			account_type: account.type,
			premium_seconds: account.premium,
			expiration: account.expiration ?? null,
			points: account.points ?? null,
			// A free account cannot add torrents at all -- worth flagging loudly,
			// because every job silently falls back to qBittorrent.
			warning:
				account.type !== "premium"
					? "this account is not premium; Real-Debrid will reject torrents"
					: null,
		};
	} catch (err) {
		return {
			...base,
			connected: false,
			invalid_key: err instanceof rd.RealDebridError && err.authFailed,
			detail: errText(err),
		};
	}
}

/** Mount at /api/admin/torrents. */
export function adminTorrentsRouter(state: AppState): Router {
	const router = Router();
	const { db, settings } = state;

	router.get(
		"/status",
		requireMaster(state),
		asyncHandler(async (_req, res) => {
			const debrid = await debridStatus(state);
			if (!isConfigured(settings)) {
				res.json({
					configured: false,
					detail:
						"set QBITTORRENT_URL and QBITTORRENT_SAVE_PATH in data/app.env",
					save_path: settings.qbittorrentSavePath,
					url: settings.qbittorrentUrl,
					debrid,
				});
				return;
			}
			try {
				const version = await appVersion(settings);
				res.json({
					configured: true,
					connected: true,
					version,
					url: settings.qbittorrentUrl,
					save_path: settings.qbittorrentSavePath,
					content_path: settings.torrentContentPath,
					debrid,
				});
			} catch (err) {
				res.json({
					configured: true,
					connected: false,
					detail:
						err instanceof HttpError
							? err.detail
							: err instanceof Error
								? err.message
								: String(err),
					url: settings.qbittorrentUrl,
					save_path: settings.qbittorrentSavePath,
					content_path: settings.torrentContentPath,
					debrid,
				});
			}
		}),
	);

	// Installs (or clears) the Real-Debrid token. The token is validated against
	// GET /user before it is persisted, so a typo is reported here rather than
	// silently demoting every future torrent to qBittorrent. Persisted to
	// data/app.env (mode 0600, alongside SECRET_KEY) and applied in-process --
	// it is node-local config, not replicated cluster state.
	router.put(
		"/debrid",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		asyncHandler(async (req, res) => {
			try {
				const body = req.body ?? {};
				const actor = req.currentUser!.username;
				const ip = clientIp(state, req);

				if (typeof body.enabled === "boolean") {
					settings.realDebridEnabled = body.enabled;
					setEnvValue(
						settings.configPath,
						"REALDEBRID_ENABLED",
						body.enabled ? "true" : "false",
					);
				}

				if (body.api_key !== undefined) {
					const key = String(body.api_key ?? "").trim();
					if (key) {
						// Validated before persisting -- an unchecked key would look
						// installed while quietly falling back on every job.
						const account = await rd.user(key).catch((err: unknown) => {
							throw new HttpError(
								err instanceof rd.RealDebridError && err.authFailed ? 400 : 502,
								err instanceof rd.RealDebridError && err.authFailed
									? "Real-Debrid rejected that API token"
									: `could not verify the token with Real-Debrid: ${errText(err)}`,
							);
						});
						settings.realDebridApiKey = key;
						setEnvValue(settings.configPath, "REALDEBRID_API_KEY", key);
						recordAudit(db, {
							actor,
							action: "torrent.debrid_key_set",
							target: `realdebrid:${account.username}`,
							ip,
						});
						log.info(
							`Real-Debrid token installed by ${actor} account=${account.username} type=${account.type}`,
						);
					} else {
						settings.realDebridApiKey = "";
						setEnvValue(settings.configPath, "REALDEBRID_API_KEY", "");
						recordAudit(db, {
							actor,
							action: "torrent.debrid_key_cleared",
							target: "realdebrid",
							ip,
						});
						log.info(`Real-Debrid token cleared by ${actor}`);
					}
				} else if (typeof body.enabled === "boolean") {
					recordAudit(db, {
						actor,
						action: body.enabled
							? "torrent.debrid_enabled"
							: "torrent.debrid_disabled",
						target: "realdebrid",
						ip,
					});
				}

				res.json(await debridStatus(state));
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	router.get("/", requireMaster(state), (_req, res) => {
		const jobs = db.all<TorrentJobRow>(
			"SELECT * FROM torrent_jobs ORDER BY id DESC LIMIT 500",
		);
		const usernames = new Map<number, string>();
		for (const u of db.all<UserRow>("SELECT id, username FROM users"))
			usernames.set(u.id, u.username);
		res.json({
			torrents: jobs.map((j) =>
				serializeJob(j, usernames.get(j.owner_id) ?? "unknown"),
			),
		});
	});

	return router;
}
