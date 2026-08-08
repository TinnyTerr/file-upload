import { Crown, Network, Server, ServerOff, Share2 } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import { useClusterTopology } from "../hooks/useCluster";
import {
	layoutTopology,
	NODE_H,
	NODE_W,
	type PlacedEdge,
} from "../lib/topologyLayout";
import type { ClusterTopology, TopologyNode } from "../types";

/**
 * The cluster, drawn: master on top, each region a column of its leader and
 * that leader's followers, and a line for every change-log pull.
 *
 * Every edge here is one the server computed with `upstreamOf()` — the same
 * function `pullTargets()` runs — so what is drawn is what the cluster does,
 * including the two things a table makes you infer: a follower that has fallen
 * back to the master because its leader went quiet, and a node the current
 * generation has never seen, which replicates with nobody at all.
 */

/** A gentle S-curve from a child's top edge to its parent's bottom edge. Two
 * boxes in the same column get a straight line out of it for free. */
function edgePath(e: PlacedEdge): string {
	const midY = (e.y1 + e.y2) / 2;
	return `M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}`;
}

function roleIcon(node: TopologyNode) {
	if (!node.reachable) return ServerOff;
	if (node.role === "master") return Crown;
	if (node.role === "leader") return Network;
	return Server;
}

function roleLabel(node: TopologyNode): string {
	if (!node.role) return "untiered";
	if (node.role === "leader") return "region leader";
	return node.role;
}

function NodeBox({ node }: { node: TopologyNode }) {
	const Icon = roleIcon(node);
	const total = node.disk_total_bytes;
	const usedPct =
		total > 0 ? Math.min(100, (node.used_bytes / total) * 100) : 0;
	return (
		<div
			className={cn(
				"flex h-full w-full flex-col justify-between rounded-lg border bg-card p-2.5 shadow-sm",
				node.reachable
					? "border-border"
					: "border-dashed border-destructive/50 bg-destructive/5",
				node.role === "master" && "border-primary/50",
				node.is_self && "ring-2 ring-primary/40",
			)}
			title={[
				node.name,
				node.node_id,
				node.base_url,
				`${roleLabel(node)}${node.region ? ` · region ${node.region}` : ""}`,
				node.reachable
					? `heartbeat ${relativeTime(node.last_heartbeat_at)}`
					: "unreachable from this node",
				node.rtt_ms !== null ? `${node.rtt_ms} ms` : null,
				node.replication_mode,
			]
				.filter(Boolean)
				.join("\n")}
		>
			<div className="flex items-center gap-1.5">
				<Icon
					className={cn(
						"size-3.5 shrink-0",
						node.role === "master"
							? "text-primary"
							: node.reachable
								? "text-muted-foreground"
								: "text-destructive",
					)}
				/>
				<span className="min-w-0 flex-1 truncate text-xs font-medium">
					{node.name}
				</span>
				{node.is_self && (
					<span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
						you
					</span>
				)}
			</div>
			<p className="truncate text-[10px] text-muted-foreground">
				{roleLabel(node)}
				{node.region ? ` · ${node.region}` : ""}
				{node.pinned ? " · pinned" : ""}
				{node.eligible === false ? " · not a candidate" : ""}
			</p>
			{total > 0 ? (
				<div className="space-y-1">
					<div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
						<div
							className="h-full rounded-full bg-primary/60"
							style={{ width: `${usedPct}%` }}
						/>
					</div>
					<p className="truncate text-[10px] text-muted-foreground/80">
						{formatBytes(node.used_bytes)} of {formatBytes(total)}
						{node.rtt_ms ? ` · ${node.rtt_ms} ms` : ""}
					</p>
				</div>
			) : (
				<p className="truncate text-[10px] text-muted-foreground/80">
					{node.reachable ? "capacity unknown" : "unreachable"}
				</p>
			)}
		</div>
	);
}

function LegendDot({ className, label }: { className: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5">
			<span className={cn("inline-block h-0 w-5 border-t-2", className)} />
			{label}
		</span>
	);
}

/** The drawing itself, split out from the card so it can be rendered from a
 * topology object alone — no query, no provider. */
export function TopologyDiagram({ topology }: { topology: ClusterTopology }) {
	const layout = layoutTopology(topology);
	return (
		<div className="overflow-x-auto pb-1">
			<div
				className="relative"
				style={{ width: layout.width, height: layout.height }}
			>
				<svg
					className="absolute inset-0"
					width={layout.width}
					height={layout.height}
					aria-hidden="true"
				>
					<title>Cluster replication topology</title>
					{layout.bands.map((band) => (
						<g key={band.region}>
							<rect
								x={band.x}
								y={band.y}
								width={band.width}
								height={band.height}
								rx={12}
								className="fill-secondary/30 stroke-border"
								strokeDasharray="4 4"
							/>
							<text
								x={band.x + 10}
								y={band.y + 14}
								className="fill-muted-foreground text-[10px]"
							>
								region {band.region}
							</text>
						</g>
					))}
					{layout.edges.map((edge) => (
						<path
							key={edge.id}
							d={edgePath(edge)}
							fill="none"
							strokeWidth={1.5}
							strokeDasharray={edge.fallback ? "5 4" : undefined}
							className={
								edge.fallback ? "stroke-warning" : "stroke-muted-foreground/50"
							}
						/>
					))}
				</svg>
				{layout.nodes.map((placed) => (
					<div
						key={placed.node.node_id}
						className="absolute"
						style={{
							left: placed.x,
							top: placed.y,
							width: NODE_W,
							height: NODE_H,
						}}
					>
						<NodeBox node={placed.node} />
					</div>
				))}
			</div>
		</div>
	);
}

export function TopologyCard() {
	const { data, isLoading } = useClusterTopology();
	const hasFallback = !!data?.nodes.some((n) => n.fell_back);
	const untiered = data?.nodes.filter((n) => !n.role) ?? [];

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Share2 className="size-4 text-primary" />
					Topology
				</CardTitle>
				<CardDescription>
					Who pulls the change log from whom, as this node sees it. Every line
					is a replication edge: entries travel down it to the child and back up
					it to the parent.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{isLoading || !data ? (
					<Skeleton className="h-48 w-full" />
				) : (
					<>
						<TopologyDiagram topology={data} />
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
							<LegendDot
								className="border-muted-foreground/50"
								label="replication edge"
							/>
							<LegendDot
								className="border-dashed border-warning"
								label="fallback to master (leader unreachable)"
							/>
							<span className="flex items-center gap-1.5">
								<span className="inline-block size-3 rounded border border-dashed border-destructive/60 bg-destructive/10" />
								unreachable from here
							</span>
							<span className="flex items-center gap-1.5">
								<span className="inline-block size-3 rounded border border-border ring-2 ring-primary/40" />
								this server
							</span>
						</div>
						{data.generation === 0 ? (
							<p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
								No tiering generation yet, so there is no topology to draw —
								this node has no upstream and is not replicating.
							</p>
						) : (
							<p className="text-xs text-muted-foreground/80">
								Generation {data.generation}
								{data.reason ? ` (${data.reason})` : ""}
								{data.computed_at
									? ` · computed ${relativeTime(data.computed_at)}`
									: ""}
							</p>
						)}
						{untiered.length > 0 && (
							<p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
								{untiered.map((n) => n.name).join(", ")}{" "}
								{untiered.length === 1 ? "is" : "are"} not in generation{" "}
								{data.generation} yet — drawn unconnected because a node the
								snapshot has never seen has no upstream. Re-tier to admit{" "}
								{untiered.length === 1 ? "it" : "them"}.
							</p>
						)}
						{hasFallback && (
							<p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
								A follower is pulling from the master because its region leader
								is unreachable. Replication still works — the leader is a relay,
								not an authority — but that hop is doing the leader's job.
							</p>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
