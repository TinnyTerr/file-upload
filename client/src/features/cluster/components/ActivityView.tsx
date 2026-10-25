import { Activity } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { useClusterNodes } from "../hooks/useCluster";
import { useClusterActivity } from "../hooks/useClusterActivity";
import type { ActivityStore } from "../lib/activityStore";
import type {
	ActivityComponent,
	ActivityJob,
	ActivitySpan,
	FinishedSpan,
} from "../types";

/** How long a finished request keeps its row (and edges) on the diagram. */
const LINGER_MS = 4000;
const ROW_H = 28;
const GAP = 6;
const W = 980;
const COL = {
	peerX: 0,
	peerW: 190,
	midX: 300,
	midW: 340,
	compX: 760,
	compW: 220,
};

const COMPONENTS: { id: ActivityComponent; label: string }[] = [
	{ id: "db", label: "SQLite" },
	{ id: "disk", label: "Blob storage" },
	{ id: "events", label: "Event bus" },
	{ id: "qbittorrent", label: "qBittorrent" },
	{ id: "realdebrid", label: "Real-Debrid" },
];

interface Row {
	key: string;
	y: number;
	label: string;
	sub: string;
	state: "running" | "waiting" | "done" | "failed";
	/** 0–1 progress toward the next run, for jobs. */
	frac?: number;
	touches: ActivityComponent[];
	/** Peer this row talks to, and which way. */
	peer?: string;
	dir?: "in" | "out";
}

function secs(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 120) return `${Math.round(s)}s`;
	return `${Math.round(s / 60)}m`;
}

function jobRow(j: ActivityJob, y: number, now: number): Row {
	const remaining = j.nextDueAt - now;
	const failed = !j.running && j.lastOk === false;
	return {
		key: `job:${j.id}`,
		y,
		label: j.id,
		sub: j.running
			? `running ${secs(now - (j.lastStartAt ?? now))}`
			: failed
				? `failed · next ${secs(remaining)}`
				: `next ${secs(remaining)}${j.lastMs != null ? ` · last ${Math.round(j.lastMs)}ms` : ""}`,
		state: j.running ? "running" : failed ? "failed" : "waiting",
		frac: Math.min(1, Math.max(0, 1 - remaining / j.intervalMs)),
		touches: j.touches,
	};
}

function spanRow(sp: ActivitySpan | FinishedSpan, y: number, now: number): Row {
	const fin = "endedAt" in sp ? sp : null;
	return {
		key: `span:${sp.id}`,
		y,
		label: sp.name,
		sub: fin
			? `${fin.ok ? "" : "✗ "}${fin.detail ?? ""} ${Math.round(fin.ms)}ms`
			: `${secs(now - sp.startedAt)}${sp.cause ? ` · from ${sp.cause}` : ""}`,
		state: fin ? (fin.ok ? "done" : "failed") : "running",
		touches: sp.touches,
		peer: sp.peer,
		dir: sp.kind === "in" ? "in" : "out",
	};
}

function edge(x1: number, y1: number, x2: number, y2: number): string {
	const mx = (x1 + x2) / 2;
	return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function Diagram({ store, now }: { store: ActivityStore; now: number }) {
	const nodes = useClusterNodes().list.data ?? [];
	const hostName = new Map<string, string>();
	for (const n of nodes) {
		try {
			hostName.set(new URL(n.base_url).host, n.name);
		} catch {
			// unparseable url: unlabelled
		}
	}

	const jobs = [...store.jobs.values()];
	let y = 24;
	const jobRows: Row[] = jobs.map((j) => {
		const r = jobRow(j, y, now);
		y += ROW_H + GAP;
		return r;
	});

	// Requests: live ones, plus those that finished within the linger window.
	const reqSpans: (ActivitySpan | FinishedSpan)[] = [
		...[...store.open.values()].filter((s) => s.kind !== "job"),
		...store.recent.filter(
			(s) => s.kind !== "job" && now - s.endedAt < LINGER_MS,
		),
	].slice(0, 10);
	y += 28;
	const reqTop = y;
	const reqRows: Row[] = reqSpans.map((s) => {
		const r = spanRow(s, y, now);
		y += ROW_H + GAP;
		return r;
	});
	const height = Math.max(y + 8, 24 + COMPONENTS.length * (ROW_H + 14) + 8);

	// Peers: every linked node, plus any host seen on a request.
	const peerSet = new Set<string>(hostName.keys());
	for (const r of reqRows) if (r.peer) peerSet.add(r.peer);
	const peers = [...peerSet];
	const peerY = new Map<string, number>();
	for (const [i, p] of peers.entries()) peerY.set(p, 24 + i * (ROW_H + 14));

	const compGap = Math.max(
		ROW_H + 14,
		(height - 40) / Math.max(1, COMPONENTS.length),
	);
	const compY = new Map<ActivityComponent, number>();
	for (const [i, c] of COMPONENTS.entries()) compY.set(c.id, 24 + i * compGap);

	const midR = COL.midX + COL.midW;
	const edges: { d: string; on: boolean; bad: boolean; key: string }[] = [];
	for (const r of [...jobRows, ...reqRows]) {
		const live = r.state === "running";
		const bad = r.state === "failed";
		const on = live || r.state === "done" || bad;
		const cy = r.y + ROW_H / 2;
		for (const c of r.touches) {
			const ty = compY.get(c);
			if (ty === undefined) continue;
			edges.push({
				d: edge(midR, cy, COL.compX, ty + ROW_H / 2),
				on,
				bad,
				key: `${r.key}>${c}`,
			});
		}
		if (r.peer) {
			const py = peerY.get(r.peer);
			if (py !== undefined) {
				const px = COL.peerX + COL.peerW;
				edges.push({
					d:
						r.dir === "in"
							? edge(px, py + ROW_H / 2, COL.midX, cy)
							: edge(COL.midX, cy, px, py + ROW_H / 2),
					on,
					bad,
					key: `${r.key}~${r.peer}`,
				});
			}
		}
	}
	// A job that is mid-call to a peer: draw job → peer for each open call.
	for (const sp of store.open.values()) {
		if (sp.kind !== "out" || !sp.cause || !sp.peer) continue;
		const jr = jobRows.find((r) => r.label === sp.cause);
		const py = peerY.get(sp.peer);
		if (!jr || py === undefined) continue;
		edges.push({
			d: edge(
				COL.midX,
				jr.y + ROW_H / 2,
				COL.peerX + COL.peerW,
				py + ROW_H / 2,
			),
			on: true,
			bad: false,
			key: `job:${jr.label}~${sp.id}`,
		});
	}

	const active = (r: Row) => r.state === "running";

	return (
		<svg
			viewBox={`0 0 ${W} ${height}`}
			className="w-full"
			role="img"
			aria-label="Live view of this server's jobs and cluster requests"
		>
			<title>Cluster activity</title>
			{/* edges first so rows sit on top */}
			{edges
				.filter((e) => !e.on)
				.map((e) => (
					<path
						key={e.key}
						d={e.d}
						fill="none"
						className="stroke-border"
						strokeWidth={1}
						opacity={0.35}
					/>
				))}
			{edges
				.filter((e) => e.on)
				.map((e) => (
					<path
						key={e.key}
						d={e.d}
						fill="none"
						className={e.bad ? "stroke-destructive" : "stroke-primary"}
						strokeWidth={1.75}
						strokeDasharray="5 5"
					>
						<animate
							attributeName="stroke-dashoffset"
							from="10"
							to="0"
							dur="0.6s"
							repeatCount="indefinite"
						/>
					</path>
				))}

			<text x={COL.peerX} y={12} className="fill-muted-foreground text-[11px]">
				PEERS
			</text>
			<text x={COL.midX} y={12} className="fill-muted-foreground text-[11px]">
				THIS NODE · SCHEDULED JOBS
			</text>
			<text x={COL.compX} y={12} className="fill-muted-foreground text-[11px]">
				COMPONENTS
			</text>
			<text
				x={COL.midX}
				y={reqTop - 12}
				className="fill-muted-foreground text-[11px]"
			>
				REQUESTS (IN ← / OUT →)
			</text>

			{peers.map((p) => {
				const py = peerY.get(p) ?? 0;
				const busy = reqRows.some((r) => r.peer === p && active(r));
				return (
					<g key={p}>
						<rect
							x={COL.peerX}
							y={py}
							width={COL.peerW}
							height={ROW_H}
							rx={6}
							className={cn(
								"fill-card",
								busy ? "stroke-primary" : "stroke-border",
							)}
						/>
						<text
							x={COL.peerX + 10}
							y={py + 18}
							className="fill-foreground text-[11px]"
						>
							{hostName.get(p) ?? p}
						</text>
					</g>
				);
			})}

			{COMPONENTS.map((c) => {
				const cy = compY.get(c.id) ?? 0;
				const busy = [...jobRows, ...reqRows].some(
					(r) => active(r) && r.touches.includes(c.id),
				);
				return (
					<g key={c.id}>
						<rect
							x={COL.compX}
							y={cy}
							width={COL.compW}
							height={ROW_H}
							rx={6}
							className={cn(
								busy
									? "fill-primary/15 stroke-primary"
									: "fill-card stroke-border",
							)}
						/>
						<text
							x={COL.compX + 10}
							y={cy + 18}
							className="fill-foreground text-[11px]"
						>
							{c.label}
						</text>
					</g>
				);
			})}

			{[...jobRows, ...reqRows].map((r) => (
				<g key={r.key}>
					<rect
						x={COL.midX}
						y={r.y}
						width={COL.midW}
						height={ROW_H}
						rx={6}
						className={cn(
							r.state === "running" && "fill-primary/15 stroke-primary",
							r.state === "failed" && "fill-destructive/10 stroke-destructive",
							(r.state === "waiting" || r.state === "done") &&
								"fill-card stroke-border",
						)}
					/>
					{r.frac !== undefined && r.state !== "running" && (
						<rect
							x={COL.midX + 1}
							y={r.y + ROW_H - 3}
							width={Math.max(0, (COL.midW - 2) * r.frac)}
							height={2}
							rx={1}
							className="fill-primary/50"
						/>
					)}
					<text
						x={COL.midX + 10}
						y={r.y + 18}
						className="fill-foreground text-[11px]"
					>
						{r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label}
					</text>
					<text
						x={COL.midX + COL.midW - 10}
						y={r.y + 18}
						textAnchor="end"
						className={cn(
							"text-[10px]",
							r.state === "failed"
								? "fill-destructive"
								: "fill-muted-foreground",
						)}
					>
						{r.sub}
					</text>
				</g>
			))}
			{reqRows.length === 0 && (
				<text
					x={COL.midX + 10}
					y={reqTop + 18}
					className="fill-muted-foreground text-[11px]"
				>
					no requests in the last few seconds
				</text>
			)}
		</svg>
	);
}

function RecentLog({ items, now }: { items: FinishedSpan[]; now: number }) {
	if (!items.length) {
		return (
			<p className="text-xs text-muted-foreground/70">Nothing finished yet.</p>
		);
	}
	return (
		<ul className="divide-y divide-border/50 font-mono text-xs">
			{items.slice(0, 40).map((s) => (
				<li key={s.id} className="flex items-center gap-3 py-1">
					<span className="w-14 shrink-0 text-muted-foreground">
						{secs(now - s.endedAt)} ago
					</span>
					<Badge variant="outline" className="w-9 justify-center">
						{s.kind === "job" ? "job" : s.kind === "in" ? "in" : "out"}
					</Badge>
					<span className="min-w-0 flex-1 truncate">{s.name}</span>
					<span className="hidden truncate text-muted-foreground sm:block">
						{s.peer ?? ""}
					</span>
					<span
						className={cn(
							"w-20 shrink-0 text-right",
							s.ok ? "text-muted-foreground" : "text-destructive",
						)}
					>
						{s.ok ? "" : "✗ "}
						{s.detail && !s.ok ? `${s.detail} ` : ""}
						{Math.round(s.ms)}ms
					</span>
				</li>
			))}
		</ul>
	);
}

export function ActivityView() {
	// Off until asked for: the server only traces while a socket is open, so
	// this switch is the performance switch.
	const [live, setLive] = useState(true);
	const { store, conn } = useClusterActivity(live);
	const now = Date.now() + store.offset;

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<div>
							<CardTitle className="flex items-center gap-2">
								<Activity className="size-4 text-primary" />
								Live activity
							</CardTitle>
							<CardDescription>
								What this node is running and which peers and components each
								piece touches. Components are what the work is known to use, not
								measured calls. The server traces only while this tab is open
								and Live is on.
							</CardDescription>
						</div>
						<label className="flex shrink-0 items-center gap-2 text-sm">
							<Badge
								variant={conn === "live" ? "default" : "outline"}
								className="tabular-nums"
							>
								{conn === "live" ? "live" : conn === "off" ? "paused" : conn}
							</Badge>
							<Switch checked={live} onCheckedChange={setLive} />
						</label>
					</div>
				</CardHeader>
				<CardContent>
					{conn === "off" ? (
						<p className="py-8 text-center text-sm text-muted-foreground">
							Paused. Nothing is being traced on the server.
						</p>
					) : store.jobs.size === 0 ? (
						<p className="py-8 text-center text-sm text-muted-foreground">
							Waiting for the first snapshot…
						</p>
					) : (
						<Diagram store={store} now={now} />
					)}
				</CardContent>
			</Card>

			{conn !== "off" && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Recently finished</CardTitle>
					</CardHeader>
					<CardContent>
						<RecentLog items={store.recent} now={now} />
					</CardContent>
				</Card>
			)}
		</div>
	);
}
