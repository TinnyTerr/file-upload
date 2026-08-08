import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/config/api";
import { clusterService } from "../services/clusterService";
import type { ClusterNodeUpdate, NewClusterNode } from "../types";

const NODES_QUERY = ["cluster", "nodes"] as const;
const SELF_QUERY = ["cluster", "self"] as const;
const TOPOLOGY_QUERY = ["cluster", "topology"] as const;

export function useClusterSelf() {
	// Poll so node capacity + active halts stay reasonably fresh on the dashboard.
	return useQuery({
		queryKey: SELF_QUERY,
		queryFn: clusterService.self,
		refetchInterval: 15000,
	});
}

/** The replication graph. Same cadence as the node list — an edge only moves
 * when a generation is minted or a peer's liveness flips, and both of those
 * show up here within a heartbeat. */
export function useClusterTopology() {
	return useQuery({
		queryKey: TOPOLOGY_QUERY,
		queryFn: clusterService.topology,
		refetchInterval: 15000,
	});
}

export function useClusterNodes() {
	const qc = useQueryClient();
	const invalidate = () => {
		qc.invalidateQueries({ queryKey: NODES_QUERY });
		// Linking, unlinking or flagging a node changes who is in the picture.
		qc.invalidateQueries({ queryKey: TOPOLOGY_QUERY });
	};

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
					description: enroll.synced
						? `Node joined and applied ${enroll.synced} change(s).`
						: "Node joined; nothing to catch up on.",
				});
			} else if (enroll?.status === "error") {
				toast.warning("Node linked, but enrollment failed", {
					description:
						enroll.reason ?? "The node could not be reached to enroll.",
				});
			} else {
				toast.success("Node linked");
			}
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't link node", { description: errorMessage(err) }),
	});

	const unlink = useMutation({
		mutationFn: (nodeId: number) => clusterService.unlinkNode(nodeId),
		onSuccess: () => {
			toast.success("Node unlinked");
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't unlink node", { description: errorMessage(err) }),
	});

	const update = useMutation({
		mutationFn: ({ id, patch }: { id: number; patch: ClusterNodeUpdate }) =>
			clusterService.updateNode(id, patch),
		onSuccess: () => {
			// These change the *input* to the leader computation, not its output --
			// the operator re-tiers when they're ready, or the drift counter gets
			// there on its own.
			toast.success("Node updated", {
				description: "Re-tier to apply it to the topology.",
			});
			invalidate();
		},
		onError: (err) =>
			toast.error("Couldn't update node", { description: errorMessage(err) }),
	});

	return { list, link, unlink, update };
}

/** Manual re-tiering (§5.4 trigger 1): always available on the master, always
 * wins. Invalidates both queries because a new generation rewrites every node's
 * derived role at once. */
export function useRetier() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => clusterService.retier(),
		onSuccess: (res) => {
			toast.success(
				`Cluster re-tiered (generation ${res.tiering?.generation ?? "?"})`,
			);
			qc.invalidateQueries({ queryKey: NODES_QUERY });
			qc.invalidateQueries({ queryKey: SELF_QUERY });
			qc.invalidateQueries({ queryKey: TOPOLOGY_QUERY });
		},
		onError: (err) =>
			toast.error("Couldn't re-tier", { description: errorMessage(err) }),
	});
}

/** Operator promotion (§5.5): the way out of degraded mode, and the only one.
 * Deliberately not automatic — see the doc comment on clusterService.promote. */
export function usePromote() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ confirm, force }: { confirm: string; force?: boolean }) =>
			clusterService.promote(confirm, force),
		onSuccess: (res) => {
			toast.success(
				`This node is now master (generation ${res.tiering.generation})`,
			);
			qc.invalidateQueries({ queryKey: NODES_QUERY });
			qc.invalidateQueries({ queryKey: SELF_QUERY });
			qc.invalidateQueries({ queryKey: TOPOLOGY_QUERY });
		},
		onError: (err) =>
			toast.error("Couldn't promote", { description: errorMessage(err) }),
	});
}

export function useClusterToken() {
	const reveal = useMutation({
		mutationFn: () => clusterService.revealToken(),
		onError: (err) =>
			toast.error("Couldn't reveal token", { description: errorMessage(err) }),
	});

	const rotate = useMutation({
		mutationFn: () => clusterService.rotateToken(),
		onSuccess: () => toast.success("Cluster token rotated"),
		onError: (err) =>
			toast.error("Couldn't rotate token", { description: errorMessage(err) }),
	});

	return { reveal, rotate };
}
