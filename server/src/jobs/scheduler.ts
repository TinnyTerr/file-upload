import type { AppState } from "../appState.ts";
import { getLogger } from "../logging.ts";
import { archiveIdleJob, deleteIdleJob, tempExpiryJob, linkExpiryJob } from "./lifecycle.ts";
import { sweepStaleParts } from "../routes/files.ts";

/** setInterval-based scheduler mirroring app/main.py's BackgroundScheduler
 * wiring: archive_idle/delete_idle/temp_expiry/sweep_stale_parts hourly,
 * link_expiry every 10 minutes. reconcile_stale_states has no interval in
 * Python either -- it's manual-trigger only (see routes/admin.ts). Cluster
 * heartbeat/sync jobs are deferred along with the rest of the cluster
 * runtime, so they're not registered here. */

const log = getLogger("app.jobs.scheduler");

const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

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
    { id: "sweep_stale_parts", intervalMs: HOUR_MS, run: () => sweepStaleParts() },
  ];
}

async function runJob(id: string, run: () => void | Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    log.error(`scheduled job failed job=${id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/** Registers and starts every job on its own setInterval timer. Idempotent --
 * calling it again (e.g. from restartBackendWorkers) stops any existing
 * timers first. Returns the job ids that were (re)started. */
export function startBackendWorkers(state: AppState): string[] {
  stopBackendWorkers();
  const specs = buildJobSpecs(state);
  for (const spec of specs) {
    const timer = setInterval(() => void runJob(spec.id, spec.run), spec.intervalMs);
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
export function restartBackendWorkers(state: AppState): { status: "restarted"; jobs: string[] } {
  const jobs = startBackendWorkers(state);
  return { status: "restarted", jobs };
}

export function isSchedulerRunning(): boolean {
  return timers.size > 0;
}
