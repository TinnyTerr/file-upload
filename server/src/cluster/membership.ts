import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { diskUsageBytes, usedStorageBytes } from "../storage/accounting.ts";
import { claimPlaceholderNode, performExchange } from "./credentials.ts";
import { ClusterHTTPError, postJson } from "./http.ts";
import {
	adoptTiering,
	currentTiering,
	isMaster,
	roleOf,
	type Tiering,
} from "./tiering.ts";

/** Mirrors app/cluster/membership.py. */

const log = getLogger("app.cluster.membership");

export interface SelfPayload {
	node_id: string;
	name: string;
	base_url: string;
	/** This node's shared cluster token. A bootstrap value only: a peer stores
	 * it so a half-migrated mesh can call back before the pair credential exists
	 * (§5.13), and `upsertPeer` refuses to write it over one that does. */
	token: string;
	is_master: boolean;
	archive_enabled: boolean;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	/** Derived from the tiering generation below, not asserted: a receiving node
	 * recomputes it from `tiering` rather than believing this field, which is
	 * what closes S4. It is here for logs and for the admin UI. */
	role: string;
	/** The highest tiering generation this node holds, whole. Small enough to
	 * ride on every handshake (2-10 nodes, D-9), which means membership gossip
	 * needs no separate protocol -- a peer either learns nothing new or adopts
	 * a newer generation in the same round-trip it was already making. */
	tiering: Tiering | null;
}

/** The identity + capacity + tiering generation this node advertises to
 * peers. */
export function selfPayload(state: AppState): SelfPayload {
	const usage = diskUsageBytes();
	const tiering = currentTiering(state.db);
	return {
		node_id: state.settings.nodeId,
		name: state.settings.nodeName,
		base_url: state.settings.nodeUrl,
		token: state.clusterToken,
		is_master: isMaster(state),
		archive_enabled: state.settings.archiveEnabled,
		replication_mode: state.settings.replicationMode,
		disk_total_bytes: usage?.total ?? 0,
		disk_free_bytes: usage?.free ?? 0,
		used_bytes: usedStorageBytes(state.db),
		role: tiering ? roleOf(tiering, state.settings.nodeId) : "follower",
		tiering,
	};
}

/** The role a peer gets in our `cluster_nodes` row: whatever the tiering
 * generation says, or `follower` until one names it. Never what the peer
 * claimed -- that field was S4. */
function derivedRole(state: AppState, nodeId: string): string {
	const tiering = currentTiering(state.db);
	return tiering ? roleOf(tiering, nodeId) : "follower";
}

/** The pair credential we already hold for whoever answers at `baseUrl`, or
 * null if we are still on a bootstrap token there. Keyed by URL because at
 * enrolment time that is all we know about the far side — the exchange is what
 * tells us its node id. */
function existingCredentialFor(
	state: AppState,
	baseUrl: string,
): string | null {
	const row = state.db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE base_url = $url AND credential_at IS NOT NULL",
		{ $url: baseUrl.replace(/\/$/, "") },
	);
	return row?.token || null;
}

interface LinkLocallyOpts {
	nodeId: string;
	name: string;
	baseUrl: string;
	token: string;
	archiveEnabled?: boolean;
	replicationMode?: string;
}

function linkLocally(state: AppState, opts: LinkLocallyOpts): void {
	if (!opts.nodeId || !opts.baseUrl) return;
	const baseUrl = opts.baseUrl.replace(/\/$/, "");
	const { db } = state;
	claimPlaceholderNode(db, opts.nodeId, baseUrl);
	const existing = db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $nodeId",
		{
			$nodeId: opts.nodeId,
		},
	);
	const now = nowIso();
	const role = derivedRole(state, opts.nodeId);
	if (!existing) {
		db.run(
			`INSERT INTO cluster_nodes
         (name, base_url, token, active, node_id, is_master, archive_enabled, replication_mode, role, created_at, last_seen_at)
       VALUES ($name, $baseUrl, $token, 1, $nodeId, $isMaster, $archiveEnabled, $replicationMode, $role, $now, $now)`,
			{
				$name: opts.name || opts.nodeId,
				$baseUrl: baseUrl,
				$token: opts.token || "",
				$nodeId: opts.nodeId,
				$isMaster: role === "master" ? 1 : 0,
				$archiveEnabled: opts.archiveEnabled === false ? 0 : 1,
				$replicationMode: opts.replicationMode || "full",
				$role: role,
				$now: now,
			},
		);
		return;
	}
	db.run(
		`UPDATE cluster_nodes SET
       name = $name, base_url = $baseUrl,
       token = CASE WHEN credential_at IS NOT NULL THEN token
                    ELSE COALESCE(NULLIF($token, ''), token) END,
       is_master = $isMaster, archive_enabled = $archiveEnabled, replication_mode = $replicationMode,
       role = $role,
       active = 1, last_seen_at = $now
     WHERE node_id = $nodeId`,
		{
			$name: opts.name || existing.name,
			$baseUrl: baseUrl,
			$token: opts.token || "",
			$isMaster: role === "master" ? 1 : 0,
			$archiveEnabled: opts.archiveEnabled === false ? 0 : 1,
			$replicationMode: opts.replicationMode || "full",
			$role: role,
			$now: now,
			$nodeId: opts.nodeId,
		},
	);
}

export interface EnrollResult {
	status: "ok" | "skipped" | "error";
	reason?: string;
	master?: string;
	/** Change-log entries applied by the catch-up pull the join kicks off. */
	synced?: number;
}

/** Join the given master, full-mesh with its peers, then pull its change log.
 * Returns a status describing the outcome.
 *
 * Shared by two callers that supply the master coordinates differently:
 * config-driven auto-join (`joinCluster`) reads them from this node's env;
 * master-initiated enrollment (`POST /cluster/enroll`) is handed them by the
 * master that is commanding this node to enroll.
 *
 * Safe to run repeatedly -- every registration is an idempotent upsert keyed
 * by node_id, and the rebase is an overwrite of locally-diverged rows. */
export async function enrollWithMaster(
	state: AppState,
	masterUrlArg: string,
	masterToken: string,
): Promise<EnrollResult> {
	if (isMaster(state)) {
		return { status: "skipped", reason: "this node is currently master" };
	}
	const masterUrl = (masterUrlArg || "").replace(/\/$/, "");
	if (!masterUrl || !masterToken) {
		return { status: "error", reason: "missing master url/token" };
	}
	if (!state.settings.nodeUrl) {
		log.warning("node has no NODE_URL to advertise; not joining a cluster");
		return { status: "error", reason: "node has no NODE_URL configured" };
	}

	// Establish a pair credential with the master before joining, unless we
	// already hold one (§5.13). `masterToken` is the bootstrap: an enrolment
	// token, or the shared cluster token while the far side still honours it.
	// Everything after this point is authenticated with a secret shared with
	// that node and nobody else — including the re-join on every restart, which
	// is why a one-use enrolment token in MASTER_TOKEN works exactly once and
	// then is never needed again.
	let auth = existingCredentialFor(state, masterUrl);
	if (!auth) {
		try {
			await performExchange(state, { baseUrl: masterUrl, auth: masterToken });
			auth = existingCredentialFor(state, masterUrl) ?? masterToken;
		} catch (err) {
			const reason =
				err instanceof ClusterHTTPError ? err.message : String(err);
			log.warning(
				`failed to establish a credential with the master at ${masterUrl}: ${reason}`,
			);
			return {
				status: "error",
				reason: `credential exchange failed: ${reason}`,
			};
		}
	}

	const payload = selfPayload(state);
	let result: Record<string, unknown> | null;
	try {
		result = (await postJson(
			`${masterUrl}/api/cluster/join`,
			auth,
			payload,
			15_000,
		)) as Record<string, unknown>;
	} catch (err) {
		const reason = err instanceof ClusterHTTPError ? err.message : String(err);
		log.warning(`failed to join master at ${masterUrl}: ${reason}`);
		return { status: "error", reason: `join failed: ${reason}` };
	}

	const masterSelf = (result?.self ?? {}) as Partial<SelfPayload>;
	// Joining a cluster means taking its answer, whatever this node had decided
	// on its own beforehand -- a standalone node that bootstrapped itself as
	// master at generation 1 must not keep believing that after enrolling
	// somewhere. Hence `force`: this is the one adoption that is not
	// highest-generation-wins.
	adoptTiering(state, masterSelf.tiering, { force: true });
	// Linked *after* the tiering lands, so the peer row's derived role is right
	// the first time rather than being corrected on the next heartbeat. The
	// token is left alone: the exchange above already wrote a pair credential
	// there, and handing `masterToken` back would overwrite it with a bootstrap
	// value that may be single-use.
	linkLocally(state, {
		nodeId: masterSelf.node_id ?? "",
		name: masterSelf.name ?? "master",
		baseUrl: masterUrl,
		token: "",
		archiveEnabled: masterSelf.archive_enabled ?? true,
		replicationMode: masterSelf.replication_mode ?? "full",
	});

	// The rest of the mesh. What the master hands over is a one-use
	// *introduction* per peer, not that peer's standing credential — handing the
	// latter to whoever held the shared token was S1. An introduction only buys
	// one exchange, and it is scoped to this node's id.
	const peers = (result?.peers as Array<Record<string, unknown>>) ?? [];
	for (const peer of peers) {
		const peerUrl = ((peer.base_url as string) ?? "").replace(/\/$/, "");
		const peerNodeId = (peer.node_id as string) ?? "";
		if (!peerUrl || !peerNodeId) continue;
		linkLocally(state, {
			nodeId: peerNodeId,
			name: (peer.name as string) ?? "",
			baseUrl: peerUrl,
			token: "",
			archiveEnabled: peer.archive_enabled !== false,
			replicationMode: (peer.replication_mode as string) ?? "full",
		});
		const intro = (peer.enrollment_token as string) ?? "";
		const peerAuth = existingCredentialFor(state, peerUrl) ?? intro;
		if (!peerAuth) continue;
		try {
			if (!existingCredentialFor(state, peerUrl)) {
				await performExchange(state, {
					baseUrl: peerUrl,
					auth: intro,
					expectNodeId: peerNodeId,
				});
			}
			// Register ourselves with the peer too, so the mesh is symmetric.
			await postJson(
				`${peerUrl}/api/cluster/join`,
				existingCredentialFor(state, peerUrl) ?? peerAuth,
				payload,
				10_000,
			);
		} catch (err) {
			// The credential maintenance job retries this on both sides, so an
			// unreachable peer costs the mesh an edge for a few minutes.
			log.debug(
				`could not register with peer ${peerUrl}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	log.info(`joined cluster via master ${masterUrl}`);

	// Pull the master's change log immediately rather than waiting for the
	// first scheduled tick, so a freshly joined node is usable in seconds.
	//
	// There is no snapshot step here any more, and that is the point: the
	// master seeded its log with an entry per existing row (changelog.ts::
	// seedChangeLog), so "catch up from nothing" and "keep up from now on" are
	// the same code path reading from cursor 0. The full-table rebase this
	// replaced could only overwrite local state wholesale and had no way to
	// express a delete.
	let synced = 0;
	try {
		const { replicationPullJob } = await import("./replication.ts");
		for (const outcome of await replicationPullJob(state)) {
			synced += outcome.applied;
		}
	} catch (err) {
		log.warning(
			`initial change-log pull from master failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		recordAudit(state.db, {
			actor: "system",
			action: "cluster.enrolled",
			target: masterUrl,
		});
	} catch {
		// best-effort -- an audit-mirror failure must never fail the enrollment
	}
	return { status: "ok", master: masterUrl, synced };
}

/** Bootstrap this (non-master) node into the mesh from its own config. Thin
 * wrapper over `enrollWithMaster` using MASTER_URL/MASTER_TOKEN from this
 * node's environment. Intended to run in the background at startup so a
 * slow/unreachable master never blocks boot. */
export async function joinCluster(state: AppState): Promise<void> {
	if (isMaster(state)) return;
	if (!state.settings.masterUrl || !state.settings.masterToken) {
		log.warning("node has no MASTER_URL/MASTER_TOKEN; not joining a cluster");
		return;
	}
	await enrollWithMaster(
		state,
		state.settings.masterUrl,
		state.settings.masterToken,
	);
}

/** How many round-trip samples per peer feed the median written to
 * `cluster_nodes.rtt_ms`. Odd, so the median is a real sample; short, so a peer
 * whose latency genuinely changed is reflected within a few minutes. */
const RTT_SAMPLES = 5;

/** Per-peer round-trip samples. Bounded by cluster size and pruned against the
 * live target list on every run -- an unlinked node's samples do not outlive it
 * (see "don't add unbounded in-memory maps without a sweep"). */
const rttSamples = new Map<string, number[]>();

function recordRtt(nodeId: string, ms: number): number {
	const samples = rttSamples.get(nodeId) ?? [];
	samples.push(ms);
	while (samples.length > RTT_SAMPLES) samples.shift();
	rttSamples.set(nodeId, samples);
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** Ping every linked peer, refreshing its capacity stats and our liveness
 * with it. Peers that fail to respond are marked stale (active=false) rather
 * than deleted, so a transient outage doesn't tear down the mesh. Returns
 * the number of peers successfully reached.
 *
 * This is also where RTT is measured (§5.2). The round-trip was already being
 * made; recording how long it took is what makes region inference free rather
 * than needing a synthetic probe. */
export async function heartbeatJob(state: AppState): Promise<number> {
	const payload = selfPayload(state);
	const { db } = state;
	const targets = db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes")
		.filter((n) => n.base_url && n.token);

	const live = new Set(targets.map((n) => n.node_id).filter(Boolean));
	for (const nodeId of [...rttSamples.keys()]) {
		if (!live.has(nodeId)) rttSamples.delete(nodeId);
	}

	// A follower that sits under a region leader never pulls from the master
	// directly, so the replication job cannot tell it whether the master is
	// alive. The heartbeat reaches every linked peer, so it can -- and §5.5's
	// grace timer needs one signal or the other on every node.
	const tiering = currentTiering(db);
	const masterId =
		tiering && tiering.master_node_id !== state.settings.nodeId
			? tiering.master_node_id
			: null;

	let reached = 0;
	for (const node of targets) {
		let stats: SelfPayload | null = null;
		const startedAt = Date.now();
		try {
			stats = (await postJson(
				`${node.base_url.replace(/\/$/, "")}/api/cluster/heartbeat`,
				node.token,
				payload,
				10_000,
			)) as SelfPayload;
			reached++;
		} catch {
			stats = null;
		}
		if (node.node_id && node.node_id === masterId) {
			if (stats === null) state.masterReachability.noteFailure();
			else state.masterReachability.confirmContact();
		}
		const now = nowIso();
		if (stats === null) {
			db.run("UPDATE cluster_nodes SET active = 0 WHERE id = $id", {
				$id: node.id,
			});
			continue;
		}
		const rttMs = node.node_id
			? recordRtt(node.node_id, Date.now() - startedAt)
			: null;
		db.run(
			`UPDATE cluster_nodes SET
         active = 1, last_heartbeat_at = $now, last_seen_at = $now,
         disk_total_bytes = $diskTotal, disk_free_bytes = $diskFree, used_bytes = $used,
         archive_enabled = $archiveEnabled, replication_mode = $replicationMode,
         rtt_ms = COALESCE($rtt, rtt_ms)
       WHERE id = $id`,
			{
				$now: now,
				$diskTotal: Number(stats.disk_total_bytes ?? 0),
				$diskFree: Number(stats.disk_free_bytes ?? 0),
				$used: Number(stats.used_bytes ?? 0),
				$archiveEnabled: stats.archive_enabled === false ? 0 : 1,
				$replicationMode: stats.replication_mode ?? node.replication_mode,
				$rtt: rttMs,
				$id: node.id,
			},
		);
		// Role, is_master and region are NOT read off the response: they are
		// mirrored from the tiering generation below, which is the only thing
		// entitled to say what a node is.
		adoptTiering(state, stats.tiering);
	}
	return reached;
}

/** Insert-or-update a linked-peer row keyed by its stable node_id. Used by
 * the join handshake and heartbeats so re-joining a node never duplicates
 * it. Exported for routes/cluster.ts's /join and /heartbeat handlers.
 *
 * The sender's own claim about its role is deliberately not accepted: `role`
 * and `is_master` are written from this node's tiering generation, and a peer
 * that has none yet is a `follower` until one names it. An unauthenticated,
 * self-asserted role field was S4. */
export function upsertPeer(
	state: AppState,
	opts: {
		nodeId: string;
		name: string;
		baseUrl: string;
		token: string;
		archiveEnabled: boolean;
		replicationMode: string;
		diskTotalBytes?: number;
		diskFreeBytes?: number;
		usedBytes?: number;
		/** The sender's tiering generation, adopted if it is newer than ours. */
		tiering?: Tiering | null;
	},
): ClusterNodeRow {
	const { db } = state;
	const baseUrl = opts.baseUrl.trim().replace(/\/$/, "");
	// Before the row is written, so a generation naming this very peer takes
	// effect on the role we are about to derive for it.
	adoptTiering(state, opts.tiering);
	// …and before the lookup, so an operator's placeholder row becomes this
	// peer's row rather than a second one for the same server.
	claimPlaceholderNode(db, opts.nodeId, baseUrl);
	const existing = db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $nodeId",
		{
			$nodeId: opts.nodeId,
		},
	);
	const now = nowIso();
	const role = derivedRole(state, opts.nodeId);
	if (!existing) {
		db.run(
			`INSERT INTO cluster_nodes
         (name, base_url, token, active, node_id, is_master, archive_enabled, replication_mode,
          disk_total_bytes, disk_free_bytes, used_bytes, role, created_at, last_seen_at, last_heartbeat_at)
       VALUES ($name, $baseUrl, $token, 1, $nodeId, $isMaster, $archiveEnabled, $replicationMode,
               $diskTotal, $diskFree, $used, $role, $now, $now, $now)`,
			{
				$name: opts.name || opts.nodeId,
				$baseUrl: baseUrl,
				$token: opts.token || "",
				$nodeId: opts.nodeId,
				$isMaster: role === "master" ? 1 : 0,
				$archiveEnabled: opts.archiveEnabled ? 1 : 0,
				$replicationMode: opts.replicationMode || "full",
				$diskTotal: opts.diskTotalBytes ?? 0,
				$diskFree: opts.diskFreeBytes ?? 0,
				$used: opts.usedBytes ?? 0,
				$role: role,
				$now: now,
			},
		);
	} else {
		db.run(
			`UPDATE cluster_nodes SET
         name = $name, base_url = $baseUrl,
         -- Never over a pair credential (§5.13): the payload's token field is
         -- the sender's shared cluster token, a bootstrap value that is only of
         -- any use before an exchange has happened.
         token = CASE WHEN credential_at IS NOT NULL THEN token
                      ELSE COALESCE(NULLIF($token, ''), token) END,
         is_master = $isMaster, archive_enabled = $archiveEnabled, replication_mode = $replicationMode,
         disk_total_bytes = $diskTotal, disk_free_bytes = $diskFree, used_bytes = $used,
         role = $role,
         active = 1, last_seen_at = $now, last_heartbeat_at = $now
       WHERE node_id = $nodeId`,
			{
				$name: opts.name || existing.name,
				$baseUrl: baseUrl,
				$token: opts.token || "",
				$isMaster: role === "master" ? 1 : 0,
				$archiveEnabled: opts.archiveEnabled ? 1 : 0,
				$replicationMode: opts.replicationMode || "full",
				$diskTotal: opts.diskTotalBytes ?? 0,
				$diskFree: opts.diskFreeBytes ?? 0,
				$used: opts.usedBytes ?? 0,
				$role: role,
				$now: now,
				$nodeId: opts.nodeId,
			},
		);
	}
	return db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $nodeId",
		{ $nodeId: opts.nodeId },
	)!;
}
