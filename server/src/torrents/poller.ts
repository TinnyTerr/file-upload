import { existsSync } from "node:fs";
import type { AppState } from "../appState.ts";
import { nowIso, type TorrentJobRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import {
	cleanupDebridDir,
	dispatchTorrent,
	errText,
	fallbackToQbittorrent,
	fetchDebridFiles,
	isTransferComplete,
	pollDebridJob,
	readStashedSource,
	releaseDebridJob,
	type TorrentSource,
} from "./debrid.ts";
import {
	cleanupJobDir,
	importCompletedTorrent,
	localJobDir,
} from "./importer.ts";
import {
	allTorrents,
	byTag,
	deleteTorrent,
	isConfigured,
	isDoneState,
	isErrorState,
	type QbitTorrent,
	setShareLimits,
} from "./qbittorrent.ts";
import {
	isConfigured as debridConfigured,
	RealDebridError,
} from "./realdebrid.ts";

const log = getLogger("app.torrents.poller");

/** How long a job may go without qBittorrent knowing about its tag before it is
 * declared lost -- covers the gap between add and the torrent showing up, and
 * catches torrents removed from qBittorrent behind our back. */
const MISSING_GRACE_MS = 3 * 60 * 1000;

/** Real-Debrid is polled less often than the 5s scheduler tick: its API is
 * rate limited per token, and a torrent's state there moves in seconds-to-
 * minutes, not milliseconds. */
const DEBRID_POLL_MS = 10 * 1000;

export const ACTIVE_STATUSES = ["queued", "downloading", "fetching"] as const;

/** Job statuses that hold a slot against `MAX_ACTIVE_PER_USER`.
 *
 * `pending` is deliberately absent — it is what a job sits in *because* it
 * could not get a slot, so counting it would deadlock the queue. `seeding` is
 * absent too: its files are already imported and the owner is done waiting on
 * it, so a popular torrent must not block the next download for days. */
export const IN_FLIGHT_STATUSES = [
	"queued",
	"downloading",
	"fetching",
	"importing",
] as const;

const IN_FLIGHT_SQL = IN_FLIGHT_STATUSES.map((s) => `'${s}'`).join(", ");

/** Concurrent in-flight torrents per user. Beyond this a submission is
 * accepted and parked in `pending` rather than refused, and the poller starts
 * it as soon as one of that user's slots frees up. Per user, not global: one
 * account filling its own queue must not stall everyone else's. */
export const MAX_ACTIVE_PER_USER = 5;

/** Depth of a single user's waiting queue. This one *is* a hard refusal — the
 * queue exists so a burst of submissions is absorbed rather than rejected, not
 * so an unbounded backlog can be built up. */
export const MAX_QUEUED_PER_USER = 50;

function fail(db: Db, job: TorrentJobRow, detail: string): void {
	db.run(
		"UPDATE torrent_jobs SET status = 'failed', error = $err, updated_at = $now, completed_at = $now WHERE id = $id",
		{
			$err: detail.slice(0, 1000),
			$now: nowIso(),
			$id: job.id,
		},
	);
	log.warning(
		`torrent job failed job_id=${job.id} owner_id=${job.owner_id} error=${detail}`,
	);
}

function updateProgress(db: Db, job: TorrentJobRow, t: QbitTorrent): void {
	db.run(
		`UPDATE torrent_jobs SET status = 'downloading', name = $name, info_hash = $hash, progress = $progress,
       size_bytes = $size, downloaded_bytes = $done, dl_speed = $speed, eta_seconds = $eta, updated_at = $now
     WHERE id = $id`,
		{
			$name: t.name || job.name,
			$hash: t.hash || job.info_hash,
			$progress: t.progress ?? 0,
			$size: t.size ?? 0,
			$done: t.completed ?? 0,
			$speed: t.dlspeed ?? 0,
			// qBittorrent reports 8640000 ("∞") when it has no estimate.
			$eta: t.eta && t.eta > 0 && t.eta < 8640000 ? t.eta : null,
			$now: nowIso(),
			$id: job.id,
		},
	);
}

/** Runs the import for a job whose data is on disk, then settles the row.
 * Shared by the poller, the debrid transfer task and the manual retry endpoint. */
export async function importJob(
	state: AppState,
	job: TorrentJobRow,
): Promise<void> {
	const { db } = state;
	db.run(
		"UPDATE torrent_jobs SET status = 'importing', updated_at = $now WHERE id = $id",
		{
			$now: nowIso(),
			$id: job.id,
		},
	);
	try {
		const result = await importCompletedTorrent(state, job);
		// Seeding only exists on qBittorrent: a Real-Debrid job has no local
		// torrent to seed from, only files we pulled over HTTP.
		const willSeed =
			job.provider !== "debrid" &&
			state.settings.qbittorrentSeeding &&
			isConfigured(state.settings) &&
			!!job.info_hash;
		db.run(
			`UPDATE torrent_jobs SET status = $status, error = NULL, progress = 1, dl_speed = 0, eta_seconds = NULL,
         directory_id = $dirId, imported_file_count = $count, size_bytes = $size, updated_at = $now, completed_at = $now
       WHERE id = $id`,
			{
				// completed_at is set either way: the owner's files are in their
				// storage now, and whether we keep uploading is not their wait.
				$status: willSeed ? "seeding" : "completed",
				$dirId: result.directoryId,
				$count: result.fileCount,
				$size: result.totalBytes,
				$now: nowIso(),
				$id: job.id,
			},
		);
		if (job.provider === "debrid") {
			// Drops the torrent from the Real-Debrid account and clears staging.
			await releaseDebridJob(state, job);
		} else if (willSeed) {
			// The import *copied* into blob storage, so the downloaded files are
			// still on disk and qBittorrent can keep serving them untouched.
			await setShareLimits(state.settings, job.info_hash!, {
				ratio: state.settings.qbittorrentSeedRatio,
				minutes: state.settings.qbittorrentSeedMinutes,
			});
		} else {
			if (job.info_hash)
				await deleteTorrent(state.settings, job.info_hash, true);
			cleanupJobDir(state, job);
		}
		log.info(
			`torrent job ${willSeed ? "imported, now seeding" : "completed"} job_id=${job.id} owner_id=${job.owner_id} files=${result.fileCount}`,
		);
	} catch (err) {
		// The downloaded data is deliberately left on disk so the owner can free up
		// quota and retry (POST /api/torrents/:id/retry) instead of re-downloading.
		fail(
			db,
			job,
			err instanceof HttpError
				? String(err.detail)
				: err instanceof Error
					? err.message
					: String(err),
		);
		throw err;
	}
}

/** True when a debrid job's staged files are complete and still on disk, so a
 * retry can go straight to the import instead of pulling everything down
 * again. A partially transferred directory deliberately does not count -- the
 * files in it are truncated. */
export function hasStagedContent(state: AppState, job: TorrentJobRow): boolean {
	try {
		return isTransferComplete(job.tag) && existsSync(localJobDir(state, job));
	} catch {
		return false;
	}
}

/** Re-runs a failed job. A debrid job whose staged files survived (the usual
 * case: the transfer succeeded and the *import* hit a quota wall) is imported
 * as-is; one that failed before or during the transfer is pulled again. */
export async function retryJob(
	state: AppState,
	job: TorrentJobRow,
): Promise<void> {
	if (job.provider === "debrid" && !hasStagedContent(state, job)) {
		if (!job.debrid_id)
			throw new HttpError(
				409,
				"this torrent has no Real-Debrid job left to retry",
			);
		startDebridFetch(state, job);
		return;
	}
	await importJob(state, job);
}

// ── the waiting queue ──────────────────────────────────────────────────────

/** Whether any backend can accept a torrent right now. Promoting into a
 * configuration with nowhere to send the job would fail the whole queue on the
 * next tick rather than leaving it waiting for the admin to finish setup. */
function anyBackendConfigured(state: AppState): boolean {
	return debridConfigured(state.settings) || isConfigured(state.settings);
}

/** Rebuilds the dispatch input for a job that was accepted but never sent.
 * A magnet is stored whole in `source`; an uploaded .torrent lives in the
 * on-disk stash, because the request that carried its bytes is long gone. */
function pendingSource(job: TorrentJobRow): TorrentSource | null {
	if (job.source.startsWith("magnet:")) return { magnet: job.source };
	const bytes = readStashedSource(job.tag);
	if (!bytes) return null;
	return { file: { filename: `${job.tag}.torrent`, bytes } };
}

/** Hands one pending job to a backend and moves it into the normal lifecycle.
 * Failure here settles the row rather than throwing: nobody is waiting on an
 * HTTP response, so the only way to report it is on the job itself. */
async function startPendingJob(
	state: AppState,
	job: TorrentJobRow,
): Promise<void> {
	const source = pendingSource(job);
	if (!source) {
		fail(state.db, job, "the queued .torrent file is no longer available");
		return;
	}
	let dispatch: Awaited<ReturnType<typeof dispatchTorrent>>;
	try {
		dispatch = await dispatchTorrent(state, source, job.tag);
	} catch (err) {
		fail(state.db, job, errText(err));
		return;
	}
	state.db.run(
		`UPDATE torrent_jobs SET status = 'queued', provider = $provider, save_path = $savePath,
       debrid_id = $debridId, fallback_reason = $fallbackReason, error = NULL,
       started_at = $now, updated_at = $now
     WHERE id = $id AND status = 'pending'`,
		{
			$provider: dispatch.provider,
			$savePath: dispatch.savePath,
			$debridId: dispatch.debridId,
			$fallbackReason: dispatch.fallbackReason,
			$now: nowIso(),
			$id: job.id,
		},
	);
	log.info(
		`queued torrent started job_id=${job.id} owner_id=${job.owner_id} provider=${dispatch.provider}` +
			(dispatch.fallbackReason ? ` fallback=${dispatch.fallbackReason}` : ""),
	);
}

/** Starts as many pending jobs as there are free slots, oldest first within
 * each owner. Runs before polling so a slot freed by the previous tick's
 * import is reused immediately. */
export async function promotePendingJobs(state: AppState): Promise<void> {
	const { db } = state;
	const pending = db.all<TorrentJobRow>(
		"SELECT * FROM torrent_jobs WHERE status = 'pending' ORDER BY id ASC",
	);
	if (!pending.length || !anyBackendConfigured(state)) return;

	// One grouped read for every owner's slot usage, not a COUNT per candidate.
	const active = new Map<number, number>();
	for (const row of db.all<{ owner_id: number; n: number }>(
		`SELECT owner_id, COUNT(*) AS n FROM torrent_jobs
       WHERE status IN (${IN_FLIGHT_SQL}) GROUP BY owner_id`,
	)) {
		active.set(row.owner_id, row.n);
	}

	for (const job of pending) {
		const running = active.get(job.owner_id) ?? 0;
		if (running >= MAX_ACTIVE_PER_USER) continue;
		// Counted before the await: dispatch is slow, and the same owner's next
		// pending job is decided in this same loop.
		active.set(job.owner_id, running + 1);
		try {
			await startPendingJob(state, job);
		} catch (err) {
			log.warning(
				`promoting queued torrent failed job_id=${job.id}: ${errText(err)}`,
			);
		}
	}
}

// ── seeding ────────────────────────────────────────────────────────────────

/** Whether a seeding torrent has served its share. qBittorrent reports
 * `ratio` as -1 before it has uploaded anything, which must not read as
 * "limit reached" — comparing against a strictly positive limit handles it. */
function seedLimitReached(state: AppState, t: QbitTorrent): boolean {
	const { qbittorrentSeedRatio, qbittorrentSeedMinutes } = state.settings;
	if (qbittorrentSeedRatio > 0 && (t.ratio ?? 0) >= qbittorrentSeedRatio)
		return true;
	if (
		qbittorrentSeedMinutes > 0 &&
		(t.seeding_time ?? 0) >= qbittorrentSeedMinutes * 60
	)
		return true;
	return false;
}

/** Retires a seeding torrent: out of qBittorrent, its downloaded copy off
 * disk, row settled. The imported files are untouched — they are ordinary
 * files in the owner's storage by now. */
async function finishSeeding(
	state: AppState,
	job: TorrentJobRow,
	reason: string,
): Promise<void> {
	if (job.info_hash && isConfigured(state.settings)) {
		await deleteTorrent(state.settings, job.info_hash, true);
	}
	cleanupJobDir(state, job);
	state.db.run(
		`UPDATE torrent_jobs SET status = 'completed', dl_speed = 0, updated_at = $now WHERE id = $id`,
		{ $now: nowIso(), $id: job.id },
	);
	log.info(
		`torrent seeding finished job_id=${job.id} owner_id=${job.owner_id} reason=${reason}`,
	);
}

async function pollSeedingJob(
	state: AppState,
	job: TorrentJobRow,
	torrent: QbitTorrent | undefined,
): Promise<void> {
	// Gone from qBittorrent — retired by its own share-limit action, or removed
	// by the operator. Either way the job is done, not failed: its files were
	// imported before seeding ever started.
	if (!torrent) {
		await finishSeeding(state, job, "no longer in qBittorrent");
		return;
	}
	state.db.run(
		`UPDATE torrent_jobs SET seed_ratio = $ratio, seed_seconds = $seconds, dl_speed = 0, updated_at = $now
     WHERE id = $id`,
		{
			$ratio: torrent.ratio ?? 0,
			$seconds: torrent.seeding_time ?? 0,
			$now: nowIso(),
			$id: job.id,
		},
	);
	if (!state.settings.qbittorrentSeeding) {
		await finishSeeding(
			state,
			{ ...job, info_hash: torrent.hash },
			"seeding disabled",
		);
		return;
	}
	if (seedLimitReached(state, torrent)) {
		await finishSeeding(
			state,
			{ ...job, info_hash: torrent.hash },
			`share limit reached (ratio ${(torrent.ratio ?? 0).toFixed(2)})`,
		);
	}
}

// ── Real-Debrid transfer tasks ─────────────────────────────────────────────

/** Job ids currently being pulled from Real-Debrid. The transfer runs detached
 * from the scheduler tick -- a multi-GB fetch must not hold up progress
 * updates for every other job the way an awaited call inside the poll loop
 * would. */
const fetching = new Set<number>();

/** Transfer attempts before a finished Real-Debrid torrent is written off and
 * the whole job restarts on qBittorrent. One retry, because a stalled CDN
 * connection is common and throwing away a completed remote download over it
 * is not worth re-leeching the torrent from scratch. */
const TRANSFER_ATTEMPTS = 2;
const TRANSFER_RETRY_DELAY_MS = 3000;

/** Whether a failure is Real-Debrid's fault (so the job should be handed to
 * qBittorrent) rather than the owner's (quota, file size), which no amount of
 * re-downloading fixes. */
function isDebridFault(err: unknown): boolean {
	if (err instanceof RealDebridError) return true;
	if (err instanceof HttpError) return err.status === 502 || err.status === 409;
	return true;
}

/** Marks the job as transferring and kicks off the detached fetch + import. */
export function startDebridFetch(state: AppState, job: TorrentJobRow): void {
	if (fetching.has(job.id)) return;
	fetching.add(job.id);
	state.db.run(
		`UPDATE torrent_jobs SET status = 'fetching', progress = 0, downloaded_bytes = 0, dl_speed = 0,
       eta_seconds = NULL, error = NULL, updated_at = $now
     WHERE id = $id`,
		{ $now: nowIso(), $id: job.id },
	);

	void (async () => {
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					await fetchDebridFiles(state, job);
					break;
				} catch (err) {
					if (attempt >= TRANSFER_ATTEMPTS || !isDebridFault(err)) throw err;
					log.warning(
						`Real-Debrid transfer attempt ${attempt} failed job_id=${job.id}, retrying: ${errText(err)}`,
					);
					await new Promise((resolve) =>
						setTimeout(resolve, TRANSFER_RETRY_DELAY_MS),
					);
				}
			}
			await importJob(state, job);
		} catch (err) {
			const detail = errText(err);
			// importJob already settled the row when the failure came from the
			// import itself; only the transfer leg still needs a verdict.
			const current = state.db.get<TorrentJobRow>(
				"SELECT * FROM torrent_jobs WHERE id = $id",
				{ $id: job.id },
			);
			if (!current || current.status === "failed") return;
			if (
				isDebridFault(err) &&
				(await fallbackToQbittorrent(state, current, detail))
			)
				return;
			// Past the import guard above, so this is a transfer failure: whatever
			// landed in staging is truncated and a retry re-pulls it anyway.
			cleanupDebridDir(current.tag);
			fail(state.db, current, detail);
		} finally {
			fetching.delete(job.id);
		}
	})();
}

// ── per-provider polling ───────────────────────────────────────────────────

async function pollQbitJob(
	state: AppState,
	job: TorrentJobRow,
	torrent: QbitTorrent | undefined,
): Promise<void> {
	const { db } = state;

	if (!torrent) {
		// From when the job was *dispatched*, not when it was submitted: a job
		// that waited an hour in the queue would otherwise blow this grace the
		// instant it started. Rows predating the queue have no started_at.
		const since = new Date(job.started_at ?? job.created_at).getTime();
		if (Date.now() - since > MISSING_GRACE_MS) {
			fail(db, job, "torrent is no longer present in qBittorrent");
		}
		return;
	}

	updateProgress(db, job, torrent);

	if (isErrorState(torrent.state)) {
		fail(db, job, `qBittorrent reported state "${torrent.state}"`);
		await deleteTorrent(state.settings, torrent.hash, true);
		cleanupJobDir(state, { ...job, info_hash: torrent.hash });
		return;
	}

	if (isDoneState(torrent.state) || (torrent.progress ?? 0) >= 1) {
		await importJob(state, {
			...job,
			info_hash: torrent.hash,
			name: torrent.name || job.name,
		});
	}
}

async function pollDebrid(state: AppState, job: TorrentJobRow): Promise<void> {
	// The row's own updated_at is the last-polled clock -- no side map to prune.
	if (Date.now() - new Date(job.updated_at).getTime() < DEBRID_POLL_MS) return;

	let outcome: "wait" | "fetch" | "dead";
	try {
		outcome = await pollDebridJob(state, job);
	} catch (err) {
		// A 404 means the torrent is gone from the account (deleted elsewhere);
		// anything else is transient and simply retried on the next tick.
		if (err instanceof RealDebridError && err.status === 404) {
			if (
				await fallbackToQbittorrent(
					state,
					job,
					"Real-Debrid no longer has this torrent",
				)
			)
				return;
			fail(state.db, job, "Real-Debrid no longer has this torrent");
			return;
		}
		log.warning(`Real-Debrid poll failed job_id=${job.id}: ${errText(err)}`);
		return;
	}

	if (outcome === "fetch") {
		startDebridFetch(state, job);
		return;
	}
	if (outcome === "dead") {
		const current =
			state.db.get<TorrentJobRow>("SELECT * FROM torrent_jobs WHERE id = $id", {
				$id: job.id,
			}) ?? job;
		const reason = `Real-Debrid reported status "${current.debrid_status ?? "error"}"`;
		if (await fallbackToQbittorrent(state, current, reason)) return;
		await releaseDebridJob(state, current);
		fail(state.db, current, reason);
	}
}

let running = false;

/** Scheduler job: advances every in-flight torrent on both backends and imports
 * the finished ones. Serialized via `running` so a slow tick can't overlap the
 * next one; the Real-Debrid transfer itself runs detached (startDebridFetch).
 *
 * qBittorrent jobs cost exactly ONE request per tick no matter how many are in
 * flight -- the full torrent list is fetched once and grouped by tag locally
 * (see torrents/qbittorrent.ts) -- and zero when none are queued. */
export async function torrentPollJob(state: AppState): Promise<void> {
	if (running) return;
	running = true;
	try {
		// Before polling, so a slot freed by the previous tick's import is handed
		// to the next waiting job without idling a whole interval.
		await promotePendingJobs(state);

		const jobs = state.db.all<TorrentJobRow>(
			"SELECT * FROM torrent_jobs WHERE status IN ('queued', 'downloading', 'seeding') ORDER BY id ASC",
		);
		if (jobs.length === 0) return;

		const seedingJobs = jobs.filter((j) => j.status === "seeding");
		const live = jobs.filter((j) => j.status !== "seeding");
		const debridJobs = live.filter((j) => j.provider === "debrid");
		const qbitJobs = live.filter((j) => j.provider !== "debrid");

		if (debridJobs.length && debridConfigured(state.settings)) {
			for (const job of debridJobs) {
				try {
					await pollDebrid(state, job);
				} catch (err) {
					log.warning(`debrid poll failed job_id=${job.id}: ${errText(err)}`);
				}
			}
		}

		if (
			(qbitJobs.length || seedingJobs.length) &&
			isConfigured(state.settings)
		) {
			let torrents: QbitTorrent[];
			try {
				torrents = await allTorrents(state.settings);
			} catch (err) {
				log.warning(
					`torrent list fetch failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
			// Still exactly one request per tick: downloading and seeding jobs are
			// both resolved out of this one list.
			const byTagMap = byTag(torrents);

			for (const job of qbitJobs) {
				try {
					await pollQbitJob(state, job, byTagMap.get(job.tag));
				} catch (err) {
					log.warning(
						`torrent poll failed job_id=${job.id}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			for (const job of seedingJobs) {
				try {
					await pollSeedingJob(state, job, byTagMap.get(job.tag));
				} catch (err) {
					log.warning(
						`seeding poll failed job_id=${job.id}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		} else if (seedingJobs.length) {
			// qBittorrent was unconfigured underneath these rows. Nothing can be
			// seeding any more, and leaving them in 'seeding' would strand them
			// there forever with their downloads still on disk.
			for (const job of seedingJobs) {
				await finishSeeding(state, job, "qBittorrent is no longer configured");
			}
		}
	} finally {
		running = false;
	}
}

/** A row left in `importing` or `fetching` means the process died mid-flight.
 * Neither is resumable from that point, so surface both as failed-but-retryable
 * at boot -- a debrid retry re-pulls from Real-Debrid, which still has the
 * finished torrent.
 *
 * Jobs in `fetching` whose transfer task is alive in *this* process are skipped:
 * this also runs from POST /admin/backend/restart-workers, which restarts the
 * scheduler without restarting the process, and a live transfer would otherwise
 * be declared dead underneath itself. */
export function resetInterruptedImports(db: Db): void {
	const rows = db
		.all<{ id: number }>(
			"SELECT id FROM torrent_jobs WHERE status IN ('importing', 'fetching')",
		)
		.filter((r) => !fetching.has(r.id));
	if (!rows.length) return;
	db.run(
		`UPDATE torrent_jobs SET status = 'failed', dl_speed = 0, eta_seconds = NULL,
       error = 'transfer was interrupted by a server restart', updated_at = $now
     WHERE id IN (${rows.map((r) => r.id).join(", ")})`,
		{ $now: nowIso() },
	);
	log.warning(`reset ${rows.length} interrupted torrent transfer(s)`);
}
