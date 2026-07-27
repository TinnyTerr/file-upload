import { Link } from "react-router-dom";
import { Download, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
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

const STATUS_BADGE: Record<TorrentStatus, { label: string; variant: "success" | "accent" | "secondary" | "destructive" }> = {
  queued: { label: "queued", variant: "secondary" },
  downloading: { label: "downloading", variant: "accent" },
  importing: { label: "importing", variant: "accent" },
  completed: { label: "completed", variant: "success" },
  failed: { label: "failed", variant: "destructive" },
};

function formatEta(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function subtitle(t: TorrentJob): string {
  if (t.status === "completed") {
    const files = `${t.imported_file_count} file${t.imported_file_count === 1 ? "" : "s"}`;
    return `${files} · ${formatBytes(t.size_bytes)} · imported ${relativeTime(t.completed_at)}`;
  }
  if (t.status === "failed") return t.error ?? "failed";
  if (t.status === "importing") return "moving files into your storage…";
  if (!t.size_bytes) return "fetching metadata…";
  return `${formatBytes(t.downloaded_bytes)} of ${formatBytes(t.size_bytes)} · ${formatBytes(t.dl_speed)}/s · ETA ${formatEta(t.eta_seconds)}`;
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
        const inFlight = t.status === "queued" || t.status === "downloading" || t.status === "importing";
        return (
          <ListRow
            key={t.id}
            leading={<Download className="size-4 shrink-0 text-muted-foreground" />}
            trailing={
              <>
                {t.status === "completed" && t.directory_id !== null && (
                  <Tooltip content="Open folder">
                    <Button variant="ghost" size="icon" asChild aria-label={`Open folder for ${t.name}`}>
                      <Link to="/files">
                        <FolderOpen />
                      </Link>
                    </Button>
                  </Tooltip>
                )}
                {t.status === "failed" && (
                  <Tooltip content="Retry import">
                    <Button variant="ghost" size="icon" onClick={() => onRetry(t.id)} aria-label={`Retry ${t.name}`}>
                      <RotateCcw />
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content={inFlight ? "Cancel and delete" : "Remove from list"}>
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
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle(t)}</p>
            {inFlight && <Progress className="mt-2 h-1.5" value={Math.round((t.progress ?? 0) * 100)} />}
          </ListRow>
        );
      })}
    </div>
  );
}
