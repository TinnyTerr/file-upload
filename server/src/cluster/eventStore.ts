import { nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import type { ClusterEvent } from "./eventBus.ts";

/** Durable, cross-node mirror of firehose events. Mirrors
 * app/cluster/event_store.py, adapted from a threaded queue+worker to a
 * setInterval-drained batch (this codebase's existing convention for
 * background work -- see server/src/jobs/scheduler.ts -- no thread/worker
 * primitives are used elsewhere).
 *
 * `cluster_events` is a denormalised, cluster-wide event log distinct from
 * the per-node hash-chained `audit_log` (see server/src/audit.ts) -- it
 * exists so any single node's table is (eventually) a complete cluster-wide
 * view that an admin UI could filter by origin server. Rows are deduplicated
 * on (origin_node_id, origin_seq) via INSERT OR IGNORE, so re-polls or
 * cross-delivery from multiple peers never double-insert. */

const log = getLogger("app.cluster.events");
const DRAIN_INTERVAL_MS = 250;
const MAX_BATCH = 500;

interface EventRow {
	origin_node_id: string;
	origin_seq: number;
	origin_node_name: string | null;
	ts: string;
	kind: string;
	action: string;
	actor: string;
	target: string | null;
	ip: string | null;
}

function rowFromEvent(event: ClusterEvent): EventRow | null {
	const origin = event.node_id;
	const seq = event.id;
	if (!origin || seq === undefined || seq === null) return null;
	return {
		origin_node_id: String(origin),
		origin_seq: Number(seq),
		origin_node_name: event.node_name ?? null,
		ts: event.ts ?? nowIso(),
		kind: event.kind || "audit",
		action: event.action || "",
		actor: event.actor || "",
		target: (event.target as string | null | undefined) ?? null,
		ip: (event.ip as string | null | undefined) ?? null,
	};
}

export class ClusterEventWriter {
	private db: Db;
	private queue: EventRow[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(db: Db) {
		this.db = db;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.drain(), DRAIN_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.drain();
	}

	/** Enqueue an event for persistence. Best-effort: never throws. */
	submit(event: ClusterEvent): void {
		const row = rowFromEvent(event);
		if (!row) return;
		if (this.queue.length >= 20000) {
			log.warning("cluster event queue full; dropping event");
			return;
		}
		this.queue.push(row);
	}

	private drain(): void {
		if (this.queue.length === 0) return;
		const batch = this.queue.splice(0, MAX_BATCH);
		try {
			this.db.transaction(() => {
				for (const row of batch) {
					this.db.run(
						`INSERT OR IGNORE INTO cluster_events
               (origin_node_id, origin_seq, origin_node_name, ts, kind, action, actor, target, ip, created_at)
             VALUES ($originNodeId, $originSeq, $originNodeName, $ts, $kind, $action, $actor, $target, $ip, $createdAt)`,
						{
							$originNodeId: row.origin_node_id,
							$originSeq: row.origin_seq,
							$originNodeName: row.origin_node_name,
							$ts: row.ts,
							$kind: row.kind,
							$action: row.action,
							$actor: row.actor,
							$target: row.target,
							$ip: row.ip,
							$createdAt: nowIso(),
						},
					);
				}
			});
		} catch (err) {
			log.error(
				`cluster event batch write failed (${batch.length} rows): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
