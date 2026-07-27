import { useQuery } from "@tanstack/react-query";
import { Download, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { adminService } from "../services/adminService";
import { formatBytes } from "@/lib/bytes";
import { relativeTime } from "@/lib/time";

const BUSY = new Set(["queued", "downloading", "importing"]);

export function TorrentsTab() {
  const status = useQuery({ queryKey: ["admin", "torrent-status"], queryFn: adminService.torrentStatus });
  const list = useQuery({
    queryKey: ["admin", "torrents"],
    queryFn: adminService.torrents,
    refetchInterval: (query) => (query.state.data?.some((t) => BUSY.has(t.status)) ? 5000 : false),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>qBittorrent host</CardTitle>
          <CardDescription>
            Configured in <code>data/app.env</code> via QBITTORRENT_URL, QBITTORRENT_USERNAME, QBITTORRENT_PASSWORD,
            QBITTORRENT_SAVE_PATH (and TORRENT_CONTENT_PATH when the path differs inside this server's container).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {status.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !status.data?.configured ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">not configured</Badge>
              <span className="text-muted-foreground">{status.data?.detail}</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {status.data.connected ? (
                  <Badge variant="success">connected</Badge>
                ) : (
                  <Badge variant="destructive">unreachable</Badge>
                )}
                <span className="text-muted-foreground">
                  {status.data.connected ? `qBittorrent ${status.data.version}` : status.data.detail}
                </span>
              </div>
              <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[10rem_1fr]">
                <dt>WebUI</dt>
                <dd className="truncate">{status.data.url}</dd>
                <dt>Download location</dt>
                <dd className="truncate">{status.data.save_path}</dd>
                <dt>Visible to this server as</dt>
                <dd className="truncate">{status.data.content_path}</dd>
              </dl>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All torrents</CardTitle>
          <CardDescription>Every user's torrent jobs on this node.</CardDescription>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !list.data || list.data.length === 0 ? (
            <EmptyState icon={Download} title="No torrents" description="Nobody has started a torrent download yet." />
          ) : (
            <div className="space-y-2">
              {list.data.map((t) => (
                <ListRow key={t.id} leading={<Download className="size-4 shrink-0 text-muted-foreground" />}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <Badge variant={t.status === "completed" ? "success" : t.status === "failed" ? "destructive" : "accent"}>
                      {t.status}
                    </Badge>
                    <Badge variant="secondary">
                      <User /> {t.owner_username}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatBytes(t.size_bytes)} · {Math.round((t.progress ?? 0) * 100)}% · updated{" "}
                    {relativeTime(t.updated_at)}
                    {t.error ? ` · ${t.error}` : ""}
                  </p>
                </ListRow>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
