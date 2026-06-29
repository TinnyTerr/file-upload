import { api } from "@/config/api";
import type { ClusterNode, NewClusterNode } from "../types";

export const clusterService = {
  revealToken: () => api.get<{ token: string }>("/cluster/token").then((r) => r.token),

  rotateToken: () => api.post<{ token: string }>("/cluster/token/rotate").then((r) => r.token),

  listNodes: () => api.get<{ nodes: ClusterNode[] }>("/cluster/nodes").then((r) => r.nodes),

  linkNode: (node: NewClusterNode) => api.post<ClusterNode>("/cluster/nodes", { json: node }),

  unlinkNode: (nodeId: number) => api.delete(`/cluster/nodes/${nodeId}`),
};
