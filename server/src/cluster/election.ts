import type { AppState } from "../appState.ts";
import type { Settings } from "../config.ts";
import type { Db } from "../db/types.ts";
import type { ClusterNodeRow, ClusterSelfStateRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import { ClusterHTTPError, postJson } from "./http.ts";
import { getLogger } from "../logging.ts";

/** Elected, epoch-versioned leadership layered UNDER the existing full-mesh
 * reserve/replicate/export protocol -- see cluster/replication.ts and
 * cluster/membership.ts, which this module does not replace. "Master" stops
 * being a fixed identity from MASTER_URL and becomes a role any node can
 * hold over time, tracked by a monotonic `epoch` that every node fences
 * writes against.
 *
 * Design invariants carried over unchanged from the rest of the cluster
 * subsystem (do not violate these while extending this file):
 *  - node-scoped event sequencing (cluster/eventBus.ts) is orthogonal to
 *    role -- a node's origin_seq keeps counting whether it's master or
 *    follower this epoch.
 *  - the announce-id protocol's last-writer-wins-by-timestamp rule is
 *    unchanged; only WHO counts as "master" for the tie-break becomes
 *    dynamic instead of statically configured. */

const log = getLogger("app.cluster.election");

export type ClusterRole = "master" | "follower" | "candidate";

/** How long a follower waits without contact from its known master before
 * calling an election. Kept well above the 1-minute heartbeat interval
 * (jobs/scheduler.ts) so a couple of missed heartbeats don't cause
 * unnecessary churn. */
export const MASTER_CONTACT_TIMEOUT_MS = 90_000;

function selfRow(db: Db): ClusterSelfStateRow {
  const row = db.get<ClusterSelfStateRow>("SELECT * FROM cluster_self_state WHERE id = 1");
  if (row) return row;
  const now = nowIso();
  db.run(
    `INSERT INTO cluster_self_state (id, role, epoch, voted_epoch, updated_at) VALUES (1, 'follower', 0, 0, $now)
     ON CONFLICT(id) DO NOTHING`,
    { $now: now },
  );
  return db.get<ClusterSelfStateRow>("SELECT * FROM cluster_self_state WHERE id = 1")!;
}

/** Seed this node's election row from its bootstrap NODE_ROLE on first ever
 * boot. Called once at startup, before anything else touches election
 * state. A no-op on every later boot -- persisted role/epoch always wins
 * over env config, so a rebooted node never re-announces an epoch it
 * already lost. */
export function initSelfState(db: Db, settings: Settings): void {
  const existing = db.get<ClusterSelfStateRow>("SELECT * FROM cluster_self_state WHERE id = 1");
  if (existing) return;
  const now = nowIso();
  const role: ClusterRole = settings.nodeRole === "master" ? "master" : "follower";
  db.run(
    `INSERT INTO cluster_self_state (id, role, epoch, voted_epoch, current_master_id, current_master_url, last_master_contact_at, updated_at)
     VALUES (1, $role, 0, 0, $masterId, $masterUrl, $now, $now)`,
    {
      $role: role,
      $masterId: role === "master" ? settings.nodeId : null,
      $masterUrl: role === "master" ? settings.nodeUrl : null,
      $now: now,
    },
  );
}

export function getSelfState(db: Db): ClusterSelfStateRow {
  return selfRow(db);
}

interface PersistRoleOpts {
  role: ClusterRole;
  epoch: number;
  currentMasterId?: string | null;
  currentMasterUrl?: string | null;
  touchMasterContact?: boolean;
}

function persistRoleChange(db: Db, opts: PersistRoleOpts): void {
  const now = nowIso();
  const current = selfRow(db);
  db.run(
    `UPDATE cluster_self_state SET
       role = $role, epoch = $epoch,
       current_master_id = $masterId, current_master_url = $masterUrl,
       last_master_contact_at = $contact, updated_at = $now
     WHERE id = 1`,
    {
      $role: opts.role,
      $epoch: opts.epoch,
      $masterId: opts.currentMasterId !== undefined ? opts.currentMasterId : current.current_master_id,
      $masterUrl: opts.currentMasterUrl !== undefined ? opts.currentMasterUrl : current.current_master_url,
      $contact: opts.touchMasterContact ? now : current.last_master_contact_at,
      $now: now,
    },
  );
}

/** Record contact with the currently-known master (e.g. a successful
 * heartbeat round-trip to it) without changing role/epoch. Resets the
 * liveness timer that `checkMasterLivenessJob` watches. */
export function touchMasterContact(db: Db): void {
  db.run("UPDATE cluster_self_state SET last_master_contact_at = $now, updated_at = $now WHERE id = 1", { $now: nowIso() });
}

/** If `epoch` is higher than what this node knows, adopt it: fall back to
 * follower (fencing any in-flight belief that we're still master) and
 * update the master pointer if one was supplied. Returns true if adopted.
 * This is the single place self-demotion happens -- called from reserve
 * fencing, heartbeat responses, and vote handling alike. */
export function adoptEpochIfHigher(
  state: AppState,
  epoch: number,
  opts: { currentMasterId?: string | null; currentMasterUrl?: string | null } = {},
): boolean {
  const db = state.db;
  const self = selfRow(db);
  if (epoch <= self.epoch) return false;
  const wasMaster = self.role === "master";
  persistRoleChange(db, {
    role: "follower",
    epoch,
    currentMasterId: opts.currentMasterId,
    currentMasterUrl: opts.currentMasterUrl,
    touchMasterContact: opts.currentMasterId !== undefined,
  });
  if (wasMaster) {
    log.warning(`self-demoted: saw higher epoch=${epoch} (was master at epoch=${self.epoch})`);
    try {
      state.eventBus.publish({
        action: "cluster.master_demoted",
        actor: "system",
        kind: "system",
        target: `epoch:${epoch}`,
        node_id: state.settings.nodeId,
        epoch,
        reason: "higher_epoch_seen",
      });
    } catch {
      // best-effort
    }
  }
  return true;
}

/** Record a master pointer learned from a peer (typically a join/enroll
 * response) without necessarily bumping the epoch -- unlike
 * `adoptEpochIfHigher`, this also applies at epoch PARITY, which matters at
 * bootstrap: a freshly-joined node and the cluster it joins both start at
 * epoch 0, so a strict epoch increase would never fire and the joiner would
 * never learn who master is until the next actual election. Ignored if
 * `epoch` is behind what we already know, or if we ourselves believe we're
 * master at this same epoch (that's the split-brain case digest.ts's
 * cross-check exists to catch, not something to silently overwrite here). */
export function learnMasterPointer(state: AppState, epoch: number, masterId: string, masterUrl: string): void {
  if (!masterId) return;
  const db = state.db;
  const self = selfRow(db);
  if (epoch > self.epoch) {
    adoptEpochIfHigher(state, epoch, { currentMasterId: masterId, currentMasterUrl: masterUrl });
    return;
  }
  if (epoch < self.epoch || self.role === "master") return;
  persistRoleChange(db, { role: self.role as ClusterRole, epoch: self.epoch, currentMasterId: masterId, currentMasterUrl: masterUrl, touchMasterContact: true });
}

/** The node this node currently believes is master, or null if unknown.
 * Read-only lookup against locally persisted state -- callers needing a
 * fresher answer should retry after the next heartbeat/gossip cycle rather
 * than blocking here on a network call. */
export function resolveMaster(state: AppState): { nodeId: string; baseUrl: string; token: string } | null {
  const self = selfRow(state.db);
  if (self.role === "master") {
    return { nodeId: state.settings.nodeId, baseUrl: state.settings.nodeUrl, token: state.clusterToken };
  }
  if (!self.current_master_id) return null;
  const node = state.db.get<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE node_id = $id", { $id: self.current_master_id });
  if (!node || !node.base_url || !node.token) return null;
  return { nodeId: node.node_id!, baseUrl: node.base_url.replace(/\/$/, ""), token: node.token };
}

/** Per-node "how far have I applied that node's event stream" watermark --
 * derived for free from the existing cluster_events mirror (see
 * cluster/eventBus.ts's node-scoped origin_seq). Used as the vote-grant
 * safety check: a candidate behind on ANY peer's stream must not become
 * master, or it could serve reads/rebases that silently regress state. */
export function lastAppliedVector(state: AppState): Record<string, number> {
  const rows = state.db.all<{ origin_node_id: string; max_seq: number }>(
    "SELECT origin_node_id, MAX(origin_seq) as max_seq FROM cluster_events GROUP BY origin_node_id",
  );
  const vector: Record<string, number> = {};
  for (const row of rows) vector[row.origin_node_id] = row.max_seq;
  vector[state.settings.nodeId] = Math.max(vector[state.settings.nodeId] ?? 0, state.eventBus.currentSeq());
  return vector;
}

/** True iff `candidate` is at least as far along as `local` on every node
 * `local` has an opinion about (missing entries in `candidate` count as 0,
 * i.e. "behind"). */
export function vectorAtLeast(candidate: Record<string, number>, local: Record<string, number>): boolean {
  for (const [nodeId, seq] of Object.entries(local)) {
    if ((candidate[nodeId] ?? 0) < seq) return false;
  }
  return true;
}

/** Every node with a known address/token, regardless of the `active`
 * heartbeat-liveness flag -- deliberately NOT filtered to active=1. `active`
 * is just a cache of "did the last heartbeat round-trip succeed" and goes
 * to 0 for exactly the node we most need to hold an election over (a dead
 * master). Election majority must be computed over total known cluster
 * membership, not over "whoever happened to answer last heartbeat", or a
 * shrinking active set during a partition could let two different minority
 * views both believe they have a majority. */
function knownClusterPeers(db: Db): Array<{ nodeId: string; baseUrl: string; token: string }> {
  return db
    .all<ClusterNodeRow>("SELECT * FROM cluster_nodes")
    .filter((n) => n.node_id && n.base_url && n.token)
    .map((n) => ({ nodeId: n.node_id!, baseUrl: n.base_url.replace(/\/$/, ""), token: n.token }));
}

/** Vote-grant decision made by a peer receiving `/api/cluster/vote-request`.
 * Grants only if the candidate's epoch is strictly ahead of ours AND its
 * applied-sequence vector is at least as far along as ours (never hand
 * leadership to a node that would regress state), and persists the vote
 * before returning so a crash-and-restart can't double-vote in the same
 * epoch. */
export function handleVoteRequest(
  state: AppState,
  body: { candidate_id?: string; epoch?: number; vector?: Record<string, number> },
): { granted: boolean; epoch: number; reason?: string } {
  const db = state.db;
  const candidateId = body.candidate_id ?? "";
  const candidateEpoch = Number(body.epoch ?? 0);
  const self = selfRow(db);

  if (!candidateId || !Number.isFinite(candidateEpoch) || candidateEpoch <= self.epoch) {
    return { granted: false, epoch: self.epoch, reason: "stale_epoch" };
  }
  const local = lastAppliedVector(state);
  if (!vectorAtLeast(body.vector ?? {}, local)) {
    return { granted: false, epoch: self.epoch, reason: "candidate_behind" };
  }

  // Already voted this epoch: idempotent for the same candidate (retried
  // request), refused for a different one.
  if (self.voted_epoch === candidateEpoch) {
    return { granted: self.voted_for === candidateId, epoch: self.epoch };
  }

  const wasMaster = self.role === "master";
  db.run("UPDATE cluster_self_state SET voted_epoch = $epoch, voted_for = $candidateId, updated_at = $now WHERE id = 1", {
    $epoch: candidateEpoch,
    $candidateId: candidateId,
    $now: nowIso(),
  });
  // Seeing a higher epoch in play means any belief we still hold about
  // being (or knowing) master at the old epoch is stale -- fence it now
  // rather than waiting for master-assumed to arrive.
  persistRoleChange(db, { role: "follower", epoch: candidateEpoch });
  if (wasMaster) {
    try {
      state.eventBus.publish({
        action: "cluster.master_demoted",
        actor: "system",
        kind: "system",
        node_id: state.settings.nodeId,
        epoch: candidateEpoch,
        reason: "higher_epoch_seen",
      });
    } catch {
      // best-effort
    }
  }
  return { granted: true, epoch: candidateEpoch };
}

/** Apply a `/api/cluster/master-assumed` broadcast from the node that just
 * won an election. Idempotent and safe to receive out of order -- a lower
 * or equal epoch than one already seen for a DIFFERENT node is ignored. */
export function handleMasterAssumed(
  state: AppState,
  body: { node_id?: string; node_url?: string; epoch?: number },
): { accepted: boolean; epoch: number } {
  const db = state.db;
  const self = selfRow(db);
  const epoch = Number(body.epoch ?? -1);
  const nodeId = body.node_id ?? "";
  if (!nodeId || !Number.isFinite(epoch) || epoch < self.epoch) {
    return { accepted: false, epoch: self.epoch };
  }
  const wasMaster = self.role === "master" && nodeId !== state.settings.nodeId;
  const iAmTheNewMaster = nodeId === state.settings.nodeId;
  persistRoleChange(db, {
    role: iAmTheNewMaster ? "master" : "follower",
    epoch,
    currentMasterId: nodeId,
    currentMasterUrl: body.node_url ?? null,
    touchMasterContact: true,
  });
  if (wasMaster) {
    try {
      state.eventBus.publish({
        action: "cluster.master_demoted",
        actor: "system",
        kind: "system",
        node_id: state.settings.nodeId,
        epoch,
        reason: "master_assumed_elsewhere",
      });
    } catch {
      // best-effort
    }
  }
  return { accepted: true, epoch };
}

/** Gossip a won election to every known peer so the cluster converges
 * faster than waiting for the next heartbeat round. Best-effort -- peers
 * that miss this will still pick up the new epoch/master from their own
 * next heartbeat exchange or reserve fencing. */
async function broadcastMasterAssumed(state: AppState, epoch: number): Promise<void> {
  const peers = knownClusterPeers(state.db);
  await Promise.all(
    peers.map(async (peer) => {
      try {
        await postJson(
          `${peer.baseUrl}/api/cluster/master-assumed`,
          peer.token,
          { node_id: state.settings.nodeId, node_url: state.settings.nodeUrl, epoch },
          5_000,
        );
      } catch (err) {
        log.debug(`master-assumed broadcast to ${peer.baseUrl} failed: ${err instanceof ClusterHTTPError ? err.message : String(err)}`);
      }
    }),
  );
}

/** Run one election attempt: bump the epoch, vote for self, request votes
 * from every known peer, and become master on majority. Loses gracefully
 * (falls back to follower at the new epoch) on a split vote or on failing
 * to reach quorum -- the next `checkMasterLivenessJob` tick will retry with
 * fresh jitter rather than looping tightly. */
export async function runElection(state: AppState): Promise<void> {
  const db = state.db;
  const self = selfRow(db);
  const newEpoch = self.epoch + 1;
  persistRoleChange(db, { role: "candidate", epoch: newEpoch });
  db.run("UPDATE cluster_self_state SET voted_epoch = $epoch, voted_for = $id, updated_at = $now WHERE id = 1", {
    $epoch: newEpoch,
    $id: state.settings.nodeId,
    $now: nowIso(),
  });

  const vector = lastAppliedVector(state);
  const peers = knownClusterPeers(db);
  log.info(`starting election epoch=${newEpoch} known_peers=${peers.length}`);

  let grants = 1; // vote for self
  await Promise.all(
    peers.map(async (peer) => {
      try {
        const res = (await postJson(
          `${peer.baseUrl}/api/cluster/vote-request`,
          peer.token,
          { candidate_id: state.settings.nodeId, candidate_url: state.settings.nodeUrl, epoch: newEpoch, vector },
          5_000,
        )) as { granted?: boolean } | null;
        if (res?.granted) grants++;
      } catch (err) {
        log.debug(`vote-request to ${peer.baseUrl} failed: ${err instanceof ClusterHTTPError ? err.message : String(err)}`);
      }
    }),
  );

  const majority = Math.floor((peers.length + 1) / 2) + 1;
  if (grants >= majority) {
    persistRoleChange(db, {
      role: "master",
      epoch: newEpoch,
      currentMasterId: state.settings.nodeId,
      currentMasterUrl: state.settings.nodeUrl,
      touchMasterContact: true,
    });
    log.info(`won election epoch=${newEpoch} grants=${grants}/${peers.length + 1}`);
    try {
      state.eventBus.publish({
        action: "cluster.master_elected",
        actor: "system",
        kind: "system",
        node_id: state.settings.nodeId,
        epoch: newEpoch,
      });
    } catch {
      // best-effort
    }
    await broadcastMasterAssumed(state, newEpoch);
  } else {
    log.info(`lost election epoch=${newEpoch} grants=${grants}/${peers.length + 1}`);
    persistRoleChange(db, { role: "follower", epoch: newEpoch });
  }
}

/** Periodic liveness check (registered in jobs/scheduler.ts): if this node
 * is a follower/candidate and hasn't confirmed contact with its known
 * master within MASTER_CONTACT_TIMEOUT_MS, call an election. A random jitter
 * delay avoids every follower timing out and calling elections in lockstep
 * (which would otherwise tend to produce repeated split votes). No-op for a
 * standalone node (no peers to elect against) and for the current master. */
export async function checkMasterLivenessJob(state: AppState): Promise<void> {
  const self = selfRow(state.db);
  if (self.role === "master" || self.role === "candidate") return;
  const peers = knownClusterPeers(state.db);
  if (peers.length === 0) return;

  const lastContactMs = self.last_master_contact_at ? Date.parse(self.last_master_contact_at) : 0;
  const silentMs = Date.now() - lastContactMs;
  if (self.current_master_id && silentMs < MASTER_CONTACT_TIMEOUT_MS) return;

  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 1500)));
  // Re-check after the jitter delay in case a heartbeat/master-assumed
  // landed while we were waiting.
  const recheck = selfRow(state.db);
  if (recheck.role === "master" || recheck.role === "candidate") return;
  const recheckSilentMs = Date.now() - (recheck.last_master_contact_at ? Date.parse(recheck.last_master_contact_at) : 0);
  if (recheck.current_master_id && recheckSilentMs < MASTER_CONTACT_TIMEOUT_MS) return;

  log.warning(`no contact with master for ${silentMs}ms -- calling election`);
  await runElection(state);
}
