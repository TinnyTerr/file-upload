import { AlertTriangle, Check, GitMerge, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatDate } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { useConflicts } from "../hooks/useCluster";
import type { ReplicationConflict } from "../types";

/**
 * The Conflicts view (§5.8).
 *
 * Two nodes can both accept an edit to the same row — nothing but quota is
 * gated on the write path — and when they do, the master picks a winner by
 * timestamp (node id breaking the tie). This is where the edit that *lost*
 * shows up, which is the entire point: the old behaviour was an undocumented
 * "whoever pushed last wins" with no record that anything had been overwritten.
 *
 * Nothing here changes the verdict. Re-apply writes the losing edit again, as
 * a new change on top of the winner — it wins because it is now the later one,
 * not because the arbitration was rerun.
 */

/** The columns worth showing at a glance. A payload carries every replicated
 * column, and dumping forty of them buries the one that differs. */
const HEADLINE_FIELDS = [
	"title",
	"original_filename",
	"username",
	"slug",
	"active",
	"role",
	"lifecycle_state",
	"expires_at",
	"max_uses",
	"quota_bytes",
];

function payloadSummary(raw: string): Array<[string, string]> {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown> | null;
	} catch {
		return [];
	}
	if (!parsed) return [];
	const headline = HEADLINE_FIELDS.filter((f) => parsed[f] !== undefined).map(
		(f) => [f, String(parsed[f] ?? "—")] as [string, string],
	);
	if (headline.length > 0) return headline;
	// Nothing recognisable: show the first few columns rather than nothing.
	return Object.entries(parsed)
		.slice(0, 4)
		.map(([k, v]) => [k, String(v ?? "—")] as [string, string]);
}

function Side({
	label,
	node,
	ts,
	tone,
	children,
}: {
	label: string;
	node: string;
	ts: string;
	tone: "win" | "lose";
	children?: React.ReactNode;
}) {
	return (
		<div
			className={
				tone === "win"
					? "min-w-0 flex-1 rounded-lg border border-success/40 bg-success/5 p-3"
					: "min-w-0 flex-1 rounded-lg border border-border bg-secondary/20 p-3"
			}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={tone === "win" ? "success" : "secondary"}>
					{label}
				</Badge>
				<span className="truncate font-mono text-xs">{node}</span>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">{formatDate(ts)}</p>
			{children}
		</div>
	);
}

function ConflictCard({
	conflict,
	onDismiss,
	onReapply,
	busy,
}: {
	conflict: ReplicationConflict;
	onDismiss: () => void;
	onReapply: () => void;
	busy: boolean;
}) {
	const summary = payloadSummary(conflict.losing_payload);
	const resolved = !!conflict.dismissed_at;
	return (
		<li className="space-y-3 rounded-lg border border-border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<GitMerge className="size-4 shrink-0 text-warning" />
				<span className="text-sm font-medium">{conflict.table_name}</span>
				<span className="truncate font-mono text-xs text-muted-foreground">
					{conflict.row_uid}
				</span>
				{conflict.losing_op === "delete" && (
					<Badge variant="warning">a delete lost</Badge>
				)}
				{resolved && <Badge variant="secondary">resolved</Badge>}
			</div>

			<div className="flex flex-col gap-2 sm:flex-row">
				<Side
					label="kept"
					node={conflict.winner_node}
					ts={conflict.winning_ts}
					tone="win"
				>
					<p className="mt-1 text-xs text-muted-foreground/80">
						ordered at master_seq {conflict.winning_master_seq}
					</p>
				</Side>
				<Side
					label="overwritten"
					node={conflict.origin_node}
					ts={conflict.losing_ts}
					tone="lose"
				>
					{summary.length > 0 && (
						<dl className="mt-2 space-y-0.5">
							{summary.map(([k, v]) => (
								<div key={k} className="flex gap-2 text-xs">
									<dt className="shrink-0 text-muted-foreground">{k}</dt>
									<dd className="min-w-0 truncate font-mono">{v}</dd>
								</div>
							))}
						</dl>
					)}
				</Side>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground/70">
					detected {formatDate(conflict.detected_at)}
				</span>
				<div className="flex-1" />
				{!resolved && (
					<>
						{conflict.losing_op === "upsert" && (
							<Button
								variant="outline"
								size="sm"
								onClick={onReapply}
								disabled={busy}
							>
								<RotateCcw /> Re-apply
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={onDismiss}
							disabled={busy}
						>
							<Check /> Dismiss
						</Button>
					</>
				)}
			</div>
		</li>
	);
}

export function ConflictsTab() {
	const [includeDismissed, setIncludeDismissed] = useState(false);
	const { list, dismiss, reapply } = useConflicts(includeDismissed);
	const { confirm } = useDialogs();

	const onReapply = async (conflict: ReplicationConflict) => {
		const ok = await confirm({
			title: "Re-apply this edit?",
			description:
				"The overwritten values are written again now, as a new change on top of the winner — it takes effect everywhere and the edit that currently stands is replaced.",
			confirmText: "Re-apply",
		});
		if (ok) reapply.mutate(conflict.id);
	};

	const busy = dismiss.isPending || reapply.isPending;
	const conflicts = list.data?.conflicts ?? [];

	return (
		<Card>
			<CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
				<div>
					<CardTitle className="flex items-center gap-2">
						<GitMerge className="size-4 text-primary" />
						Replication conflicts
					</CardTitle>
					<CardDescription>
						Two nodes edited the same row at once. The master kept the later
						edit — node id breaking an exact tie — and the one it displaced is
						recorded here rather than silently lost.
						{list.data ? ` Arbitrated by ${list.data.node_id}.` : ""}
					</CardDescription>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Switch
						id="show-dismissed"
						checked={includeDismissed}
						onCheckedChange={setIncludeDismissed}
					/>
					<Label htmlFor="show-dismissed" className="text-xs">
						Show resolved
					</Label>
				</div>
			</CardHeader>
			<CardContent>
				{list.isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-28 w-full" />
						<Skeleton className="h-28 w-full" />
					</div>
				) : list.isError ? (
					<div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
						<AlertTriangle className="size-4 shrink-0 text-warning" />
						<span>
							Conflicts are recorded on the master, and it can't be reached from
							here right now.
						</span>
					</div>
				) : conflicts.length === 0 ? (
					<EmptyState
						icon={Undo2}
						title={includeDismissed ? "No conflicts" : "No open conflicts"}
						description="Nothing has been overwritten by a concurrent edit. This is the normal state — a conflict needs two nodes editing one row inside a replication interval."
					/>
				) : (
					<ul className="space-y-3">
						{conflicts.map((conflict) => (
							<ConflictCard
								key={conflict.id}
								conflict={conflict}
								busy={busy}
								onDismiss={() => dismiss.mutate(conflict.id)}
								onReapply={() => onReapply(conflict)}
							/>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}
