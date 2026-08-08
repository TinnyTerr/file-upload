/** Tier 0 (the quota + write-ordering authority), tier 1 (a region's relay and
 * cache) and tier 2. Computed from the tiering snapshot, never self-asserted. */
export type NodeRole = "master" | "leader" | "follower";

export interface ClusterNode {
	id: number;
	/** Stable cluster identity of the remote node (null until it has joined). */
	node_id: string | null;
	name: string;
	base_url: string;
	/** Masked form of the remote token, e.g. ••••a1b2. The full token is never returned. */
	token_preview: string;
	active: boolean;
	is_master: boolean;
	role: NodeRole;
	region: string | null;
	/** `configured` when an operator (or NODE_REGION) set it, which always wins
	 * over the RTT clustering that produces `inferred`. */
	region_source: string;
	/** Median heartbeat round-trip, in ms. Null until enough heartbeats land. */
	rtt_ms: number | null;
	/** Operator switches: removed from leader candidacy, and pinned as master. */
	ineligible: boolean;
	pinned_master: boolean;
	archive_enabled: boolean;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	created_at: string | null;
	last_seen_at: string | null;
	last_heartbeat_at: string | null;
}

export interface NewClusterNode {
	name: string;
	base_url: string;
	token: string;
}

export interface ClusterNodeUpdate {
	region?: string | null;
	ineligible?: boolean;
	pinned_master?: boolean;
}

/** Outcome of the master commanding a freshly-linked node to enroll. */
export interface EnrollResult {
	status: "ok" | "skipped" | "error";
	reason?: string;
	master?: string;
	/** Change-log entries the node applied in its catch-up pull. */
	synced?: number;
}

export interface LinkedClusterNode extends ClusterNode {
	/** Present when this server is a master that pushed an enroll command on link. */
	enroll?: EnrollResult;
}

/** One node in the replication graph, as the server this page is talking to
 * sees it. Roles and edges are computed there, from the same `upstreamOf()` the
 * pull job follows — the client only lays them out. */
export interface TopologyNode {
	node_id: string;
	name: string;
	base_url: string;
	/** Null when the node is not in the current generation's snapshot — untiered,
	 * with no upstream, replicating with nobody. */
	role: NodeRole | null;
	region: string | null;
	in_generation: boolean;
	/** The reporting node's own heartbeat observation. */
	reachable: boolean;
	eligible: boolean | null;
	pinned: boolean;
	is_self: boolean;
	/** Who this node pulls its change log down from; null on the master. */
	upstream: string | null;
	/** The edge is the fallback to the master, taken because the region leader is
	 * unreachable — not the planned one. */
	fell_back: boolean;
	rtt_ms: number | null;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	last_heartbeat_at: string | null;
}

export interface ClusterTopology {
	generation: number;
	computed_at: string | null;
	reason: string | null;
	master_node_id: string | null;
	self_node_id: string;
	nodes: TopologyNode[];
}

/** One arbitrated edit that lost (§5.8). Recorded on the master — the only
 * node that arbitrates — so a panel on any other node reads through to it. */
export interface ReplicationConflict {
	id: number;
	table_name: string;
	row_uid: string;
	/** `upsert` | `delete`. A losing delete has no payload to re-apply. */
	losing_op: string;
	/** JSON of the losing edit's replicated columns, or `"null"` for a delete. */
	losing_payload: string;
	losing_ts: string;
	winning_master_seq: number;
	winning_ts: string;
	/** Who wrote the edit that lost. */
	origin_node: string;
	/** Who wrote the one that stands. */
	winner_node: string;
	origin_seq: number | null;
	detected_at: string;
	dismissed_at: string | null;
}

export interface ConflictsResponse {
	conflicts: ReplicationConflict[];
	/** Undismissed count, for the tab badge. */
	open: number;
	/** The node that arbitrated them — the master, whichever node was asked. */
	node_id: string;
}

export interface ClusterHalt {
	scope: string;
	until: number;
}

/** How close the master is to re-tiering itself. Master-only — nobody else
 * counts drift, because nobody else may act on it. */
export interface DriftReport {
	changes: number;
	threshold: number;
	/** Changed, but still inside the 5-minute hold-down. A restart is not drift. */
	pending: number;
}

/** Master-reachability phase (§5.5). `grace` is a master restart being ridden
 * out — requests are held, not failed. `degraded` means the grace window has
 * expired and only a human can end it. */
export type MasterPhase = "ok" | "grace" | "degraded";

export interface MasterStatus {
	phase: MasterPhase;
	silent_ms: number;
	grace_remaining_ms: number;
	master_node_id: string | null;
	/** Requests currently parked waiting for the master to return. */
	held: number;
}

export interface ClusterSelf {
	node_id: string;
	name: string;
	role: NodeRole;
	node_url: string;
	is_master: boolean;
	region: string | null;
	/** Monotonic, minted by the master alone. 0 on a node that has never been
	 * tiered — which is a node with no upstream, replicating with nobody. */
	tiering_generation: number;
	master_node_id: string | null;
	master_node_url: string | null;
	drift: DriftReport | null;
	master_status: MasterStatus;
	/** Writes admitted but not yet written, master-side. Null off the master. */
	outstanding_reservations: number | null;
	archive_enabled: boolean;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	halts: ClusterHalt[];
}
