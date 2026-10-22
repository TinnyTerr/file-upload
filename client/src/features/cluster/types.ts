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

/** Outcome of the master commanding a freshly-linked node to enroll. */
export interface EnrollResult {
	status: "ok" | "skipped" | "error";
	reason?: string;
	master?: string;
	rebased?: boolean;
}

export interface LinkedClusterNode extends ClusterNode {
	/** Present when this server is a master that pushed an enroll command on link. */
	enroll?: EnrollResult;
}

export interface ClusterHalt {
	scope: string;
	until: number;
}

export interface ClusterSelf {
	node_id: string;
	name: string;
	role: string;
	node_url: string;
	is_master: boolean;
	archive_enabled: boolean;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	halts: ClusterHalt[];
}

// ── live activity (mirrors server/src/cluster/activity.ts) ──────────────

export type ActivityComponent =
	| "db"
	| "disk"
	| "events"
	| "peers"
	| "qbittorrent"
	| "realdebrid";

export type SpanKind = "job" | "out" | "in";

export interface ActivitySpan {
	id: number;
	kind: SpanKind;
	name: string;
	touches: ActivityComponent[];
	peer?: string;
	cause?: string;
	startedAt: number;
}

export interface ActivityJob {
	id: string;
	intervalMs: number;
	touches: ActivityComponent[];
	running: boolean;
	lastStartAt: number | null;
	lastMs: number | null;
	lastOk: boolean | null;
	lastError: string | null;
	nextDueAt: number;
	skipped: number;
}

export type ActivityMessage =
	| { type: "snapshot"; now: number; jobs: ActivityJob[]; open: ActivitySpan[] }
	| { type: "start"; span: ActivitySpan }
	| {
			type: "end";
			id: number;
			ok: boolean;
			ms: number;
			detail?: string;
			at: number;
	  }
	| { type: "skipped"; job: string; at: number };

export interface FinishedSpan extends ActivitySpan {
	endedAt: number;
	ms: number;
	ok: boolean;
	detail?: string;
}
