import { AsyncLocalStorage } from "node:async_hooks";

/** Live view of what this node is doing: scheduled jobs, requests arriving
 * from peers, requests leaving to them.
 *
 * Cost model. Two tiers, so the always-on part is negligible and the rest only
 * costs anything while someone is looking:
 *  - `jobStats` is bookkeeping the scheduler does regardless (a few field
 *    writes per tick) so a watcher who connects mid-interval can be told when
 *    each job last ran and when it is next due.
 *  - Spans (`begin`) are only built, buffered and fanned out while at least
 *    one websocket is subscribed. With nobody watching `begin` returns a shared
 *    no-op without allocating, and the AsyncLocalStorage context is not
 *    entered at all.
 * A span that started before a watcher connected is simply invisible to them;
 * its `end` carries an id they never saw and is ignored client-side. */

/** What a span can be said to touch. Static per job / endpoint -- the tracer
 * does not instrument the DB driver, so this is "what this work is known to
 * use", not a measured call. */
export type Component =
	| "db"
	| "disk"
	| "events"
	| "peers"
	| "qbittorrent"
	| "realdebrid";

export type SpanKind = "job" | "out" | "in";

export interface Span {
	id: number;
	kind: SpanKind;
	name: string;
	touches: Component[];
	/** Remote end: the peer's host for `out`, the caller's IP for `in`. */
	peer?: string;
	/** For `out`: the job this call was made from, when there is one. */
	cause?: string;
	startedAt: number;
}

export interface JobStat {
	id: string;
	intervalMs: number;
	touches: Component[];
	running: boolean;
	lastStartAt: number | null;
	lastMs: number | null;
	lastOk: boolean | null;
	lastError: string | null;
	nextDueAt: number;
	skipped: number;
}

export type ActivityMessage =
	| { type: "snapshot"; now: number; jobs: JobStat[]; open: Span[] }
	| { type: "start"; span: Span }
	| {
			type: "end";
			id: number;
			ok: boolean;
			ms: number;
			detail?: string;
			at: number;
	  }
	| { type: "skipped"; job: string; at: number };

type Listener = (msg: ActivityMessage) => void;
export type EndSpan = (ok?: boolean, detail?: string) => void;

const NOOP: EndSpan = () => {};
const jobContext = new AsyncLocalStorage<string>();

class ActivityTracer {
	private listeners = new Set<Listener>();
	private open = new Map<number, Span>();
	private jobs = new Map<string, JobStat>();
	private seq = 0;

	get watching(): boolean {
		return this.listeners.size > 0;
	}

	get watcherCount(): number {
		return this.listeners.size;
	}

	// ── job bookkeeping (always on) ───────────────────────────────────────

	registerJob(id: string, intervalMs: number, touches: Component[]): void {
		this.jobs.set(id, {
			id,
			intervalMs,
			touches,
			running: false,
			lastStartAt: null,
			lastMs: null,
			lastOk: null,
			lastError: null,
			nextDueAt: Date.now() + intervalMs,
			skipped: 0,
		});
	}

	clearJobs(): void {
		this.jobs.clear();
	}

	/** The timer fired: the next one is a full interval away. */
	jobTicked(id: string): void {
		const j = this.jobs.get(id);
		if (j) j.nextDueAt = Date.now() + j.intervalMs;
	}

	jobSkipped(id: string): void {
		const j = this.jobs.get(id);
		if (j) j.skipped++;
		this.emit({ type: "skipped", job: id, at: Date.now() });
	}

	/** Runs `fn` as the job's span. The job bookkeeping is unconditional; the
	 * span (and the async context that attributes outbound calls to it) only
	 * exists while watched. */
	async runJob<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
		const j = this.jobs.get(id);
		const started = Date.now();
		if (j) {
			j.running = true;
			j.lastStartAt = started;
		}
		const end = this.begin("job", id, { touches: j?.touches ?? [] });
		try {
			const out = this.watching
				? await jobContext.run(id, async () => fn())
				: await fn();
			if (j) {
				j.lastOk = true;
				j.lastError = null;
			}
			end(true);
			return out;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (j) {
				j.lastOk = false;
				j.lastError = msg;
			}
			end(false, msg);
			throw err;
		} finally {
			if (j) {
				j.running = false;
				j.lastMs = Date.now() - started;
			}
		}
	}

	// ── spans (only while watched) ────────────────────────────────────────

	begin(
		kind: SpanKind,
		name: string,
		opts: { touches?: Component[]; peer?: string } = {},
	): EndSpan {
		if (this.listeners.size === 0) return NOOP;
		const span: Span = {
			id: ++this.seq,
			kind,
			name,
			touches: opts.touches ?? [],
			peer: opts.peer,
			cause: kind === "out" ? jobContext.getStore() : undefined,
			startedAt: Date.now(),
		};
		this.open.set(span.id, span);
		this.emit({ type: "start", span });
		let done = false;
		return (ok = true, detail) => {
			if (done) return;
			done = true;
			this.open.delete(span.id);
			const at = Date.now();
			this.emit({
				type: "end",
				id: span.id,
				ok,
				ms: at - span.startedAt,
				detail,
				at,
			});
		};
	}

	// ── watchers ──────────────────────────────────────────────────────────

	/** Subscribe, receiving a snapshot first. Returns the unsubscribe. When the
	 * last watcher leaves, open-span tracking is dropped so nothing lingers. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.open.clear();
		};
	}

	snapshot(): ActivityMessage {
		return {
			type: "snapshot",
			now: Date.now(),
			jobs: [...this.jobs.values()].map((j) => ({ ...j })),
			open: [...this.open.values()],
		};
	}

	private emit(msg: ActivityMessage): void {
		for (const l of this.listeners) {
			try {
				l(msg);
			} catch {
				// a dead socket must not break the work being traced
			}
		}
	}
}

export const activity = new ActivityTracer();

/** Components an inbound `/api/cluster` or `/api/admin/cluster` path is known
 * to use. */
export function inboundTouches(path: string): Component[] {
	if (path.includes("/blobs/")) return ["disk"];
	if (path.endsWith("/vote-request") || path.endsWith("/master-assumed"))
		return ["db", "events"];
	if (path.endsWith("/events")) return ["db", "events"];
	return ["db"];
}
