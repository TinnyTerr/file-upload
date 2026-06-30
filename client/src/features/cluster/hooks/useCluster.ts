import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { clusterService } from "../services/clusterService";
import { errorMessage } from "@/config/api";
import type { NewClusterNode } from "../types";

const NODES_QUERY = ["cluster", "nodes"] as const;
const SELF_QUERY = ["cluster", "self"] as const;

export function useClusterSelf() {
  // Poll so node capacity + active halts stay reasonably fresh on the dashboard.
  return useQuery({
    queryKey: SELF_QUERY,
    queryFn: clusterService.self,
    refetchInterval: 15000,
  });
}

export function useClusterNodes() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: NODES_QUERY });

  const list = useQuery({
    queryKey: NODES_QUERY,
    queryFn: clusterService.listNodes,
    refetchInterval: 15000,
  });

  const link = useMutation({
    mutationFn: (node: NewClusterNode) => clusterService.linkNode(node),
    onSuccess: (node) => {
      const enroll = node.enroll;
      if (enroll?.status === "ok") {
        toast.success("Node linked & enrolled", {
          description: enroll.rebased ? "Node rebased onto this master." : "Node joined; no changes to rebase.",
        });
      } else if (enroll?.status === "error") {
        toast.warning("Node linked, but enrollment failed", {
          description: enroll.reason ?? "The node could not be reached to enroll.",
        });
      } else {
        toast.success("Node linked");
      }
      invalidate();
    },
    onError: (err) => toast.error("Couldn't link node", { description: errorMessage(err) }),
  });

  const unlink = useMutation({
    mutationFn: (nodeId: number) => clusterService.unlinkNode(nodeId),
    onSuccess: () => {
      toast.success("Node unlinked");
      invalidate();
    },
    onError: (err) => toast.error("Couldn't unlink node", { description: errorMessage(err) }),
  });

  return { list, link, unlink };
}

export function useClusterToken() {
  const reveal = useMutation({
    mutationFn: () => clusterService.revealToken(),
    onError: (err) => toast.error("Couldn't reveal token", { description: errorMessage(err) }),
  });

  const rotate = useMutation({
    mutationFn: () => clusterService.rotateToken(),
    onSuccess: () => toast.success("Cluster token rotated"),
    onError: (err) => toast.error("Couldn't rotate token", { description: errorMessage(err) }),
  });

  return { reveal, rotate };
}
