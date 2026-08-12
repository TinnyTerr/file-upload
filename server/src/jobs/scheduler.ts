import type { AppState } from "../appState.ts";
import { cacheEvictionJob } from "../cluster/cacheEviction.ts";
import { credentialMaintenanceJob } from "../cluster/credentials.ts";
import { syncCheckJob } from "../cluster/digest.ts";
import { heartbeatJob } from "../cluster/membership.ts";
import { chunkReplicationJob } from "../cluster/placement.ts";
import { quotaSweepJob } from "../cluster/quota.ts";
import { rechunkLegacyJob } from "../cluster/rechunk.ts";
import { replicationPullJob } from "../cluster/replication.ts";
import { tieringDriftJob } from "../cluster/tiering.ts";
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
 * cluster_heartbeat, cluster_sync_check, cluster_tiering_drift and
 * cluster_cache_eviction run alongside them; they are cheap no-ops on a
 * single, unlinked node (no rows in cluster_nodes) or on a REPLICATION_MODE
 * != cache node, so registering them unconditionally matches the Python
 * scheduler's approach of always running the jobs rather than gating on
 * cluster configuration. */

const log = getLogger("app.jobs.scheduler");

const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FIVE_SEC_MS = 5 * 1000;
const SECOND_MS = 1000;

interface JobSpec {
	id: string;
	intervalMs: number;
	run: () => unknown;
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
		// Per-node credentials (§5.13). Three things at one cadence because they
		// are one thing: establish where we are still calling a peer with the
		// shared token, re-mint what has aged out, and sweep what the rotation
		// overlap has finished with. This is the whole migration path off
		// CLUSTER_TOKEN -- an upgraded cluster credentials itself within a tick or
		// two and then stops honouring the shared token on its own. Nothing to do
		// on a node with no peers.
		{
			id: "cluster_credentials",
			intervalMs: 5 * MINUTE_MS,
			run: () => credentialMaintenanceJob(state),
		},
		// The drift counter (§5.4). Master-only, and a single query on a node with
		// no peers -- it replaces `cluster_election_liveness`, which existed to
		// notice a dead master and start an election. Nothing starts an election
		// any more, so nothing needs to run at 15-second granularity: a status
		// change has to be HELD for five minutes before it counts at all.
		{
			id: "cluster_tiering_drift",
			intervalMs: MINUTE_MS,
			run: () => tieringDriftJob(state),
		},
		// Releases quota reservations nobody has touched for a full inactivity
		// window (§5.9, D-16). Master-only -- a follower holds no ledger. Hourly
		// is plenty against a 12-hour window, and the sweep is the only path that
		// releases bytes without the reserving node saying so.
		{
			id: "cluster_quota_sweep",
			intervalMs: HOUR_MS,
			run: () => quotaSweepJob(state),
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
		// Places the replication factor's worth of copies of every chunk this
		// node holds (§5.11). Background work with a per-tick budget: it is
		// durability catching up, not a transfer anybody is waiting on. A node
		// with no peers finds no target and does nothing.
		{
			id: "cluster_chunk_replication",
			intervalMs: MINUTE_MS,
			run: () => chunkReplicationJob(state),
		},
		// Splits the whole-file manifests Phase 8 seeded for blobs that predate
		// it (R-2), a byte budget at a time. Master-only -- a manifest has one
		// writer cluster-wide -- and a no-op the moment the corpus has caught
		// up, which for a deployment that never held a pre-chunking blob is
		// immediately.
		{
			id: "cluster_rechunk_legacy",
			intervalMs: HOUR_MS,
			run: () => rechunkLegacyJob(state),
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

async function runJob(id: string, run: () => unknown): Promise<void> {
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
