import type { Settings } from "../config.ts";

/** In-memory, per-node live event bus. No direct Python equivalent file was
 * ported (app/observability/events.py wasn't in this port's scope), but
 * app/routes/cluster.py, ws.py, event_store.py and firehose_client.py all
 * assume one exists (`event_bus.publish/subscribe/recent/ingest`), so this
 * is a from-scratch TypeScript implementation shaped to satisfy those call
 * sites faithfully.
 *
 * IMPORTANT: `id` is a monotonically increasing in-process sequence number.
 * This assumes ONE process per node (see server/src/index.ts -- a single
 * `app.listen()` call, no worker forking). If this server is ever scaled to
 * multiple worker processes, this counter must be revisited or every worker
 * will independently emit colliding `origin_seq=1, 2, 3...` sequences, which
 * is exactly the bug class that broke logins under `uvicorn --workers=4` in
 * the old Python deployment (see cluster_events' UNIQUE(origin_node_id,
 * origin_seq) constraint).
 */

export interface ClusterEvent {
	id: number;
	node_id: string;
	node_name: string;
	ts: string;
	kind: string;
	action: string;
	actor: string;
	target?: string | null;
	ip?: string | null;
	[extra: string]: unknown;
}

export type EventPredicate = (event: ClusterEvent) => boolean;

const BUFFER_CAPACITY = 5000;

export class EventBus {
	private seq = 0;
	private buffer: ClusterEvent[] = [];
	private subscribers = new Set<(event: ClusterEvent) => void>();
	private settings: Settings;
	private onPersist: ((event: ClusterEvent) => void) | null = null;

	constructor(settings: Settings) {
		this.settings = settings;
	}

	/** Wire up durable persistence (the ClusterEventWriter). Called once at
	 * startup after both this bus and the writer exist, to avoid a circular
	 * constructor dependency. */
	setPersistHook(hook: (event: ClusterEvent) => void): void {
		this.onPersist = hook;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	/** This node's current sequence watermark. Used by cluster/election.ts to
	 * fold "how far has this node itself gotten" into the applied-sequence
	 * vector compared during vote-grant, alongside peers' watermarks read from
	 * the cluster_events mirror. */
	currentSeq(): number {
		return this.seq;
	}

	/** Publish a locally-originated event: assigns this node's next sequence
	 * id, stamps identity + timestamp, buffers it, notifies live subscribers,
	 * and (if wired) durably persists it. */
	publish(fields: {
		action: string;
		actor: string;
		target?: string | null;
		ip?: string | null;
		kind?: string;
		[extra: string]: unknown;
	}): ClusterEvent {
		const event: ClusterEvent = {
			...fields,
			id: ++this.seq,
			node_id: this.settings.nodeId,
			node_name: this.settings.nodeName,
			ts: new Date().toISOString(),
			kind: fields.kind ?? "audit",
			target: fields.target ?? null,
			ip: fields.ip ?? null,
		};
		this.buffer.push(event);
		if (this.buffer.length > BUFFER_CAPACITY) this.buffer.shift();
		for (const sub of this.subscribers) sub(event);
		this.onPersist?.(event);
		return event;
	}

	/** Buffered events with id > afterId, optionally filtered. Used for both
	 * websocket replay-on-connect and the HTTP long-poll fallback. */
	recent(
		opts: { afterId?: number; limit?: number; predicate?: EventPredicate } = {},
	): ClusterEvent[] {
		const afterId = opts.afterId ?? 0;
		const predicate = opts.predicate ?? (() => true);
		const matches = this.buffer.filter((e) => e.id > afterId && predicate(e));
		const limit = opts.limit ?? matches.length;
		return matches.slice(Math.max(0, matches.length - limit));
	}

	/** Register a live listener; returns an unsubscribe function. */
	subscribe(
		predicate: EventPredicate,
		onEvent: (event: ClusterEvent) => void,
	): () => void {
		const listener = (event: ClusterEvent) => {
			if (predicate(event)) onEvent(event);
		};
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}
}
