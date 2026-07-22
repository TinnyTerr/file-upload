import { createHash } from "node:crypto";
import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import { ensureStorageSettings } from "../storage/accounting.ts";
import { ClusterHTTPError, getJson } from "./http.ts";
import { getSelfState } from "./election.ts";
import { getLogger } from "../logging.ts";

/** Mirrors app/api/cluster/digest.py. */

const log = getLogger("app.cluster.digest");

export interface ClusterDigest {
  hash: string;
  global_quota: number;
  members: string[];
  role: string;
  epoch: number;
}

/** A small, comparable summary of state that SHOULD be identical on every
 * node: the shared global storage cap and the membership set (in a full
 * mesh every node should know the same node_ids). Counts that legitimately
 * differ per-node (each node's own files) are deliberately excluded --
 * adding them would produce permanent false "mismatch" alerts. */
export function computeDigest(state: AppState): ClusterDigest {
  const storage = ensureStorageSettings(state.db);
  const globalQuota = Number(storage.global_storage_quota_bytes);
  const peerIds = state.db
    .all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
    .map((n) => n.node_id)
    .filter((id): id is string => !!id);
  const members = [...new Set([state.settings.nodeId, ...peerIds])].sort();
  // role/epoch are deliberately excluded from the hash -- they legitimately
  // differ between "who is master" and "master vs. follower", but ARE
  // reported alongside it for the split-brain cross-check below.
  const body = { global_quota: globalQuota, members };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const self = getSelfState(state.db);
  return { hash, ...body, role: self.role, epoch: self.epoch };
}

/** Compare this node's digest against every peer's and alert on divergence.
 * Emits a `cluster.sync_mismatch` event and a warning log for each
 * disagreeing peer. Returns the number of mismatches found. */
export async function syncCheckJob(state: AppState): Promise<number> {
  const local = computeDigest(state);
  const targets = state.db
    .all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
    .filter((n) => n.base_url && n.token);

  let mismatches = 0;
  for (const node of targets) {
    let remote: ClusterDigest | null = null;
    try {
      remote = (await getJson(`${node.base_url.replace(/\/$/, "")}/api/cluster/digest`, node.token, 10_000)) as ClusterDigest;
    } catch (err) {
      if (err instanceof ClusterHTTPError) {
        log.debug(`digest fetch failed for ${node.base_url}: ${err.message}`);
      }
      continue;
    }
    if (!remote || remote.hash !== local.hash) {
      mismatches++;
      log.warning(`cluster sync mismatch node=${node.node_id ?? node.id} local=${JSON.stringify(local)} remote=${JSON.stringify(remote)}`);
      try {
        state.eventBus.publish({
          action: "cluster.sync_mismatch",
          actor: "system",
          target: `node:${node.node_id ?? node.id}`,
          kind: "system",
          local_hash: local.hash,
          remote_hash: remote?.hash ?? null,
        });
      } catch {
        // best-effort
      }
    }

    // Split-brain safety net: election fencing (cluster/election.ts) should
    // make two nodes both holding role=master at the SAME epoch structurally
    // impossible. If it happens anyway, that's a bug worth paging on, not
    // something to silently reconcile -- alert loudly rather than picking a
    // winner here.
    if (remote && local.role === "master" && remote.role === "master" && remote.epoch === local.epoch) {
      log.error(`SPLIT BRAIN: both this node and node=${node.node_id ?? node.id} report role=master at epoch=${local.epoch}`);
      try {
        state.eventBus.publish({
          action: "cluster.split_brain_detected",
          actor: "system",
          target: `node:${node.node_id ?? node.id}`,
          kind: "system",
          epoch: local.epoch,
        });
      } catch {
        // best-effort
      }
    }
  }
  return mismatches;
}
