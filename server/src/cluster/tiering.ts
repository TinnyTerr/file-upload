import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import type { Settings } from "../config.ts";
import type {
	ClusterDriftRow,
	ClusterNodeRow,
	ClusterTieringRow,
} from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { diskUsageBytes } from "../storage/accounting.ts";

/**
 * Tiering: leadership as a pure function of a membership snapshot (§5.3–5.4).
 *
 * This replaces `election.ts` outright. Nothing votes, nothing has an epoch,
 * and no node asserts a role over the wire. The master computes a snapshot of
 * the cluster, runs a deterministic function over it, and mints a numbered
 * *generation*; every other node adopts the highest generation it has seen and
 * derives its own role from it. Two nodes fed the same snapshot compute the
 * same answer, so the thing that needs agreement stops being "who leads" and
 * becomes "what the membership snapshot is" — which is a single writer's
 * output rather than a quorum's.
 *
 * That deletes B6/B7/B8 (epoch poisoning, quorum over a disagreed set, the
 * terminal `candidate` state), D3/D5, and S4 (an unauthenticated self-asserted
 * role field) with them.
 *
 * **Only the master mints.** During a master outage no generation can be
 * minted, so leadership simply does not move — which is D-2's "no automatic
 * failover" falling out of the design rather than being enforced by it. A
 * cluster whose master is gone degrades (§5.5) and waits for a human.
 *
 * The trust boundary is unchanged and worth naming: a tiering record is
 * accepted from any peer presenting the cluster token, exactly as a change-log
 * batch is. That token is already a root credential — a peer holding it can
 * write any row it likes through `/changes` — so gossiping generations across
 * it adds no authority it did not have. Per-node credentials are Phase 9.
 */

const log = getLogger("app.cluster.tiering");

export type NodeRole = "master" | "leader" | "follower";

export type TierReason = "bootstrap" | "manual" | "drift" | "promotion";

/** The region every node lands in until either `NODE_REGION` is configured or
 * RTT inference has enough measurements to split them apart. D-9: one region
 * today, the tier designed in but dormant. */
export const DEFAULT_REGION = "r1";

/** Default RTT spread within which two unconfigured nodes are taken to be in
 * the same region (§5.2), overridable with `CLUSTER_REGION_RTT_MS`. */
export const DEFAULT_REGION_RTT_MS = 30;

/** How long a node must HOLD a new status before it counts toward the drift
 * threshold (§5.4). A restart is not drift, and this is the window that says
 * so. Same 5 minutes as the master grace in §5.5. */
export const HOLD_DOWN_MS = 5 * 60 * 1000;

/** One member of the snapshot the leader function runs over. */
export interface TieringMember {
	node_id: string;
	name: string;
	base_url: string;
	region: string;
	region_source: "configured" | "inferred";
	/** D-4: total capacity is the leader score outright. */
	disk_total_bytes: number;
	rtt_ms: number | null;
	replication_mode: string;
	/** Within the liveness window. */
	active: boolean;
	/** Eligible for leadership at all: live, not operator-flagged, not a
	 * cache-mode node (which holds a bounded subset of the bytes). */
	eligible: boolean;
	/** Operator override — this node is master regardless of the computation. */
	pinned: boolean;
}

export interface RegionPlan {
	/** The region's tier-1 node, or null for a region whose only member is the
	 * master (§5.1 — there is nothing to relay to, and it needs no leader). */
	leader: string | null;
	members: string[];
}

export interface Tiering {
	generation: number;
	computed_at: string;
	reason: TierReason;
	master_node_id: string;
	snapshot: TieringMember[];
	regions: Record<string, RegionPlan>;
}

// ── the pure function ───────────────────────────────────────────────────────

/** `(disk_total_bytes DESC, node_id ASC)`. The tie-break is what makes the
 * function total: every node computes the same winner from the same input, so
 * agreement on the snapshot is agreement on the leader. */
function best(candidates: TieringMember[]): TieringMember | null {
	let winner: TieringMember | null = null;
	for (const m of candidates) {
		if (
			!winner ||
			m.disk_total_bytes > winner.disk_total_bytes ||
			(m.disk_total_bytes === winner.disk_total_bytes &&
				m.node_id < winner.node_id)
		) {
			winner = m;
		}
	}
	return winner;
}

export interface Plan {
	masterNodeId: string;
	regions: Record<string, RegionPlan>;
}

/**
 * §5.3, verbatim:
 *
 *     master          = argmax over all eligible nodes of (capacity, node_id ASC)
 *     regionLeader(r) = argmax over eligible nodes in r MINUS the master
 *
 * The master is computed first, over the whole cluster, and struck out of every
 * region's candidate set (D-15) — so tier 0 and tier 1 are never the same box,
 * the master's own region is led by its second-largest node, and a region
 * holding only the master has no leader.
 *
 * `incumbent` is the current master, used only when the computation has nobody
 * to pick: an all-ineligible snapshot must not silently vacate leadership,
 * because vacating it is exactly what no node is allowed to decide.
 */
export function computePlan(members: TieringMember[], incumbent: string): Plan {
	const pinned = members.find((m) => m.pinned);
	const masterNodeId =
		pinned?.node_id ??
		best(members.filter((m) => m.eligible))?.node_id ??
		incumbent;

	const regions: Record<string, RegionPlan> = {};
	for (const m of members) {
		if (!regions[m.region]) regions[m.region] = { leader: null, members: [] };
		regions[m.region]!.members.push(m.node_id);
	}
	for (const [region, plan] of Object.entries(regions)) {
		plan.members.sort();
		const candidates = members.filter(
			(m) => m.region === region && m.eligible && m.node_id !== masterNodeId,
		);
		plan.leader = best(candidates)?.node_id ?? null;
	}
	return { masterNodeId, regions };
}

/**
 * Assign a region to every member that has not been given one (§5.2).
 *
 * Configured regions always win and are left alone; only unconfigured nodes are
 * clustered, by single-link grouping over the round-trip time *this* node
 * measured to each of them, which `heartbeatJob` already samples. Groups are
 * named `r1`, `r2`, … in ascending RTT, so the group containing the computing
 * node (RTT 0 to itself) is always `r1` — with no measurements at all, which is
 * the single-region case D-9 describes, every node lands in `r1` and the region
 * tier is dormant exactly as intended.
 *
 * Inference runs only here, at a re-tiering event, never continuously —
 * otherwise region membership flaps with network weather and everything
 * downstream flaps with it.
 */
export function inferRegions(
	members: TieringMember[],
	thresholdMs: number,
): TieringMember[] {
	const configured = members.filter((m) => m.region_source === "configured");
	const rest = members
		.filter((m) => m.region_source !== "configured")
		.sort(
			(a, b) =>
				(a.rtt_ms ?? 0) - (b.rtt_ms ?? 0) || a.node_id.localeCompare(b.node_id),
		);

	let group = 1;
	let anchor: number | null = null;
	for (const m of rest) {
		const rtt = m.rtt_ms ?? 0;
		if (anchor === null) anchor = rtt;
		else if (rtt - anchor > thresholdMs) {
			group++;
			anchor = rtt;
		}
		m.region = `r${group}`;
	}
	return [...configured, ...rest].sort((a, b) =>
		a.node_id.localeCompare(b.node_id),
	);
}

export function roleOf(tiering: Tiering, nodeId: string): NodeRole {
	if (tiering.master_node_id === nodeId) return "master";
	for (const plan of Object.values(tiering.regions)) {
		if (plan.leader === nodeId) return "leader";
	}
	return "follower";
}

export function regionOf(tiering: Tiering, nodeId: string): string | null {
	return tiering.snapshot.find((m) => m.node_id === nodeId)?.region ?? null;
}

/** The node this one pulls its change log down from (§5.1): a follower reads
 * from its region leader, a leader from the master, the master from nobody.
 *
 * A follower whose leader has gone quiet falls back to the master directly —
 * that is not improvisation, it is §5.1's "the region leader is a relay and a
 * cache, not an authority". Falling back to an arbitrary *peer* would be
 * improvisation, and is what `pullTargets` still refuses to do.
 *
 * `reachable` is the caller's own liveness observation, and it is what the
 * fallback turns on. The snapshot's `active` flag is the *master's* view at
 * mint time, which is the right input to the leader computation and the wrong
 * input to "can I talk to this box right now" — a follower cut off from its
 * leader has to notice that itself, and the generation is not going to be
 * re-minted to tell it. Omitting `reachable` reads liveness from the snapshot,
 * which is what a node reasoning about *another* node's edges wants. */
export function upstreamOf(
	tiering: Tiering,
	nodeId: string,
	reachable?: (candidateId: string) => boolean,
): string | null {
	if (nodeId === tiering.master_node_id) return null;
	const region = regionOf(tiering, nodeId);
	const leader = region ? (tiering.regions[region]?.leader ?? null) : null;
	if (!leader || leader === nodeId) return tiering.master_node_id;
	const live = reachable
		? reachable(leader)
		: !!tiering.snapshot.find((m) => m.node_id === leader)?.active;
	return live ? leader : tiering.master_node_id;
}

// ── persistence ─────────────────────────────────────────────────────────────

function toTiering(row: ClusterTieringRow): Tiering {
	return {
		generation: row.generation,
		computed_at: row.computed_at,
		reason: row.reason as TierReason,
		master_node_id: row.master_node_id,
		snapshot: JSON.parse(row.snapshot) as TieringMember[],
		regions: JSON.parse(row.regions) as Record<string, RegionPlan>,
	};
}

/** The highest generation this node has seen, or null on a node that has never
 * been tiered (a follower that has not joined anything yet). */
export function currentTiering(db: Db): Tiering | null {
	const row = db.get<ClusterTieringRow>(
		"SELECT * FROM cluster_tiering ORDER BY generation DESC LIMIT 1",
	);
	return row ? toTiering(row) : null;
}

/** Keep the last few generations for the admin panel and for reading history
 * out of a support bundle; older ones are noise. */
const KEEP_GENERATIONS = 20;

function persistTiering(db: Db, tiering: Tiering): void {
	db.run(
		`INSERT INTO cluster_tiering (generation, computed_at, reason, master_node_id, snapshot, regions)
     VALUES ($generation, $computedAt, $reason, $masterNodeId, $snapshot, $regions)
     ON CONFLICT(generation) DO UPDATE SET
       computed_at = excluded.computed_at, reason = excluded.reason,
       master_node_id = excluded.master_node_id, snapshot = excluded.snapshot,
       regions = excluded.regions`,
		{
			$generation: tiering.generation,
			$computedAt: tiering.computed_at,
			$reason: tiering.reason,
			$masterNodeId: tiering.master_node_id,
			$snapshot: JSON.stringify(tiering.snapshot),
			$regions: JSON.stringify(tiering.regions),
		},
	);
	db.run(
		`DELETE FROM cluster_tiering WHERE generation <= (
       SELECT MAX(generation) FROM cluster_tiering
     ) - $keep`,
		{ $keep: KEEP_GENERATIONS },
	);
}

/**
 * Write the generation's conclusions into the places that read them without
 * knowing about tiering at all:
 *
 *  - `cluster_nodes.role` / `.is_master` / `.region`, which the admin panel and
 *    the join handshake serialize. These are *derived* mirrors — a peer never
 *    tells us its role, which is the whole of S4's fix.
 *  - `replication_control.is_master`, which the change log's fixup trigger
 *    reads to decide whether this node's local `seq` is also the canonical
 *    `master_seq`. It has to be a table column: a SQLite trigger cannot reach
 *    application state, only other tables.
 */
function mirror(db: Db, nodeId: string, tiering: Tiering): void {
	db.run("UPDATE replication_control SET is_master = $v WHERE id = 1", {
		$v: tiering.master_node_id === nodeId ? 1 : 0,
	});
	for (const member of tiering.snapshot) {
		if (member.node_id === nodeId) continue;
		const role = roleOf(tiering, member.node_id);
		db.run(
			`UPDATE cluster_nodes
        SET role = $role, is_master = $isMaster, region = $region,
            region_source = $regionSource
      WHERE node_id = $nodeId`,
			{
				$role: role,
				$isMaster: role === "master" ? 1 : 0,
				$region: member.region,
				$regionSource: member.region_source,
				$nodeId: member.node_id,
			},
		);
	}
}

// ── computing a generation ──────────────────────────────────────────────────

function regionRttThreshold(settings: Settings): number {
	return settings.regionRttThresholdMs > 0
		? settings.regionRttThresholdMs
		: DEFAULT_REGION_RTT_MS;
}

/** This node's own row in the snapshot. It is always active (it is running)
 * and its RTT to itself is 0, which is what anchors region group `r1`. */
function selfMember(settings: Settings): TieringMember {
	const usage = diskUsageBytes();
	const configured = settings.nodeRegion.trim();
	return {
		node_id: settings.nodeId,
		name: settings.nodeName || settings.nodeId,
		base_url: settings.nodeUrl,
		region: configured || DEFAULT_REGION,
		region_source: configured ? "configured" : "inferred",
		disk_total_bytes: usage?.total ?? 0,
		rtt_ms: 0,
		replication_mode: settings.replicationMode,
		active: true,
		eligible: settings.replicationMode !== "cache",
		pinned: false,
	};
}

function peerMember(node: ClusterNodeRow): TieringMember {
	const configured = node.region_source === "configured" && !!node.region;
	return {
		node_id: node.node_id!,
		name: node.name,
		base_url: node.base_url,
		region: configured ? node.region! : DEFAULT_REGION,
		region_source: configured ? "configured" : "inferred",
		disk_total_bytes: node.disk_total_bytes,
		rtt_ms: node.rtt_ms,
		replication_mode: node.replication_mode,
		active: !!node.active,
		eligible:
			!!node.active && !node.ineligible && node.replication_mode !== "cache",
		pinned: !!node.pinned_master,
	};
}

/** Everything the computation runs over: this node plus every peer it has a
 * node_id for. Unlike the old election's quorum set, an inactive peer is
 * *included* — it is part of the cluster, just not a leadership candidate, and
 * leaving it out would make the snapshot describe a smaller cluster every time
 * one went quiet. */
export function gatherMembers(db: Db, settings: Settings): TieringMember[] {
	const peers = db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes")
		.filter((n) => n.node_id && n.node_id !== settings.nodeId)
		.map(peerMember);
	return inferRegions(
		[selfMember(settings), ...peers],
		regionRttThreshold(settings),
	);
}

/** Compute and persist the next generation. Deliberately takes a `Db` rather
 * than an `AppState`: `initTiering` runs before `createAppState` exists, since
 * the change log's seed needs to know whether this node assigns `master_seq`. */
export function computeGeneration(
	db: Db,
	settings: Settings,
	reason: TierReason,
): Tiering {
	const previous = currentTiering(db);
	const members = gatherMembers(db, settings);
	const plan = computePlan(
		members,
		previous?.master_node_id ?? settings.nodeId,
	);
	const tiering: Tiering = {
		generation: (previous?.generation ?? 0) + 1,
		computed_at: nowIso(),
		reason,
		master_node_id: plan.masterNodeId,
		snapshot: members,
		regions: plan.regions,
	};
	db.transaction(() => {
		persistTiering(db, tiering);
		mirror(db, settings.nodeId, tiering);
		settleDrift(db, tiering);
	});
	log.info(
		`minted tiering generation=${tiering.generation} reason=${reason} master=${tiering.master_node_id} ` +
			`regions=${Object.entries(tiering.regions)
				.map(([r, p]) => `${r}:${p.leader ?? "-"}(${p.members.length})`)
				.join(",")}`,
	);
	return tiering;
}

/**
 * Seed leadership on a node that has never been tiered.
 *
 * Runs from `index.ts` immediately after `createDb` and before `createAppState`
 * — the change log's seed pass reads `replication_control.is_master` to decide
 * whether this node's log order is the canonical order, so the answer has to
 * exist first. That ordering is a dependency chain, not a style choice.
 *
 * `NODE_ROLE` is consulted here and nowhere else, and only on the first ever
 * boot: a node that already holds a generation derives its role from that, so
 * an env var can never override a decision the cluster has already made.
 */
export function initTiering(db: Db, settings: Settings): void {
	const existing = currentTiering(db);
	if (existing) {
		mirror(db, settings.nodeId, existing);
		return;
	}
	if (settings.nodeRole !== "master") return;
	computeGeneration(db, settings, "bootstrap");
}

// ── role queries ────────────────────────────────────────────────────────────

export function selfRole(state: AppState): NodeRole {
	const tiering = currentTiering(state.db);
	return tiering ? roleOf(tiering, state.settings.nodeId) : "follower";
}

export function isMaster(state: AppState): boolean {
	return selfRole(state) === "master";
}

/** Where the master is, or null when this node cannot say — a follower that
 * has never been tiered, or one whose master is not a linked peer. Null is the
 * degraded answer (§5.5) and callers must treat it as such rather than
 * substituting a peer. */
export function resolveMaster(
	state: AppState,
): { nodeId: string; baseUrl: string; token: string } | null {
	const tiering = currentTiering(state.db);
	if (!tiering) return null;
	if (tiering.master_node_id === state.settings.nodeId) {
		return {
			nodeId: state.settings.nodeId,
			baseUrl: state.settings.nodeUrl,
			token: state.clusterToken,
		};
	}
	return peerCoordinates(state.db, tiering.master_node_id);
}

export function peerCoordinates(
	db: Db,
	nodeId: string,
): { nodeId: string; baseUrl: string; token: string } | null {
	const node = db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $id",
		{ $id: nodeId },
	);
	if (!node?.base_url || !node.token) return null;
	return {
		nodeId,
		baseUrl: node.base_url.replace(/\/$/, ""),
		token: node.token,
	};
}

// ── adopting a peer's generation ────────────────────────────────────────────

/** Take on a generation learned from a peer, if it is newer than ours.
 *
 * Strictly-higher, because generations are minted by one node and are
 * therefore totally ordered — there is no "same generation, different content"
 * case to arbitrate, and treating equality as adoptable would let a stale relay
 * overwrite the record it is relaying. `force` is for the enroll handshake,
 * where joining a cluster means taking its answer whatever this node had
 * decided on its own beforehand. */
export function adoptTiering(
	state: AppState,
	incoming: Tiering | null | undefined,
	opts: { force?: boolean } = {},
): boolean {
	if (!incoming || typeof incoming.generation !== "number") return false;
	if (!incoming.master_node_id || !Array.isArray(incoming.snapshot)) {
		return false;
	}
	const local = currentTiering(state.db);
	if (local && !opts.force && incoming.generation <= local.generation) {
		return false;
	}
	const before = local ? roleOf(local, state.settings.nodeId) : null;
	const after = roleOf(incoming, state.settings.nodeId);
	state.db.transaction(() => {
		persistTiering(state.db, incoming);
		mirror(state.db, state.settings.nodeId, incoming);
	});
	log.info(
		`adopted tiering generation=${incoming.generation} master=${incoming.master_node_id} role=${after}`,
	);
	if (before !== after) {
		log.warning(`role change: ${before ?? "untiered"} -> ${after}`);
		try {
			state.eventBus.publish({
				action: "cluster.role_changed",
				actor: "system",
				kind: "system",
				target: `generation:${incoming.generation}`,
				node_id: state.settings.nodeId,
				role: after,
				previous_role: before,
				master_node_id: incoming.master_node_id,
			});
		} catch {
			// best-effort
		}
	}
	return true;
}

/** Mint a generation and announce it. Master-only by construction — a node
 * that is not master has no standing to re-tier, and refusing here is what
 * keeps "no master, no leadership change" true without a separate check. */
export function retier(
	state: AppState,
	reason: TierReason,
	actor = "system",
): Tiering | null {
	if (!isMaster(state)) return null;
	const tiering = computeGeneration(state.db, state.settings, reason);
	try {
		state.eventBus.publish({
			action: "cluster.tiering_minted",
			actor,
			kind: "system",
			target: `generation:${tiering.generation}`,
			node_id: state.settings.nodeId,
			reason,
			master_node_id: tiering.master_node_id,
			regions: tiering.regions,
		});
	} catch {
		// best-effort
	}
	try {
		recordAudit(state.db, {
			actor,
			action: "cluster.retiered",
			target: `generation:${tiering.generation}`,
		});
	} catch {
		// best-effort -- an audit failure must never fail the re-tier
	}
	return tiering;
}

/**
 * Operator promotion (§5.5): mint a generation naming **this** node master.
 *
 * The one path that mints without already being master, and the only recovery
 * from a master outage — because the alternative, promoting automatically, is
 * the split brain the whole design refuses to risk. A node cannot tell "the
 * master died" from "I am the one who got cut off"; a human with out-of-band
 * knowledge of the network can, and this is where they say so.
 *
 * It therefore does not compute a winner: the operator has chosen one. The
 * capacity argmax is the right rule for a routine re-tier, but at 3am with half
 * the cluster unreachable the largest *reachable* node is not necessarily the
 * one the operator wants, and second-guessing them here would be a worse
 * failure than obeying.
 *
 * **Promoting while the old master is alive splits the cluster** — two nodes
 * minting from the same generation produce two divergent lineages, and nothing
 * downstream can merge them. That is why the caller must be genuinely degraded
 * unless it explicitly overrides, and why the admin surface asks for a typed
 * confirmation rather than offering a button.
 */
export function promoteSelf(state: AppState, actor: string): Tiering {
	const previous = currentTiering(state.db);
	const members = gatherMembers(state.db, state.settings);
	const selfId = state.settings.nodeId;
	// Compute regions the ordinary way, then overwrite the master with this node
	// and re-derive the region leaders around it (D-15 still holds: the master is
	// struck out of every candidate set).
	const plan = computePlan(members, selfId);
	plan.masterNodeId = selfId;
	for (const [region, regionPlan] of Object.entries(plan.regions)) {
		const candidates = members.filter(
			(m) => m.region === region && m.eligible && m.node_id !== selfId,
		);
		regionPlan.leader = best(candidates)?.node_id ?? null;
	}
	const tiering: Tiering = {
		generation: (previous?.generation ?? 0) + 1,
		computed_at: nowIso(),
		reason: "promotion",
		master_node_id: selfId,
		snapshot: members,
		regions: plan.regions,
	};
	state.db.transaction(() => {
		persistTiering(state.db, tiering);
		mirror(state.db, selfId, tiering);
		settleDrift(state.db, tiering);
	});
	log.warning(
		`PROMOTED to master by ${actor}: generation=${tiering.generation} (previous master=${previous?.master_node_id ?? "none"})`,
	);
	try {
		state.eventBus.publish({
			action: "cluster.master_promoted",
			actor,
			kind: "system",
			target: `generation:${tiering.generation}`,
			node_id: selfId,
			previous_master_id: previous?.master_node_id ?? null,
		});
	} catch {
		// best-effort
	}
	try {
		recordAudit(state.db, {
			actor,
			action: "cluster.master_promoted",
			target: `generation:${tiering.generation}`,
		});
	} catch {
		// best-effort
	}
	return tiering;
}

// ── drift (§5.4) ────────────────────────────────────────────────────────────

/**
 * The status a node is *currently* observed to hold, as a composite of its
 * liveness and the role the leader function would give it right now.
 *
 * Folding the prospective role in is R-3's answer to "what counts as a capacity
 * class change": raw `disk_total_bytes` moves on every routine disk write and
 * would make ordinary growth look like churn, whereas a capacity change that
 * would alter who leads shows up here as a role flip on exactly the nodes it
 * affects — and gets the same hold-down as any other status change.
 */
function observedStatus(member: TieringMember, plan: Plan): string {
	const liveness = member.active ? "up" : "down";
	const role =
		plan.masterNodeId === member.node_id
			? "master"
			: Object.values(plan.regions).some((r) => r.leader === member.node_id)
				? "leader"
				: "follower";
	return `${liveness}:${role}`;
}

/** Record what the generation just minted was computed against, so the drift
 * counter has a baseline to compare to. Rows for nodes that are no longer in
 * the snapshot go with it — the drift table is bounded by cluster size. */
function settleDrift(db: Db, tiering: Tiering): void {
	const plan: Plan = {
		masterNodeId: tiering.master_node_id,
		regions: tiering.regions,
	};
	const now = nowIso();
	const ids = tiering.snapshot.map((m) => m.node_id);
	for (const member of tiering.snapshot) {
		const status = observedStatus(member, plan);
		db.run(
			`INSERT INTO cluster_drift (node_id, status, observed_at, settled_status, settled_at)
       VALUES ($nodeId, $status, $now, $status, $now)
       ON CONFLICT(node_id) DO UPDATE SET settled_status = excluded.status, settled_at = excluded.settled_at`,
			{ $nodeId: member.node_id, $status: status, $now: now },
		);
	}
	for (const row of db.all<ClusterDriftRow>("SELECT * FROM cluster_drift")) {
		if (!ids.includes(row.node_id)) {
			db.run("DELETE FROM cluster_drift WHERE node_id = $id", {
				$id: row.node_id,
			});
		}
	}
}

export interface DriftReport {
	/** Nodes whose held status disagrees with what the current generation was
	 * computed against. */
	changes: number;
	threshold: number;
	/** Nodes that have changed but are still inside the hold-down window. */
	pending: number;
}

/**
 * Count status changes against the current generation (§5.4, D-5).
 *
 * Threshold is `max(2, trunc(n/3))` over the whole cluster. The floor is
 * load-bearing: at n = 3, `trunc(3/3) = 1`, so without it a single node
 * bouncing would re-tier everything — §4.1 calls that out explicitly.
 *
 * A node the current generation has never seen (`settled_status` NULL) counts
 * **immediately**, with no hold-down. A join is not flapping: the master learned
 * about it through a handshake it served itself, and until the node is in a
 * snapshot it has no upstream and its writes reach nobody. Waiting five minutes
 * to admit it would be five minutes of silent data isolation, which is a worse
 * failure than a redundant re-tier.
 *
 * `persist: false` measures without touching the hold-down clock, for the
 * read-only surfaces (`GET /cluster/self`) that want the number but must not
 * have side effects.
 */
export function measureDrift(
	db: Db,
	settings: Settings,
	opts: { persist?: boolean; now?: number } = {},
): DriftReport {
	const persist = opts.persist !== false;
	const now = opts.now ?? Date.now();
	const tiering = currentTiering(db);
	const members = gatherMembers(db, settings);
	const plan = computePlan(members, tiering?.master_node_id ?? settings.nodeId);
	const known = new Map(members.map((m) => [m.node_id, m]));
	const rows = new Map(
		db
			.all<ClusterDriftRow>("SELECT * FROM cluster_drift")
			.map((r) => [r.node_id, r]),
	);

	let changes = 0;
	let pending = 0;
	const seen = new Set<string>();
	const nowIsoStr = nowIso();

	const consider = (nodeId: string, status: string): void => {
		if (seen.has(nodeId)) return;
		seen.add(nodeId);
		const row = rows.get(nodeId);
		if (persist && (!row || row.status !== status)) {
			db.run(
				`INSERT INTO cluster_drift (node_id, status, observed_at, settled_status, settled_at)
         VALUES ($nodeId, $status, $now, $settled, $settledAt)
         ON CONFLICT(node_id) DO UPDATE SET status = excluded.status, observed_at = excluded.observed_at`,
				{
					$nodeId: nodeId,
					$status: status,
					$now: nowIsoStr,
					$settled: row?.settled_status ?? null,
					$settledAt: row?.settled_at ?? null,
				},
			);
		}
		const settled = row?.settled_status ?? null;
		if (settled === status) return;
		if (settled === null) {
			changes++;
			return;
		}
		const heldSince = Date.parse(
			row && row.status === status ? row.observed_at : nowIsoStr,
		);
		if (now - heldSince >= HOLD_DOWN_MS) changes++;
		else pending++;
	};

	for (const member of members)
		consider(member.node_id, observedStatus(member, plan));
	// A node that was in the snapshot and is no longer linked at all.
	for (const member of tiering?.snapshot ?? []) {
		if (!known.has(member.node_id)) consider(member.node_id, "absent:follower");
	}

	return {
		changes,
		threshold: Math.max(2, Math.trunc(members.length / 3)),
		pending,
	};
}

/** The `cluster_tiering_drift` scheduler job. A no-op on every node that is not
 * master, and on a master whose view of the cluster has not moved — so it costs
 * a single-node deployment one query a minute and nothing else. */
export function tieringDriftJob(state: AppState): DriftReport | null {
	if (!isMaster(state)) return null;
	const report = measureDrift(state.db, state.settings);
	if (report.changes >= report.threshold) {
		log.info(
			`re-tiering: ${report.changes} status change(s) against generation ` +
				`${currentTiering(state.db)?.generation ?? 0}, threshold ${report.threshold}`,
		);
		retier(state, "drift");
	}
	return report;
}

/** Admit a node that has just completed the join handshake, without waiting out
 * the hold-down. See `measureDrift` for why a join is not flapping. */
export function retierForNewMember(state: AppState, nodeId: string): void {
	if (!isMaster(state)) return;
	const tiering = currentTiering(state.db);
	if (tiering?.snapshot.some((m) => m.node_id === nodeId)) return;
	retier(state, "drift");
}
