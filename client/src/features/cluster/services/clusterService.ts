import { api } from "@/config/api";
import type {
	ClusterNode,
	ClusterNodeUpdate,
	ClusterSelf,
	ClusterTopology,
	LinkedClusterNode,
	NewClusterNode,
} from "../types";

export const clusterService = {
	revealToken: () =>
		api.get<{ token: string }>("/cluster/token").then((r) => r.token),

	rotateToken: () =>
		api.post<{ token: string }>("/cluster/token/rotate").then((r) => r.token),

	self: () => api.get<ClusterSelf>("/cluster/self"),

	/** The replication graph. Derived server-side on purpose: `upstreamOf()` is
	 * the whole topology rule, and a second copy here could disagree with the
	 * pulls the cluster is actually doing. */
	topology: () => api.get<ClusterTopology>("/cluster/topology"),

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
	promote: (confirm: string, force = false) =>
		api.post<{ tiering: { generation: number } }>("/cluster/promote", {
			json: { confirm, force },
		}),
};
