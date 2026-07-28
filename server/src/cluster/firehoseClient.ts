import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import type { ClusterEvent } from "./eventBus.ts";
import { applyHaltEvent } from "./halt.ts";
import { ClusterHTTPError, getJson } from "./http.ts";

/** Mirrors app/cluster/firehose_client.py, adapted from one daemon
 * thread-per-peer to one setInterval-driven poll loop per peer (this
 * codebase has no thread primitives -- see server/src/jobs/scheduler.ts for
 * the existing setInterval convention).
 *
 * Uses `GET /api/admin/cluster/events?after=<cursor>` (more robust to restarts
 * than an outbound websocket) with the peer's cluster token. Each event is
 * queued for durable persistence directly into cluster_events, preserving
 * the ORIGIN node's identity/seq carried in the event payload (this node
 * does not re-publish peer events onto its own local live bus -- see the
 * single-process sequencing note in eventBus.ts; re-publishing under a new
 * local id would break the (origin_node_id, origin_seq) dedup key). Applies
 * `upload.halt` / `upload.resume` control events to the local halt registry
 * so an operator-triggered halt gossips cluster-wide. */

const log = getLogger("app.cluster.firehose");

const RECONCILE_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

interface PollerHandle {
	token: string;
	cursor: number;
	timer: ReturnType<typeof setTimeout> | null;
	stopped: boolean;
}

export class ClusterFirehoseConsumer {
	private state: AppState;
	private pollers = new Map<string, PollerHandle>();
	private reconcileTimer: ReturnType<typeof setInterval> | null = null;

	constructor(state: AppState) {
		this.state = state;
	}

	start(): void {
		if (this.reconcileTimer) return;
		this.reconcileOnce();
		this.reconcileTimer = setInterval(
			() => this.reconcileOnce(),
			RECONCILE_INTERVAL_MS,
		);
		this.reconcileTimer.unref?.();
	}

	stop(): void {
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.reconcileTimer = null;
		for (const [, poller] of this.pollers) {
			poller.stopped = true;
			if (poller.timer) clearTimeout(poller.timer);
		}
		this.pollers.clear();
	}

	private reconcileOnce(): void {
		const nodes = this.state.db
			.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
			.filter(
				(n) =>
					n.node_id &&
					n.node_id !== this.state.settings.nodeId &&
					n.base_url &&
					n.token,
			);

		const desired = new Map<string, string>();
		for (const n of nodes) desired.set(n.base_url.replace(/\/$/, ""), n.token);

		for (const [baseUrl, poller] of this.pollers) {
			if (!desired.has(baseUrl)) {
				poller.stopped = true;
				if (poller.timer) clearTimeout(poller.timer);
				this.pollers.delete(baseUrl);
			}
		}

		for (const [baseUrl, token] of desired) {
			const existing = this.pollers.get(baseUrl);
			if (existing) {
				if (existing.token === token) continue;
				existing.stopped = true; // token rotated -- restart with the new one
				if (existing.timer) clearTimeout(existing.timer);
			}
			const handle: PollerHandle = {
				token,
				cursor: 0,
				timer: null,
				stopped: false,
			};
			this.pollers.set(baseUrl, handle);
			this.pollOnce(baseUrl, handle, POLL_INTERVAL_MS);
			log.info(`started firehose poller for peer ${baseUrl}`);
		}
	}

	private pollOnce(
		baseUrl: string,
		handle: PollerHandle,
		backoffMs: number,
	): void {
		if (handle.stopped) return;
		void (async () => {
			let nextBackoff = POLL_INTERVAL_MS;
			try {
				const url = `${baseUrl}/api/admin/cluster/events?after=${handle.cursor}&limit=500`;
				const data = (await getJson(url, handle.token, 15_000)) as {
					events?: ClusterEvent[];
					last_id?: number;
				};
				const events = data?.events ?? [];
				for (const ev of events) {
					try {
						this.onEvent(ev);
					} catch (err) {
						log.error(
							`failed handling peer event: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				handle.cursor = data?.last_id ?? handle.cursor;
			} catch (err) {
				const reason =
					err instanceof ClusterHTTPError ? err.message : String(err);
				log.debug(`peer ${baseUrl} poll failed: ${reason}`);
				nextBackoff = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			}
			if (handle.stopped) return;
			handle.timer = setTimeout(
				() => this.pollOnce(baseUrl, handle, nextBackoff),
				nextBackoff,
			);
			handle.timer.unref?.();
		})();
	}

	private onEvent(event: ClusterEvent): void {
		this.state.eventWriter.submit(event);
		if (
			event.kind === "control" &&
			(event.action === "upload.halt" || event.action === "upload.resume")
		) {
			applyHaltEvent(
				this.state.haltRegistry,
				event as unknown as Record<string, unknown>,
			);
		}
	}
}
