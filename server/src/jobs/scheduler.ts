import type { AppState } from "../appState.ts";
import { pruneLinkHits } from "../linkStats.ts";
import { cacheEvictionJob } from "../cluster/cacheEviction.ts";
import { syncCheckJob } from "../cluster/digest.ts";
import { checkMasterLivenessJob } from "../cluster/election.ts";
import { heartbeatJob } from "../cluster/membership.ts";
import { getLogger } from "../logging.ts";
import { type Component, activity } from "../cluster/activity.ts";
import { prunePlayKeys } from "../media/playKeys.ts";
import { sweepStaleParts } from "../routes/files.ts";
import { pruneOauth } from "../security/oauth.ts";
import { pruneRateLimitBuckets } from "../security/rateLimit.ts";
import { resetInterruptedImports, torrentPollJob } from "../torrents/poller.ts";
import {
	archiveIdleJob,
	deleteIdleJob,
	linkExpiryJob,
	tempExpiryJob,
} from "./lifecycle.ts";

/** setInterval-based scheduler mirroring app/main.py's BackgroundScheduler
 * wiring: archive_idle/delete_idle/temp_expiry/sweep_stale_parts hourly,
 * link_expiry every 10 minutes. reconcile_stale_states has no interval in
 * Python either -- it's manual-trigger only (see routes/admin.ts).
 * cluster_heartbeat, cluster_sync_check, cluster_election_liveness and
 * cluster_cache_eviction run alongside them; they are cheap no-ops on a
 * single, unlinked node (no rows in cluster_nodes) or on a REPLICATION_MODE
 * != cache node, so registering them unconditionally matches the Python
 * scheduler's approach of always running the jobs rather than gating on
 * cluster configuration. */

const log = getLogger("app.jobs.scheduler");

const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FIFTEEN_SEC_MS = 15 * 1000;
const FIVE_SEC_MS = 5 * 1000;

interface JobSpec {
	id: string;
	/** What the job is known to use; shown on the live cluster activity view. */
	touches: Component[];
	intervalMs: number;
	run: () => unknown;
}

const timers = new Map<string, ReturnType<typeof setInterval>>();

function buildJobSpecs(state: AppState): JobSpec[] {
	const { db } = state;
	return [
		{
			id: "archive_idle",
			touches: ["db", "disk"],
			intervalMs: HOUR_MS,
			run: () => archiveIdleJob(db),
		},
		{
			id: "delete_idle",
			touches: ["db", "disk"],
			intervalMs: HOUR_MS,
			run: () => deleteIdleJob(db),
		},
		{
			id: "temp_expiry",
			touches: ["db", "disk"],
			intervalMs: HOUR_MS,
			run: () => tempExpiryJob(db),
		},
		{
			id: "rate_limit_prune",
			touches: [],
			intervalMs: MINUTE_MS,
			run: () => pruneRateLimitBuckets(),
		},
		{
			id: "link_expiry",
			touches: ["db"],
			intervalMs: TEN_MIN_MS,
			run: () => linkExpiryJob(db),
		},
		{
			id: "sweep_stale_parts",
			touches: ["disk"],
			intervalMs: HOUR_MS,
			run: () => sweepStaleParts(),
		},
		// Only deletes already-expired rows, so a revocation is never dropped
		// while the token it kills could still be presented -- media/playKeys.ts.
		{
			id: "media_playkey_prune",
			touches: ["db"],
			intervalMs: HOUR_MS,
			run: () => prunePlayKeys(db),
		},
		// Only deletes rows already past expires_at, so a revoked-but-unexpired
		// refresh token survives as its own reuse-detection record -- see
		// security/oauth.ts::pruneOauth.
		// Share-link analytics past their retention window.
		{
			id: "link_hits_prune",
			touches: ["db"],
			intervalMs: HOUR_MS,
			run: () => {
				pruneLinkHits(db);
			},
		},
		{
			id: "oauth_prune",
			touches: ["db"],
			intervalMs: HOUR_MS,
			run: () => pruneOauth(db),
		},
		// Expired sessions are refused on resolve, so this is purely hygiene:
		// one row per login, forever, was the alternative. Same for the
		// lockout counters, which are inert once their window has passed.
		{
			id: "session_prune",
			touches: ["db"],
			intervalMs: HOUR_MS,
			run: () => {
				const sessions = state.sessionManager.pruneExpired(db);
				const attempts = state.lockout.pruneStale(db);
				if (sessions || attempts) {
					log.info(
						`session prune removed sessions=${sessions} login_attempts=${attempts}`,
					);
				}
			},
		},
		{
			id: "cluster_heartbeat",
			touches: ["db", "peers"],
			intervalMs: MINUTE_MS,
			run: () => heartbeatJob(state),
		},
		{
			id: "cluster_sync_check",
			touches: ["db", "peers"],
			intervalMs: 5 * MINUTE_MS,
			run: () => syncCheckJob(state),
		},
		{
			id: "cluster_election_liveness",
			touches: ["db", "peers", "events"],
			intervalMs: FIFTEEN_SEC_MS,
			run: () => checkMasterLivenessJob(state),
		},
		{
			id: "cluster_cache_eviction",
			touches: ["db", "disk", "peers"],
			intervalMs: TEN_MIN_MS,
			run: () => cacheEvictionJob(state),
		},
		// One qBittorrent request per tick (not per job), and zero requests at
		// all when no job is in flight -- see torrents/poller.ts.
		{
			id: "torrent_poll",
			touches: ["db", "disk", "qbittorrent", "realdebrid"],
			intervalMs: FIVE_SEC_MS,
			run: () => torrentPollJob(state),
		},
	];
}

/** Jobs whose previous tick hasn't returned. A job that overruns its interval
 * (archive_idle compressing a backlog, a cluster sweep waiting on a slow peer)
 * must not start a second copy of itself -- for archive_idle that would be two
 * passes rewriting the same file at once. The tick is skipped, not queued. */
const running = new Set<string>();

async function runJob(id: string, run: () => unknown): Promise<void> {
	if (running.has(id)) {
		activity.jobSkipped(id);
		log.warning(`scheduled job skipped, previous run still active job=${id}`);
		return;
	}
	running.add(id);
	try {
		await activity.runJob(id, run);
	} catch (err) {
		log.error(
			`scheduled job failed job=${id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
		);
	} finally {
		running.delete(id);
	}
}

/** Registers and starts every job on its own setInterval timer. Idempotent --
 * calling it again (e.g. from restartBackendWorkers) stops any existing
 * timers first. Returns the job ids that were (re)started. */
export function startBackendWorkers(state: AppState): string[] {
	stopBackendWorkers();
	resetInterruptedImports(state.db);
	const specs = buildJobSpecs(state);
	for (const spec of specs) {
		activity.registerJob(spec.id, spec.intervalMs, spec.touches);
		const timer = setInterval(() => {
			activity.jobTicked(spec.id);
			void runJob(spec.id, spec.run);
		}, spec.intervalMs);
		// Don't hold the process open just for background sweeps.
		timer.unref?.();
		timers.set(spec.id, timer);
	}
	const jobs = specs.map((s) => s.id);
	log.info(`backend worker scheduler started jobs=[${jobs.join(", ")}]`);
	return jobs;
}

/** Clears every registered timer. No-op (and silent, matching
 * app/main.py::_shutdown_backend_workers's early return) if nothing is running. */
export function stopBackendWorkers(): void {
	if (timers.size === 0) return;
	for (const timer of timers.values()) clearInterval(timer);
	timers.clear();
	activity.clearJobs();
	log.info("backend worker scheduler stopped");
}

/** Stop + start, for POST /admin/backend/restart-workers. Mirrors
 * app/main.py::_restart_backend_workers's response shape. */
export function restartBackendWorkers(state: AppState): {
	status: "restarted";
	jobs: string[];
} {
	const jobs = startBackendWorkers(state);
	return { status: "restarted", jobs };
}

export function isSchedulerRunning(): boolean {
	return timers.size > 0;
}
