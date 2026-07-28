import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { diskUsageBytes, usedStorageBytes } from "../storage/accounting.ts";
import {
	adoptEpochIfHigher,
	getSelfState,
	learnMasterPointer,
	touchMasterContact,
} from "./election.ts";
import { ClusterHTTPError, postJson } from "./http.ts";

/** Mirrors app/cluster/membership.py. */

const log = getLogger("app.cluster.membership");

export interface SelfPayload {
	node_id: string;
	name: string;
	base_url: string;
	token: string;
	is_master: boolean;
	archive_enabled: boolean;
	replication_mode: string;
	disk_total_bytes: number;
	disk_free_bytes: number;
	used_bytes: number;
	/** Live election state (cluster/election.ts) -- "master" is now an
	 * elected, epoch-versioned role, not the static NODE_ROLE this field was
	 * historically read from. is_master above is kept as role === "master"
	 * for callers/UI that only care about the boolean. */
	role: string;
	epoch: number;
	current_master_id: string | null;
	current_master_url: string | null;
}

/** The identity + capacity + live election state this node advertises to
 * peers. */
export function selfPayload(state: AppState): SelfPayload {
	const usage = diskUsageBytes();
	const self = getSelfState(state.db);
	return {
		node_id: state.settings.nodeId,
		name: state.settings.nodeName,
		base_url: state.settings.nodeUrl,
		token: state.clusterToken,
		is_master: self.role === "master",
		archive_enabled: state.settings.archiveEnabled,
		replication_mode: state.settings.replicationMode,
		disk_total_bytes: usage?.total ?? 0,
		disk_free_bytes: usage?.free ?? 0,
		used_bytes: usedStorageBytes(state.db),
		role: self.role,
		epoch: self.epoch,
		current_master_id: self.current_master_id,
		current_master_url: self.current_master_url,
	};
}

interface LinkLocallyOpts {
	nodeId: string;
	name: string;
	baseUrl: string;
	token: string;
	isMaster: boolean;
	archiveEnabled?: boolean;
	replicationMode?: string;
	role?: string;
	epoch?: number;
}

function linkLocally(state: AppState, opts: LinkLocallyOpts): void {
	if (!opts.nodeId || !opts.baseUrl) return;
	const baseUrl = opts.baseUrl.replace(/\/$/, "");
	const { db } = state;
	const existing = db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $nodeId",
		{
			$nodeId: opts.nodeId,
		},
	);
	const now = nowIso();
	const role = opts.role ?? (opts.isMaster ? "master" : "follower");
	const epoch = opts.epoch ?? 0;
	if (!existing) {
		db.run(
			`INSERT INTO cluster_nodes
         (name, base_url, token, active, node_id, is_master, archive_enabled, replication_mode, role, epoch, created_at, last_seen_at)
       VALUES ($name, $baseUrl, $token, 1, $nodeId, $isMaster, $archiveEnabled, $replicationMode, $role, $epoch, $now, $now)`,
			{
				$name: opts.name || opts.nodeId,
				$baseUrl: baseUrl,
				$token: opts.token || "",
				$nodeId: opts.nodeId,
				$isMaster: opts.isMaster ? 1 : 0,
				$archiveEnabled: opts.archiveEnabled === false ? 0 : 1,
				$replicationMode: opts.replicationMode || "full",
				$role: role,
				$epoch: epoch,
				$now: now,
			},
		);
		return;
	}
	db.run(
		`UPDATE cluster_nodes SET
       name = $name, base_url = $baseUrl, token = COALESCE(NULLIF($token, ''), token),
       is_master = $isMaster, archive_enabled = $archiveEnabled, replication_mode = $replicationMode,
       role = $role, epoch = $epoch,
       active = 1, last_seen_at = $now
     WHERE node_id = $nodeId`,
		{
			$name: opts.name || existing.name,
			$baseUrl: baseUrl,
			$token: opts.token || "",
			$isMaster: opts.isMaster ? 1 : 0,
			$archiveEnabled: opts.archiveEnabled === false ? 0 : 1,
			$replicationMode: opts.replicationMode || "full",
			$role: role,
			$epoch: epoch,
			$now: now,
			$nodeId: opts.nodeId,
		},
	);
}

export interface EnrollResult {
	status: "ok" | "skipped" | "error";
	reason?: string;
	master?: string;
	rebased?: boolean;
}

/** Join the given master and rebase this node onto it, then full-mesh with
 * its peers. Returns a status describing the outcome.
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
	if (getSelfState(state.db).role === "master") {
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

	const payload = selfPayload(state);
	let result: Record<string, unknown> | null;
	try {
		result = (await postJson(
			`${masterUrl}/api/cluster/join`,
			masterToken,
			payload,
			15_000,
		)) as Record<string, unknown>;
	} catch (err) {
		const reason = err instanceof ClusterHTTPError ? err.message : String(err);
		log.warning(`failed to join master at ${masterUrl}: ${reason}`);
		return { status: "error", reason: `join failed: ${reason}` };
	}

	// The seed we dialed may not currently BE master (mid-election, or
	// demoted since MASTER_URL was configured) -- trust its reported election
	// state over the fact that we dialed it via MASTER_URL.
	const masterSelf = (result?.self ?? {}) as Partial<SelfPayload>;
	linkLocally(state, {
		nodeId: masterSelf.node_id ?? "",
		name: masterSelf.name ?? "master",
		baseUrl: masterUrl,
		token: masterToken,
		isMaster: masterSelf.role === "master",
		archiveEnabled: masterSelf.archive_enabled ?? true,
		replicationMode: masterSelf.replication_mode ?? "full",
		role: masterSelf.role ?? "follower",
		epoch: masterSelf.epoch ?? 0,
	});
	// Learn whatever epoch/master pointer the seed reports, even if the seed
	// itself isn't master -- it still knows (from its own election state) who
	// currently holds the role, or that nobody does yet (mid-election). Uses
	// learnMasterPointer (not adoptEpochIfHigher) because at bootstrap both
	// sides typically start at epoch 0 -- a strict "higher epoch" check would
	// never let a joiner learn who master is until the first real election.
	if (typeof masterSelf.epoch === "number") {
		const knownMasterId =
			masterSelf.role === "master"
				? masterSelf.node_id
				: masterSelf.current_master_id;
		const knownMasterUrl =
			masterSelf.role === "master" ? masterUrl : masterSelf.current_master_url;
		if (knownMasterId) {
			learnMasterPointer(
				state,
				masterSelf.epoch,
				knownMasterId,
				knownMasterUrl ?? "",
			);
		}
	}

	const peers = (result?.peers as Array<Record<string, unknown>>) ?? [];
	for (const peer of peers) {
		linkLocally(state, {
			nodeId: (peer.node_id as string) ?? "",
			name: (peer.name as string) ?? "",
			baseUrl: (peer.base_url as string) ?? "",
			token: (peer.token as string) ?? "",
			isMaster: !!peer.is_master,
			archiveEnabled: peer.archive_enabled !== false,
			replicationMode: (peer.replication_mode as string) ?? "full",
			role: (peer.role as string) ?? (peer.is_master ? "master" : "follower"),
			epoch: (peer.epoch as number) ?? 0,
		});
		// Register ourselves with the peer too, so the mesh is symmetric.
		if (peer.base_url && peer.token) {
			try {
				await postJson(
					`${(peer.base_url as string).replace(/\/$/, "")}/api/cluster/join`,
					peer.token as string,
					payload,
					10_000,
				);
			} catch (err) {
				log.debug(
					`could not register with peer ${peer.base_url}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	log.info(`joined cluster via master ${masterUrl}`);

	// Rebase onto the master so this node starts with the cluster's canonical
	// users/files/links/etc. (the source-of-truth snapshot).
	let rebased = false;
	try {
		const { rebaseFromMaster } = await import("./replication.ts");
		rebased = await rebaseFromMaster(state);
	} catch (err) {
		log.warning(
			`initial rebase from master failed: ${err instanceof Error ? err.message : String(err)}`,
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
	return { status: "ok", master: masterUrl, rebased };
}

/** Bootstrap this (non-master) node into the mesh from its own config. Thin
 * wrapper over `enrollWithMaster` using MASTER_URL/MASTER_TOKEN from this
 * node's environment. Intended to run in the background at startup so a
 * slow/unreachable master never blocks boot. */
export async function joinCluster(state: AppState): Promise<void> {
	if (state.settings.nodeRole === "master") return;
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

/** Ping every linked peer, refreshing its capacity stats and our liveness
 * with it. Peers that fail to respond are marked stale (active=false) rather
 * than deleted, so a transient outage doesn't tear down the mesh. Returns
 * the number of peers successfully reached. */
export async function heartbeatJob(state: AppState): Promise<number> {
	const payload = selfPayload(state);
	const { db } = state;
	const targets = db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes")
		.filter((n) => n.base_url && n.token);

	let reached = 0;
	for (const node of targets) {
		let stats: Record<string, unknown> | null = null;
		try {
			stats = (await postJson(
				`${node.base_url.replace(/\/$/, "")}/api/cluster/heartbeat`,
				node.token,
				payload,
				10_000,
			)) as Record<string, unknown>;
			reached++;
		} catch {
			stats = null;
		}
		const now = nowIso();
		if (stats === null) {
			db.run("UPDATE cluster_nodes SET active = 0 WHERE id = $id", {
				$id: node.id,
			});
		} else {
			const role =
				(stats.role as string) ?? (stats.is_master ? "master" : "follower");
			const epoch = Number(stats.epoch ?? 0);
			db.run(
				`UPDATE cluster_nodes SET
           active = 1, last_heartbeat_at = $now, last_seen_at = $now,
           disk_total_bytes = $diskTotal, disk_free_bytes = $diskFree, used_bytes = $used,
           archive_enabled = $archiveEnabled, replication_mode = $replicationMode,
           is_master = $isMaster, role = $role, epoch = $epoch
         WHERE id = $id`,
				{
					$now: now,
					$diskTotal: Number(stats.disk_total_bytes ?? 0),
					$diskFree: Number(stats.disk_free_bytes ?? 0),
					$used: Number(stats.used_bytes ?? 0),
					$archiveEnabled: stats.archive_enabled === false ? 0 : 1,
					$replicationMode:
						(stats.replication_mode as string) ?? node.replication_mode,
					$isMaster: role === "master" ? 1 : 0,
					$role: role,
					$epoch: epoch,
					$id: node.id,
				},
			);
			// A higher epoch reported by ANY peer means we're behind; adopt it
			// (self-demoting if we mistakenly still think we're master). At epoch
			// parity, still learn the master pointer this peer reports -- e.g. we
			// rejoined at the current epoch but haven't heard who holds it yet.
			const reportedMasterId =
				(stats.role === "master"
					? node.node_id
					: (stats.current_master_id as string | null)) ?? null;
			const reportedMasterUrl =
				(stats.role === "master"
					? node.base_url
					: (stats.current_master_url as string | null)) ?? "";
			if (Number.isFinite(epoch) && reportedMasterId) {
				learnMasterPointer(state, epoch, reportedMasterId, reportedMasterUrl);
			} else if (Number.isFinite(epoch)) {
				adoptEpochIfHigher(state, epoch, {});
			}
			// Confirmed contact with a live node -- if it's the master we
			// currently believe in, reset our liveness timer so
			// checkMasterLivenessJob doesn't call an unnecessary election.
			if (node.node_id && node.node_id === getSelfState(db).current_master_id) {
				touchMasterContact(db);
			}
		}
	}
	return reached;
}

/** Insert-or-update a linked-peer row keyed by its stable node_id. Used by
 * the join handshake and heartbeats so re-joining a node never duplicates
 * it. Exported for routes/cluster.ts's /join and /heartbeat handlers. */
export function upsertPeer(
	state: AppState,
	opts: {
		nodeId: string;
		name: string;
		baseUrl: string;
		token: string;
		isMaster: boolean;
		archiveEnabled: boolean;
		replicationMode: string;
		diskTotalBytes?: number;
		diskFreeBytes?: number;
		usedBytes?: number;
		role?: string;
		epoch?: number;
	},
): ClusterNodeRow {
	const { db } = state;
	const baseUrl = opts.baseUrl.trim().replace(/\/$/, "");
	const existing = db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $nodeId",
		{
			$nodeId: opts.nodeId,
		},
	);
	const now = nowIso();
	const role = opts.role ?? (opts.isMaster ? "master" : "follower");
	const epoch = opts.epoch ?? 0;
	if (!existing) {
		db.run(
			`INSERT INTO cluster_nodes
         (name, base_url, token, active, node_id, is_master, archive_enabled, replication_mode,
          disk_total_bytes, disk_free_bytes, used_bytes, role, epoch, created_at, last_seen_at, last_heartbeat_at)
       VALUES ($name, $baseUrl, $token, 1, $nodeId, $isMaster, $archiveEnabled, $replicationMode,
               $diskTotal, $diskFree, $used, $role, $epoch, $now, $now, $now)`,
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
				$epoch: epoch,
				$now: now,
			},
		);
	} else {
		db.run(
			`UPDATE cluster_nodes SET
         name = $name, base_url = $baseUrl, token = COALESCE(NULLIF($token, ''), token),
         is_master = $isMaster, archive_enabled = $archiveEnabled, replication_mode = $replicationMode,
         disk_total_bytes = $diskTotal, disk_free_bytes = $diskFree, used_bytes = $used,
         role = $role, epoch = $epoch,
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
				$epoch: epoch,
				$now: now,
				$nodeId: opts.nodeId,
			},
		);
	}
	// A peer announcing itself with a higher epoch than ours means we're
	// behind (e.g. we were offline for an election) -- adopt it here too, not
	// just from heartbeat responses, since /join and /heartbeat requests also
	// carry the sender's live epoch.
	if (Number.isFinite(epoch)) {
		adoptEpochIfHigher(state, epoch, {});
	}
	return db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $nodeId",
		{ $nodeId: opts.nodeId },
	)!;
}
