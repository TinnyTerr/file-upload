import type { AppState } from "../appState.ts";
import { cacheEvictionJob } from "../cluster/cacheEviction.ts";
import { syncCheckJob } from "../cluster/digest.ts";
import { checkMasterLivenessJob } from "../cluster/election.ts";
import { heartbeatJob } from "../cluster/membership.ts";
import { replicationPullJob } from "../cluster/replication.ts";
import { getLogger } from "../logging.ts";
import { prunePlayKeys } from "../media/playKeys.ts";
import { sweepStaleParts } from "../routes/files.ts";
import { pruneOauth } from "../security/oauth.ts";
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
const SECOND_MS = 1000;

interface JobSpec {
	id: string;
	intervalMs: number;
	run: () => void | Promise<unknown>;
}

const timers = new Map<string, ReturnType<typeof setInterval>>();

function buildJobSpecs(state: AppState): JobSpec[] {
	const { db } = state;
	return [
		{ id: "archive_idle", intervalMs: HOUR_MS, run: () => archiveIdleJob(db) },
		{ id: "delete_idle", intervalMs: HOUR_MS, run: () => deleteIdleJob(db) },
		{ id: "temp_expiry", intervalMs: HOUR_MS, run: () => tempExpiryJob(db) },
		{ id: "link_expiry", intervalMs: TEN_MIN_MS, run: () => linkExpiryJob(db) },
		{
			id: "sweep_stale_parts",
			intervalMs: HOUR_MS,
			run: () => sweepStaleParts(),
		},
		// Only deletes already-expired rows, so a revocation is never dropped
		// while the token it kills could still be presented -- media/playKeys.ts.
		{
			id: "media_playkey_prune",
			intervalMs: HOUR_MS,
			run: () => prunePlayKeys(db),
		},
		// Only deletes rows already past expires_at, so a revoked-but-unexpired
		// refresh token survives as its own reuse-detection record -- see
		// security/oauth.ts::pruneOauth.
		{
			id: "oauth_prune",
			intervalMs: HOUR_MS,
			run: () => pruneOauth(db),
		},
		{
			id: "cluster_heartbeat",
			intervalMs: MINUTE_MS,
			run: () => heartbeatJob(state),
		},
		{
			id: "cluster_sync_check",
			intervalMs: 5 * MINUTE_MS,
			run: () => syncCheckJob(state),
		},
		{
			id: "cluster_election_liveness",
			intervalMs: FIFTEEN_SEC_MS,
			run: () => checkMasterLivenessJob(state),
		},
		// One pull interval per hop is the propagation budget the redesign sets
		// (§5.7). Costs nothing on a node with no peers, and nothing on a
		// follower that cannot resolve a master -- both return an empty target
		// list without making a request.
		{
			id: "cluster_replication_pull",
			intervalMs: SECOND_MS,
			run: () => replicationPullJob(state),
		},
		{
			id: "cluster_cache_eviction",
			intervalMs: TEN_MIN_MS,
			run: () => cacheEvictionJob(state),
		},
		// One qBittorrent request per tick (not per job), and zero requests at
		// all when no job is in flight -- see torrents/poller.ts.
		{
			id: "torrent_poll",
			intervalMs: FIVE_SEC_MS,
			run: () => torrentPollJob(state),
		},
	];
}

async function runJob(
	id: string,
	run: () => void | Promise<unknown>,
): Promise<void> {
	try {
		await run();
	} catch (err) {
		log.error(
			`scheduled job failed job=${id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
		);
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
		const timer = setInterval(
			() => void runJob(spec.id, spec.run),
			spec.intervalMs,
		);
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
