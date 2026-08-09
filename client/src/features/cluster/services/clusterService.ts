import { api } from "@/config/api";
import type {
	ChunkStorage,
	ClusterNode,
	ClusterNodeUpdate,
	ClusterSelf,
	ClusterTopology,
	ConflictsResponse,
	EnrollmentToken,
	LinkedClusterNode,
	NewClusterNode,
} from "../types";

export const clusterService = {
	/** The shared cluster token. Since Phase 9 this is a *bootstrap* credential:
	 * a node honours it only until every linked peer has established a pair
	 * credential, after which it is good for nothing but enrolling a new node. */
	revealToken: () =>
		api.get<{ token: string }>("/cluster/token").then((r) => r.token),

	rotateToken: () =>
		api.post<{ token: string }>("/cluster/token/rotate").then((r) => r.token),

	/** Mint a one-use, fifteen-minute token to paste into the node that will do
	 * the linking. It authorizes one credential exchange and nothing else — no
	 * change log, no identity fetch, no heartbeat. */
	mintEnrollmentToken: () =>
		api.post<EnrollmentToken>("/cluster/enrollment-tokens"),

	/** Re-key one peer by hand. The same exchange the maintenance job runs, so
	 * the retired secret stays valid for the overlap window and nothing 401s
	 * mid-flight. */
	rotateCredential: (nodeId: number) =>
		api.post<ClusterNode>(`/cluster/nodes/${nodeId}/rotate-credential`),

	self: () => api.get<ClusterSelf>("/cluster/self"),

	/** The replication graph. Derived server-side on purpose: `upstreamOf()` is
	 * the whole topology rule, and a second copy here could disagree with the
	 * pulls the cluster is actually doing. */
	topology: () => api.get<ClusterTopology>("/cluster/topology"),

	/** Conflicts are recorded where they are arbitrated — the master. A
	 * non-master answers this by reading through to it, so the panel works from
	 * whichever node the operator happens to be signed in to. */
	listConflicts: (includeDismissed = false) =>
		api.get<ConflictsResponse>(
			`/cluster/conflicts?include_dismissed=${includeDismissed ? 1 : 0}`,
		),

	dismissConflict: (id: number) => api.post(`/cluster/conflicts/${id}/dismiss`),

	/** Write the losing edit again, now, on top of the winner. Not a replay —
	 * see the route's comment: replaying the original entry would re-enter the
	 * arbitration it already lost. */
	reapplyConflict: (id: number) => api.post(`/cluster/conflicts/${id}/reapply`),

	listNodes: () =>
		api.get<{ nodes: ClusterNode[] }>("/cluster/nodes").then((r) => r.nodes),

	linkNode: (node: NewClusterNode) =>
		api.post<LinkedClusterNode>("/cluster/nodes", { json: node }),

	updateNode: (nodeId: number, patch: ClusterNodeUpdate) =>
		api.patch<ClusterNode>(`/cluster/nodes/${nodeId}`, { json: patch }),

	unlinkNode: (nodeId: number) => api.delete(`/cluster/nodes/${nodeId}`),

	/** Mint a new tiering generation. Master-only; a follower gets a 409, since
	 * only the master may decide where leadership sits. */
	retier: () =>
		api.post<{ tiering: { generation: number } | null }>("/cluster/retier"),

	/** Take over as master (§5.5). Refused unless this node is genuinely
	 * degraded, and `confirm` must be the node's own name typed out — promoting
	 * while the old master is alive splits the cluster, and that is a decision
	 * only a human with out-of-band knowledge can make. */
	/** The chunk cache cap, in bytes; 0 disables eviction. Node-local, like the
	 * disk it describes — there is no cluster-wide answer to how big this
	 * node's cache should be. */
	setCacheCap: (bytes: number) =>
		api.put<ChunkStorage>("/cluster/cache-cap", {
			json: { cache_max_bytes: bytes },
		}),

	promote: (confirm: string, force = false) =>
		api.post<{ tiering: { generation: number } }>("/cluster/promote", {
			json: { confirm, force },
		}),
};
