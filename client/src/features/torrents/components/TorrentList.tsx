import {
	CloudDownload,
	Download,
	FolderOpen,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/bytes";
import { relativeTime } from "@/lib/time";
import type { TorrentJob, TorrentStatus } from "../types";

const STATUS_BADGE: Record<
	TorrentStatus,
	{ label: string; variant: "success" | "accent" | "secondary" | "destructive" }
> = {
	pending: { label: "waiting", variant: "secondary" },
	queued: { label: "queued", variant: "secondary" },
	downloading: { label: "downloading", variant: "accent" },
	fetching: { label: "transferring", variant: "accent" },
	importing: { label: "importing", variant: "accent" },
	seeding: { label: "seeding", variant: "success" },
	completed: { label: "completed", variant: "success" },
	failed: { label: "failed", variant: "destructive" },
};

/** What Real-Debrid is doing while our own status is still "queued". */
const DEBRID_PHASE: Record<string, string> = {
	magnet_conversion: "resolving the magnet…",
	waiting_files_selection: "selecting files…",
	queued: "queued on Real-Debrid…",
	compressing: "Real-Debrid is packaging the files…",
	uploading: "Real-Debrid is finishing up…",
};

function formatEta(seconds: number | null): string {
	if (!seconds || seconds <= 0) return "—";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

function transferLine(t: TorrentJob): string {
	const rate = `${formatBytes(t.dl_speed)}/s · ETA ${formatEta(t.eta_seconds)}`;
	return `${formatBytes(t.downloaded_bytes)} of ${formatBytes(t.size_bytes)} · ${rate}`;
}

function formatDuration(seconds: number | null): string {
	if (!seconds || seconds <= 0) return "0m";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
}

function importedLine(t: TorrentJob): string {
	const files = `${t.imported_file_count} file${t.imported_file_count === 1 ? "" : "s"}`;
	return `${files} · ${formatBytes(t.size_bytes)} · imported ${relativeTime(t.completed_at)}`;
}

function subtitle(t: TorrentJob): string {
	// Waiting for a slot: nothing has been sent anywhere yet, so there is no
	// progress to report — only where it sits in the queue.
	if (t.status === "pending") {
		return t.queue_position
			? `waiting for a free slot · #${t.queue_position} in your queue`
			: "waiting for a free slot…";
	}
	// The files are already in the owner's storage; this is the upload tail.
	if (t.status === "seeding") {
		const ratio = `ratio ${(t.seed_ratio ?? 0) < 0 ? 0 : (t.seed_ratio ?? 0).toFixed(2)}`;
		return `${importedLine(t)} · seeding ${formatDuration(t.seed_seconds)} · ${ratio}`;
	}
	if (t.status === "completed") return importedLine(t);
	if (t.status === "failed") return t.error ?? "failed";
	if (t.status === "importing") return "moving files into your storage…";
	// The debrid transfer leg: the torrent is already done remotely and these
	// bytes are the hop from Real-Debrid to this server.
	if (t.status === "fetching") {
		return t.size_bytes
			? `downloading from Real-Debrid · ${transferLine(t)}`
			: "downloading from Real-Debrid…";
	}
	if (
		t.provider === "debrid" &&
		t.debrid_status &&
		DEBRID_PHASE[t.debrid_status]
	) {
		return DEBRID_PHASE[t.debrid_status]!;
	}
	if (!t.size_bytes) return "fetching metadata…";
	return transferLine(t);
}

export function TorrentList({
	torrents,
	loading,
	onRetry,
	onRemove,
}: {
	torrents: TorrentJob[] | undefined;
	loading: boolean;
	onRetry: (id: number) => void;
	onRemove: (t: TorrentJob) => void;
}) {
	if (loading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}
	if (!torrents || torrents.length === 0) {
		return (
			<EmptyState
				icon={Download}
				title="No torrents"
				description="Add a magnet link or a .torrent file and the finished download shows up in your files."
			/>
		);
	}

	return (
		<div className="space-y-2">
			{torrents.map((t) => {
				const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.queued;
				const inFlight =
					t.status === "queued" ||
					t.status === "downloading" ||
					t.status === "fetching" ||
					t.status === "importing";
				// A seeding job's data is still on disk and still in qBittorrent, so
				// removing it destroys something — unlike a settled row.
				const destructiveRemove = inFlight || t.status === "seeding";
				const viaDebrid = t.provider === "debrid";
				return (
					<ListRow
						key={t.id}
						leading={
							viaDebrid ? (
								<CloudDownload className="size-4 shrink-0 text-muted-foreground" />
							) : (
								<Download className="size-4 shrink-0 text-muted-foreground" />
							)
						}
						trailing={
							<>
								{(t.status === "completed" || t.status === "seeding") &&
									t.directory_id !== null && (
										<Tooltip content="Open folder">
											<Button
												variant="ghost"
												size="icon"
												asChild
												aria-label={`Open folder for ${t.name}`}
											>
												<Link to="/files">
													<FolderOpen />
												</Link>
											</Button>
										</Tooltip>
									)}
								{t.status === "failed" && (
									<Tooltip content="Retry import">
										<Button
											variant="ghost"
											size="icon"
											onClick={() => onRetry(t.id)}
											aria-label={`Retry ${t.name}`}
										>
											<RotateCcw />
										</Button>
									</Tooltip>
								)}
								<Tooltip
									content={
										t.status === "seeding"
											? "Stop seeding and remove (your imported files are kept)"
											: destructiveRemove
												? "Cancel and delete"
												: "Remove from list"
									}
								>
									<Button
										variant="ghost"
										size="icon"
										className="text-destructive"
										onClick={() => onRemove(t)}
										aria-label={`Remove ${t.name}`}
									>
										<Trash2 />
									</Button>
								</Tooltip>
							</>
						}
					>
						<div className="flex items-center gap-2">
							<span className="truncate text-sm font-medium">{t.name}</span>
							<Badge variant={badge.variant}>{badge.label}</Badge>
							{/* Null while pending: the backend is chosen at dispatch, so
							    naming one here would be a guess. */}
							{t.provider && (
								<Tooltip
									content={
										viaDebrid
											? "Downloaded by Real-Debrid, then transferred to this server"
											: t.fallback_reason
												? `Real-Debrid couldn't take this one: ${t.fallback_reason}`
												: "Downloaded by qBittorrent on this host"
									}
								>
									<Badge variant="secondary">
										{viaDebrid ? "Real-Debrid" : "qBittorrent"}
									</Badge>
								</Tooltip>
							)}
						</div>
						<p className="mt-0.5 truncate text-xs text-muted-foreground">
							{subtitle(t)}
						</p>
						{inFlight && (
							<Progress
								className="mt-2 h-1.5"
								value={Math.round((t.progress ?? 0) * 100)}
							/>
						)}
					</ListRow>
				);
			})}
		</div>
	);
}
