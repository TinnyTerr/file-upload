import { useState } from "react";
import { Search, RefreshCw, Power, Terminal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useBackendLogs } from "../hooks/useAdminData";
import { useRestartWorkers } from "../hooks/useAdminDashboard";
import { formatDateTime } from "@/lib/time";
import { cn } from "@/lib/cn";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

const LEVEL_COLOR: Record<string, string> = {
  DEBUG: "text-muted-foreground",
  INFO: "text-accent",
  WARNING: "text-warning",
  ERROR: "text-destructive",
  CRITICAL: "text-destructive font-bold",
};

export function BackendTab() {
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("all");
  const [server, setServer] = useState("local");
  const [auto, setAuto] = useState(false);
  const restart = useRestartWorkers();

  const { data, isLoading } = useBackendLogs(
    {
      limit: 200,
      q: q || undefined,
      level: level === "all" ? undefined : level,
      server: server === "local" ? undefined : server,
    },
    auto,
  );

  const servers = data?.servers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search log messages…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={server} onValueChange={setServer}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Server" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">This server</SelectItem>
            {/* Backend lists self first; "This server" already covers it. */}
            {servers.slice(1).map((s) => (
              <SelectItem key={s.node_id} value={s.node_id}>
                {s.node_name || s.node_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            {LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
          <RefreshCw className={cn("size-4", auto && "animate-spin text-primary")} />
          <Label className="text-xs">Auto</Label>
          <Switch checked={auto} onCheckedChange={setAuto} />
        </div>
        <Button variant="secondary" onClick={() => restart.mutate()} loading={restart.isPending}>
          <Power /> Restart workers
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : !data || data.entries.length === 0 ? (
        <EmptyState icon={Terminal} title="No log entries" />
      ) : (
        <div className="max-h-[60vh] space-y-0.5 overflow-y-auto rounded-lg border border-border bg-background/50 p-3 font-mono text-xs">
          {data.entries.map((log, i) => (
            <div key={i} className="flex gap-2 border-b border-border/40 py-1 last:border-0">
              <span className="shrink-0 text-muted-foreground">{formatDateTime(log.created_at)}</span>
              <span className={cn("w-16 shrink-0 uppercase", LEVEL_COLOR[log.level] ?? "text-muted-foreground")}>{log.level}</span>
              <span className="shrink-0 text-muted-foreground">{log.module}:{log.line}</span>
              <span className="break-all">{log.message}</span>
            </div>
          ))}
          <p className="pt-2 text-center text-muted-foreground">
            {data.filtered_count} of {data.total_count} entries
          </p>
        </div>
      )}
    </div>
  );
}
