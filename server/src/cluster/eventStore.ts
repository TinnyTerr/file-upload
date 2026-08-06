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

/** This node's own events, durably, oldest first — what a peer's firehose
 * cursor walks.
 *
 * Scoped to `origin_node_id = self` on purpose: the cursor a peer sends is
 * *this node's* `origin_seq`, so mixing in events mirrored from third nodes
 * would make it meaningless. The mesh is full, so every node is polled
 * directly and nothing needs relaying.
 *
 * Reading the table rather than EventBus' 5,000-entry ring buffer is what
 * makes a restart survivable: the buffer is empty after a reboot, so a peer
 * that was behind would never see the events it missed. */
export function readOwnEvents(
	db: Db,
	nodeId: string,
	opts: { after?: number; limit?: number } = {},
): ClusterEvent[] {
	const rows = db.all<EventRow>(
		`SELECT origin_node_id, origin_seq, origin_node_name, ts, kind, action, actor, target, ip
       FROM cluster_events
      WHERE origin_node_id = $nodeId AND origin_seq > $after
      ORDER BY origin_seq ASC
      LIMIT $limit`,
		{
			$nodeId: nodeId,
			$after: opts.after ?? 0,
			$limit: opts.limit ?? 200,
		},
	);
	return rows.map((row) => ({
		id: row.origin_seq,
		node_id: row.origin_node_id,
		node_name: row.origin_node_name ?? "",
		ts: row.ts,
		kind: row.kind,
		action: row.action,
		actor: row.actor,
		target: row.target,
		ip: row.ip,
	}));
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

	/** Persist one event immediately, in the caller's transaction if there is
	 * one. This is the path locally-originated events take (wired as the
	 * EventBus persist hook in appState.ts): an event that has been published
	 * to live subscribers and pulled by a peer must already be durable, and a
	 * 250 ms drain window is a window in which a crash loses it while a peer
	 * has it. Peer-ingested events keep using `submit()` — they are already
	 * durable at their origin, so batching them is free.
	 *
	 * Best-effort: never throws, because a publish is a side effect of some
	 * other request and must not fail it. */
	write(event: ClusterEvent): void {
		const row = rowFromEvent(event);
		if (!row) return;
		try {
			this.insert(row);
		} catch (err) {
			log.error(
				`cluster event write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
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

	private insert(row: EventRow): void {
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

	private drain(): void {
		if (this.queue.length === 0) return;
		const batch = this.queue.splice(0, MAX_BATCH);
		try {
			this.db.transaction(() => {
				for (const row of batch) this.insert(row);
			});
		} catch (err) {
			log.error(
				`cluster event batch write failed (${batch.length} rows): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
