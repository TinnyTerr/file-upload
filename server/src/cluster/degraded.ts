import type { AppState } from "../appState.ts";
import { getLogger } from "../logging.ts";
import { currentTiering, isMaster } from "./tiering.ts";

/**
 * Master loss: grace, then degrade (redesign §5.5, D-2).
 *
 * **There is no automatic failover.** A node cannot distinguish "the master
 * died" from "I am the one who got cut off", and promoting on the second
 * reading is precisely the split brain the deleted `election.ts` spent 536
 * lines failing to prevent. Choosing not to guess is cheaper and safer than
 * guessing badly; the mitigation is operational — a banner and a one-click
 * promote — not algorithmic.
 *
 * The state machine has three states and one input, "when did this node last
 * confirm contact with the master":
 *
 * | Phase | Behaviour |
 * |---|---|
 * | `ok` | Normal. |
 * | `grace` (≤ 5 min) | Requests needing the master are **held**, not failed. A master returning inside the window drains them and the only user-visible effect is latency. |
 * | `degraded` (> 5 min) | Held requests fail with an error naming the cause. Reads keep working; writes do not. |
 *
 * Holding rather than failing is the part worth being careful about: a master
 * restart takes seconds, and turning every upload in that window into an error
 * would make routine maintenance look like an outage.
 *
 * A **master** is never degraded — it is the authority — and neither is a node
 * with no peers at all, which is a cluster of one whose master is itself.
 */

const log = getLogger("app.cluster.degraded");

/** §5.5's restart grace. Requests are held for this long before they start
 * failing, and it is deliberately the same 5 minutes as the tiering hold-down:
 * both are answering "has this really changed, or is something restarting?" */
export const MASTER_GRACE_MS = 5 * 60 * 1000;

/** How long a held request waits for the master to come back before it gives
 * up on its own. Below the grace window, so a request that arrives at the
 * *start* of an outage fails cleanly rather than hanging until the client
 * times out and retries into the same queue. */
export const HELD_REQUEST_TIMEOUT_MS = 60 * 1000;

export type MasterPhase = "ok" | "grace" | "degraded";

/** Serialized straight onto `GET /api/cluster/self`, so snake_case like every
 * other payload in this API. */
export interface MasterStatus {
	phase: MasterPhase;
	/** ms since contact was last confirmed; 0 on a master or a lone node. */
	silent_ms: number;
	/** ms remaining in the grace window, 0 once it has expired. */
	grace_remaining_ms: number;
	master_node_id: string | null;
	/** Requests currently parked waiting for the master to return. */
	held: number;
}

/**
 * Tracks master reachability and parks work while it is in doubt.
 *
 * Lives on `AppState` because it is process-local by nature: it is this node's
 * opinion about a peer, not cluster state, and persisting it would only mean
 * reloading a stale opinion after a restart.
 */
export class MasterReachability {
	/** Explicitly tracked rather than inferred from "time since last success".
	 * Contact is confirmed roughly once a second by the replication pull, so a
	 * time-only reading would have to pick a staleness threshold and would then
	 * report `grace` during perfectly healthy operation. Reachability is a fact
	 * the caller already knows; it should say so rather than be guessed at. */
	private reachable = true;
	private lastContactMs = Date.now();
	private waiters: Array<{
		resolve: () => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];

	/** Called from every successful exchange with the master — the heartbeat and
	 * each replication pull. One confirmed round-trip is all the evidence the
	 * grace timer needs. */
	confirmContact(): void {
		this.lastContactMs = Date.now();
		if (!this.reachable) {
			log.info("master reachable again; releasing held requests");
			this.reachable = true;
		}
		this.drain();
	}

	/** Called when an exchange with the master fails. The grace clock runs from
	 * the last *success*, so a flapping master does not keep resetting it. */
	noteFailure(): void {
		const wasReachable = this.reachable;
		this.reachable = false;
		const phase = this.phase();
		if (wasReachable) {
			log.warning(
				"master unreachable; holding write-path requests for the restart grace window",
			);
		}
		if (phase === "degraded") {
			if (wasReachable || this.waiters.length > 0) {
				log.error(
					"master unreachable beyond the grace window; this node is DEGRADED -- reads continue, writes are refused until the master returns or an operator promotes a node",
				);
			}
			this.failAll();
		}
	}

	phase(): MasterPhase {
		if (this.reachable) return "ok";
		return Date.now() - this.lastContactMs < MASTER_GRACE_MS
			? "grace"
			: "degraded";
	}

	private drain(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			clearTimeout(w.timer);
			w.resolve();
		}
	}

	private failAll(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			clearTimeout(w.timer);
			w.reject(new Error("master unreachable"));
		}
	}

	get heldCount(): number {
		return this.waiters.length;
	}

	silentMs(): number {
		return Date.now() - this.lastContactMs;
	}

	/** Park until the master is confirmed reachable again, the grace window
	 * expires, or this request's own patience runs out. */
	hold(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.timer !== timer);
				reject(new Error("timed out waiting for the master"));
			}, HELD_REQUEST_TIMEOUT_MS);
			timer.unref?.();
			this.waiters.push({ resolve, reject, timer });
		});
	}
}

/** Whether this node needs a reachable master at all. A master does not, and
 * neither does a node that has never been linked to one — a standalone
 * deployment must not be told it is degraded because a cluster it is not part
 * of has no leader. */
function needsMaster(state: AppState): boolean {
	if (isMaster(state)) return false;
	const tiering = currentTiering(state.db);
	if (!tiering) return false;
	return tiering.master_node_id !== state.settings.nodeId;
}

export function masterStatus(state: AppState): MasterStatus {
	const tiering = currentTiering(state.db);
	const masterNodeId = tiering?.master_node_id ?? null;
	if (!needsMaster(state)) {
		return {
			phase: "ok",
			silent_ms: 0,
			grace_remaining_ms: 0,
			master_node_id: masterNodeId,
			held: state.masterReachability.heldCount,
		};
	}
	const phase = state.masterReachability.phase();
	const silentMs = phase === "ok" ? 0 : state.masterReachability.silentMs();
	return {
		phase,
		silent_ms: silentMs,
		grace_remaining_ms:
			phase === "ok" ? 0 : Math.max(0, MASTER_GRACE_MS - silentMs),
		master_node_id: masterNodeId,
		held: state.masterReachability.heldCount,
	};
}

export function isDegraded(state: AppState): boolean {
	return masterStatus(state).phase === "degraded";
}

/**
 * Gate a write on the master being reachable.
 *
 * Inside the grace window this **waits** rather than failing — that is the
 * whole of §5.5's "requests are held, not failed", and the reason a master
 * restart costs latency instead of errors. Past the window it throws, with a
 * message naming the cause, because at that point a client retrying forever is
 * worse than a client being told.
 *
 * Not called for reads. Every read is local by construction (that is Option C's
 * rejection in Part 6), so a degraded node serves listings, downloads, previews
 * and public links exactly as before.
 */
export async function awaitWritable(state: AppState): Promise<void> {
	if (!needsMaster(state)) return;
	for (;;) {
		const status = masterStatus(state);
		if (status.phase === "ok") return;
		if (status.phase === "degraded") {
			throw new Error(
				"the cluster master is unreachable and the restart grace window has expired; " +
					"this node is read-only until the master returns or an operator promotes a node",
			);
		}
		try {
			await state.masterReachability.hold();
		} catch (err) {
			throw new Error(
				`the cluster master is unreachable: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
