import { api } from "@/config/api";
import type { ClusterNode, ClusterSelf, LinkedClusterNode, NewClusterNode } from "../types";

export const clusterService = {
  revealToken: () => api.get<{ token: string }>("/cluster/token").then((r) => r.token),

  rotateToken: () => api.post<{ token: string }>("/cluster/token/rotate").then((r) => r.token),

  self: () => api.get<ClusterSelf>("/cluster/self"),

  listNodes: () => api.get<{ nodes: ClusterNode[] }>("/cluster/nodes").then((r) => r.nodes),

  linkNode: (node: NewClusterNode) => api.post<LinkedClusterNode>("/cluster/nodes", { json: node }),

  unlinkNode: (nodeId: number) => api.delete(`/cluster/nodes/${nodeId}`),
};
