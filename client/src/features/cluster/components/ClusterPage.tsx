import {
	AlertTriangle,
	Archive,
	Crown,
	Database,
	Eye,
	HardDrive,
	Network,
	PauseCircle,
	Pin,
	Plus,
	Radio,
	RefreshCw,
	RotateCcw,
	Server,
	ShieldCheck,
	ShieldOff,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/bytes";
import { formatDate, relativeTime } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import {
	useClusterNodes,
	useClusterSelf,
	useClusterToken,
	usePromote,
	useRetier,
} from "../hooks/useCluster";
import type { ClusterHalt, ClusterSelf, NodeRole } from "../types";
import { TopologyCard } from "./TopologyCard";

function haltLabel(scope: string): string {
	if (scope === "global") return "All uploads halted";
	if (scope.startsWith("user:"))
		return `Uploads halted for user ${scope.slice(5)}`;
	return `Halted: ${scope}`;
}

/** Tier 0 quota + write-ordering authority, tier 1 relay/cache, tier 2. Never
 * self-asserted — the master computes it and every node derives the same
 * answer from the same generation. */
function RoleBadge({ role }: { role: NodeRole }) {
	if (role === "master") {
		return (
			<Badge variant="default" className="gap-1">
				<Crown className="size-3" /> master
			</Badge>
		);
	}
	if (role === "leader") {
		return (
			<Badge variant="secondary" className="gap-1">
				<Network className="size-3" /> region leader
			</Badge>
		);
	}
	return <Badge variant="outline">follower</Badge>;
}

function ThisServerCard() {
	const { data, isLoading } = useClusterSelf();
	const retier = useRetier();
	return (
		<Card>
			<CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
				<div>
					<CardTitle className="flex items-center gap-2">
						<Database className="size-4 text-primary" />
						This server
					</CardTitle>
					<CardDescription>
						This node's identity, tier, capacity and any active upload halts.
					</CardDescription>
				</div>
				{data?.is_master && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => retier.mutate()}
						loading={retier.isPending}
					>
						<RefreshCw /> Re-tier
					</Button>
				)}
			</CardHeader>
			<CardContent className="space-y-3">
				{isLoading || !data ? (
					<Skeleton className="h-20 w-full" />
				) : (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium">{data.name}</span>
							<RoleBadge role={data.role} />
							{data.region && (
								<Badge variant="outline">region {data.region}</Badge>
							)}
							<Badge
								variant={data.archive_enabled ? "success" : "secondary"}
								className="gap-1"
							>
								<Archive className="size-3" /> archival{" "}
								{data.archive_enabled ? "on" : "off"}
							</Badge>
							<Badge variant="outline">{data.replication_mode}</Badge>
						</div>
						<p className="font-mono text-xs text-muted-foreground">
							{data.node_id}
						</p>
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<HardDrive className="size-4" />
							{formatBytes(data.used_bytes)} stored ·{" "}
							{formatBytes(data.disk_free_bytes)} free of{" "}
							{formatBytes(data.disk_total_bytes)}
						</div>
						<TieringLine
							generation={data.tiering_generation}
							masterNodeId={data.master_node_id}
							isMaster={data.is_master}
							drift={data.drift}
							outstanding={data.outstanding_reservations}
						/>
						<IdentityLine identity={data.identity} />
						<HaltList halts={data.halts} />
					</>
				)}
			</CardContent>
		</Card>
	);
}

function TieringLine({
	generation,
	masterNodeId,
	isMaster,
	drift,
	outstanding,
}: {
	generation: number;
	masterNodeId: string | null;
	isMaster: boolean;
	drift: { changes: number; threshold: number; pending: number } | null;
	/** Writes the master has admitted whose file rows do not exist yet. Null off
	 * the master, which holds no ledger. */
	outstanding: number | null;
}) {
	// Generation 0 means this node has never been tiered, which is not cosmetic:
	// it has no upstream, so it replicates with nobody until a master admits it.
	if (generation === 0) {
		return (
			<p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs">
				Not yet tiered — this node has no upstream and is not replicating. Link
				it to a master, or set <code>NODE_ROLE=master</code> to bootstrap one.
			</p>
		);
	}
	return (
		<p className="text-xs text-muted-foreground">
			Tiering generation {generation}
			{masterNodeId && !isMaster ? ` · master ${masterNodeId}` : ""}
			{drift
				? ` · drift ${drift.changes}/${drift.threshold}${
						drift.pending ? ` (${drift.pending} in hold-down)` : ""
					}`
				: ""}
			{outstanding
				? ` · ${outstanding} write(s) admitted, not yet written`
				: ""}
		</p>
	);
}

/** §5.10: password hashes and TOTP seeds are fetched at first login rather than
 * replicated, so what this node can authenticate offline is a fact worth
 * showing — it is exactly the set of users who have signed in here. A stale
 * count is not an error: it means a credential changed elsewhere and the next
 * login on this node will refetch. */
function IdentityLine({ identity }: { identity: ClusterSelf["identity"] }) {
	if (!identity || identity.users_total === 0) return null;
	return (
		<p className="text-xs text-muted-foreground">
			Credential material for {identity.material_held} of {identity.users_total}{" "}
			user{identity.users_total === 1 ? "" : "s"}
			{identity.material_stale
				? ` · ${identity.material_stale} awaiting refetch`
				: ""}
		</p>
	);
}

function HaltList({ halts }: { halts: ClusterHalt[] }) {
	if (!halts.length) {
		return (
			<p className="text-xs text-muted-foreground/70">
				No active upload halts.
			</p>
		);
	}
	return (
		<ul className="space-y-1">
			{halts.map((h) => (
				<li
					key={h.scope}
					className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs"
				>
					<PauseCircle className="size-3.5 text-warning" />
					<span>{haltLabel(h.scope)}</span>
					<span className="text-muted-foreground">
						· until {new Date(h.until * 1000).toLocaleTimeString()}
					</span>
				</li>
			))}
		</ul>
	);
}

function LocalTokenCard() {
	const { reveal, rotate } = useClusterToken();
	const { confirm } = useDialogs();
	const [token, setToken] = useState<string | null>(null);

	const onReveal = async () => setToken(await reveal.mutateAsync());

	const onRotate = async () => {
		const ok = await confirm({
			title: "Rotate cluster token?",
			description:
				"The current token stops working immediately. Every node and monitor subscribed to this server's firehose must be updated with the new token.",
			confirmText: "Rotate",
			destructive: true,
		});
		if (ok) setToken(await rotate.mutateAsync());
	};

	return (
		<Card className="border-destructive/30 bg-destructive/5">
			<CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
				<div>
					<CardTitle className="flex items-center gap-2">
						<ShieldCheck className="size-4 text-destructive" />
						This server's cluster token
					</CardTitle>
					<CardDescription>
						Hand this token to another node so it can subscribe to our event
						firehose. It grants read access to <strong>every</strong> event on
						this server — treat it like a root credential.
					</CardDescription>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				{token ? (
					<div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-3">
						<code className="min-w-0 flex-1 truncate font-mono text-sm">
							{token}
						</code>
						<CopyButton value={token} />
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						The token is hidden. Reveal it to copy, or rotate to generate a
						fresh one.
					</p>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={onReveal}
						loading={reveal.isPending}
					>
						<Eye /> Reveal token
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="text-destructive"
						onClick={onRotate}
						loading={rotate.isPending}
					>
						<RotateCcw /> Rotate token
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function LinkNodeForm({ onDone }: { onDone: () => void }) {
	const { link } = useClusterNodes();
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [token, setToken] = useState("");

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !baseUrl.trim() || !token.trim()) return;
		await link.mutateAsync({
			name: name.trim(),
			base_url: baseUrl.trim(),
			token: token.trim(),
		});
		setName("");
		setBaseUrl("");
		setToken("");
		onDone();
	};

	return (
		<form
			onSubmit={submit}
			className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4"
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="node-name">Name</Label>
					<Input
						id="node-name"
						placeholder="eu-west-1"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="node-url">Base URL</Label>
					<Input
						id="node-url"
						placeholder="https://node.example.com"
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
					/>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="node-token">Remote cluster token</Label>
				<Input
					id="node-token"
					type="password"
					placeholder="The other server's cluster token"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					className="font-mono"
				/>
			</div>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					Cancel
				</Button>
				<Button type="submit" size="sm" loading={link.isPending}>
					Link node
				</Button>
			</div>
		</form>
	);
}

function LinkedNodesCard() {
	const { list, unlink, update } = useClusterNodes();
	const { confirm } = useDialogs();
	const [adding, setAdding] = useState(false);

	const onUnlink = async (id: number, name: string) => {
		const ok = await confirm({
			title: "Unlink node?",
			description: `This server will stop trusting ${name}'s token. You can re-link it later.`,
			confirmText: "Unlink",
			destructive: true,
		});
		if (ok) unlink.mutate(id);
	};

	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
				<div>
					<CardTitle>Linked nodes</CardTitle>
					<CardDescription>
						Remote servers this node connects to. Paste another server's base
						URL and cluster token to link it.
					</CardDescription>
				</div>
				{!adding && (
					<Button size="sm" onClick={() => setAdding(true)}>
						<Plus /> Link node
					</Button>
				)}
			</CardHeader>
			<CardContent className="space-y-3">
				{adding && <LinkNodeForm onDone={() => setAdding(false)} />}
				{list.isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-14 w-full" />
						<Skeleton className="h-14 w-full" />
					</div>
				) : !list.data || list.data.length === 0 ? (
					!adding && (
						<EmptyState
							icon={Server}
							title="No linked nodes"
							description="Link another server to receive its event firehose."
						/>
					)
				) : (
					<ul className="space-y-2">
						{list.data.map((node) => (
							<li
								key={node.id}
								className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3"
							>
								<Server className="size-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate text-sm font-medium">
											{node.name}
										</span>
										{node.active ? (
											<Badge variant="success">active</Badge>
										) : (
											<Badge variant="destructive">unreachable</Badge>
										)}
										<RoleBadge role={node.role} />
										{node.region && (
											<Badge variant="outline">
												{node.region}
												{node.region_source === "configured" ? " (set)" : ""}
											</Badge>
										)}
										{node.pinned_master && (
											<Badge variant="warning" className="gap-1">
												<Pin className="size-3" /> pinned
											</Badge>
										)}
										{node.ineligible && (
											<Badge variant="secondary">not a candidate</Badge>
										)}
										<Badge
											variant={node.archive_enabled ? "success" : "secondary"}
											className="gap-1"
										>
											<Archive className="size-3" />{" "}
											{node.archive_enabled ? "archival" : "no archival"}
										</Badge>
										<Badge variant="outline">{node.replication_mode}</Badge>
									</div>
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										{node.base_url} · token {node.token_preview}
									</p>
									{node.disk_total_bytes > 0 && (
										<p className="mt-0.5 text-xs text-muted-foreground">
											{formatBytes(node.used_bytes)} stored ·{" "}
											{formatBytes(node.disk_free_bytes)} free of{" "}
											{formatBytes(node.disk_total_bytes)}
										</p>
									)}
									<p className="mt-0.5 text-xs text-muted-foreground/70">
										Linked {node.created_at ? formatDate(node.created_at) : "—"}{" "}
										· heartbeat{" "}
										{relativeTime(node.last_heartbeat_at ?? node.last_seen_at)}
										{node.rtt_ms !== null ? ` · ${node.rtt_ms} ms` : ""}
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon"
									onClick={() =>
										update.mutate({
											id: node.id,
											patch: { ineligible: !node.ineligible },
										})
									}
									aria-label={
										node.ineligible
											? `Allow ${node.name} to lead`
											: `Stop ${node.name} from leading`
									}
									title={
										node.ineligible
											? "Allow this node to be a leadership candidate"
											: "Remove this node from leadership candidacy"
									}
								>
									{node.ineligible ? <ShieldOff /> : <ShieldCheck />}
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="text-destructive"
									onClick={() => onUnlink(node.id, node.name)}
									aria-label={`Unlink node ${node.name}`}
								>
									<Trash2 />
								</Button>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function ConnectingInfoCard() {
	const origin = window.location.origin;
	const wsOrigin = origin.replace(/^http/, "ws");
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Radio className="size-4 text-primary" />
					Connecting nodes
				</CardTitle>
				<CardDescription>
					A linked node authenticates with the remote server's cluster token,
					then streams or polls its events.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 text-sm text-muted-foreground">
				<div className="space-y-1.5">
					<p className="font-medium text-foreground">
						Event firehose (WebSocket)
					</p>
					<p>
						Streams every event on the remote server. Pass the cluster token as{" "}
						<code>?token=</code> or a Bearer header.
					</p>
					<CodeLine
						value={`${wsOrigin}/admin/cluster/firehose?token=<cluster-token>`}
					/>
				</div>
				<div className="space-y-1.5">
					<p className="font-medium text-foreground">Poll events (HTTP)</p>
					<p>
						A websocket-free alternative. Pass the highest <code>id</code> seen
						as <code>?after=</code> to replay only what you missed.
					</p>
					<CodeLine value={`${origin}/admin/cluster/events?after=0`} />
				</div>
			</CardContent>
		</Card>
	);
}

function CodeLine({ value }: { value: string }) {
	return (
		<div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-2.5">
			<code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
			<CopyButton value={value} />
		</div>
	);
}

/**
 * The persistent banner §5.5 asks for: names the reason, the elapsed time, and
 * the way out.
 *
 * `grace` gets a calm warning — a master restart takes seconds and the cluster
 * is riding it out, so alarming the operator would be wrong. `degraded` gets a
 * loud one plus the promote control, because at that point nothing resolves it
 * except a human deciding the master is really gone.
 */
function MasterStatusBanner() {
	const { data } = useClusterSelf();
	const promote = usePromote();
	const { prompt } = useDialogs();
	const status = data?.master_status;
	if (!data || !status || status.phase === "ok") return null;

	const minutes = Math.floor(status.silent_ms / 60000);
	const seconds = Math.floor((status.silent_ms % 60000) / 1000);
	const elapsed = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

	const onPromote = async () => {
		const confirm = await prompt({
			title: "Promote this node to master?",
			description:
				`Type "${data.name}" to confirm. Only do this if you know the current master is genuinely gone — ` +
				"promoting while it is still running splits the cluster into two lineages that cannot be merged.",
			confirmText: "Promote",
			placeholder: data.name,
			destructive: true,
		});
		if (confirm) promote.mutate({ confirm });
	};

	if (status.phase === "grace") {
		return (
			<div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
				<AlertTriangle className="size-4 shrink-0 text-warning" />
				<span>
					Can't reach the master ({status.master_node_id ?? "unknown"}) —{" "}
					{elapsed}. Writes are being <strong>held</strong>, not failed, for the
					restart grace window.
					{status.held > 0 ? ` ${status.held} request(s) waiting.` : ""}
				</span>
			</div>
		);
	}

	return (
		<div className="space-y-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
			<div className="flex flex-wrap items-center gap-3">
				<AlertTriangle className="size-4 shrink-0 text-destructive" />
				<span>
					<strong>Degraded.</strong> No contact with the master (
					{status.master_node_id ?? "unknown"}) for {elapsed}. This node is
					read-only: downloads, previews and share links still work, but
					uploads, renames, deletes and permission changes are refused.
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				This does not resolve itself. Either the master comes back, or you
				promote a node — which is a judgement only someone who can see the
				network can make safely.
			</p>
			<Button
				variant="outline"
				size="sm"
				className="text-destructive"
				onClick={onPromote}
				loading={promote.isPending}
			>
				<Crown /> Promote this node to master
			</Button>
		</div>
	);
}

export function ClusterPage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Cluster"
				subtitle="Link this server to other nodes and manage cluster tokens."
				icon={Network}
			/>

			<MasterStatusBanner />
			<ThisServerCard />
			<TopologyCard />
			<LocalTokenCard />
			<LinkedNodesCard />
			<ConnectingInfoCard />
		</div>
	);
}
