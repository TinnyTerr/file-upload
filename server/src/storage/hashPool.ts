/**
 * Bounded pool of digest workers (storage/hashWorker.ts).
 *
 * Pooled rather than spawned per call: `hashFile` asks for two digests at once,
 * and a busy node can have several finalizes in flight, so a worker-per-request
 * would answer one stall with an unbounded thread count. Tasks queue instead.
 *
 * Workers are `unref`'d, so a pool sitting idle never holds the process open --
 * `shutdownHashPool` exists for tests that want a deterministic teardown, not
 * for normal exit.
 */

import { availableParallelism } from "node:os";
import type { HashRequest, HashResponse } from "./hashWorker.ts";

/**
 * At least 2, so one `hashFile`'s two digests always run in parallel rather
 * than queueing behind each other. Capped low because these threads compete
 * with the event loop's own thread for the same cores -- past the core count,
 * more workers make uploads slower *and* the server less responsive.
 */
const MAX_WORKERS = Math.max(2, Math.min(4, availableParallelism()));

const WORKER_URL = new URL("./hashWorker.ts", import.meta.url).href;

interface Task {
	path: string;
	algo: string;
	resolve: (digest: string) => void;
	reject: (err: unknown) => void;
}

interface PoolWorker {
	worker: Worker;
	/** The task this worker is currently running, or null when idle. */
	current: Task | null;
}

const workers: PoolWorker[] = [];
const queue: Task[] = [];
let nextTaskId = 1;

function spawn(): PoolWorker {
	const worker = new Worker(WORKER_URL);
	const entry: PoolWorker = { worker, current: null };

	worker.onmessage = (event: MessageEvent<HashResponse>) => {
		const task = entry.current;
		entry.current = null;
		if (task) {
			const data = event.data;
			if ("error" in data) task.reject(new Error(data.error));
			else task.resolve(data.digest);
		}
		pump();
	};

	// A worker that dies takes its in-flight task with it. Reject that one task
	// rather than leaving a finalize awaiting a promise nothing will settle, and
	// drop the worker so the next pump spawns a replacement.
	worker.onerror = (event: ErrorEvent) => {
		const task = entry.current;
		entry.current = null;
		const at = workers.indexOf(entry);
		if (at !== -1) workers.splice(at, 1);
		try {
			worker.terminate();
		} catch {
			// already gone
		}
		task?.reject(new Error(`hash worker failed: ${event.message}`));
		pump();
	};

	// The pool must never be the reason the process stays alive.
	worker.unref();
	workers.push(entry);
	return entry;
}

/** Hands queued tasks to idle workers, spawning up to MAX_WORKERS on demand. */
function pump(): void {
	while (queue.length) {
		let free = workers.find((w) => w.current === null);
		if (!free && workers.length < MAX_WORKERS) free = spawn();
		if (!free) return;
		const task = queue.shift();
		if (!task) return;
		free.current = task;
		free.worker.postMessage({
			id: nextTaskId++,
			path: task.path,
			algo: task.algo,
		} satisfies HashRequest);
	}
}

/** One digest of one file, computed off the event loop. */
export function hashInWorker(path: string, algo: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		queue.push({ path, algo, resolve, reject });
		pump();
	});
}

/** Terminates every worker. Queued and in-flight tasks reject. */
export function shutdownHashPool(): void {
	for (const entry of workers.splice(0)) {
		entry.current?.reject(new Error("hash pool shut down"));
		entry.current = null;
		try {
			entry.worker.terminate();
		} catch {
			// already gone
		}
	}
	for (const task of queue.splice(0)) {
		task.reject(new Error("hash pool shut down"));
	}
}
