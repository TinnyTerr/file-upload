import { useState } from "react";
import { Search, ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight, ScrollText, Server } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useAudit, useClusterAudit } from "../hooks/useAdminData";
import { formatDateTime } from "@/lib/time";

const PAGE = 50;

// Sentinel server selections. "local" = this node's tamper-evident audit log;
// "all" = the cluster-wide event log across every node; anything else = one node.
const LOCAL = "local";
const ALL = "all";

function actionVariant(action: string): "success" | "destructive" | "warning" | "secondary" {
  if (action.includes("created")) return "success";
  if (action.includes("deleted") || action.includes("revoked")) return "destructive";
  if (action.includes("updated") || action.includes("edited") || action.includes("archived")) return "warning";
  return "secondary";
}

export function AuditTab() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [server, setServer] = useState(LOCAL);
  const [page, setPage] = useState(0);

  const isLocal = server === LOCAL;

  const local = useAudit({
    limit: PAGE,
    offset: page * PAGE,
    q: q || undefined,
    action: action === "all" ? undefined : action,
  });

  // Always fetch the cluster view: it powers the server dropdown options, and the
  // table itself whenever a specific/all server is selected.
  const cluster = useClusterAudit(
    {
      limit: PAGE,
      offset: page * PAGE,
      q: q || undefined,
      action: action === "all" ? undefined : action,
      server: server === ALL || server === LOCAL ? undefined : server,
    },
    true,
  );

  const view = isLocal ? local : cluster;
  const isLoading = view.isLoading;
  const isPlaceholderData = view.isPlaceholderData;
  const filteredCount = view.data?.filtered_count ?? 0;
  const pages = Math.ceil(filteredCount / PAGE);

  // Action options + server options come from whichever query has them.
  const actions = (isLocal ? local.data?.actions : cluster.data?.actions) ?? [];
  const servers = cluster.data?.servers ?? [];

  const resetPage = () => setPage(0);

  return (
    <div className="space-y-4">
      {isLocal && local.data && !local.data.chain_ok && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <ShieldAlert className="size-4 shrink-0" />
          Audit log hash-chain is broken — possible tampering detected.
        </div>
      )}
      {isLocal && local.data && local.data.chain_ok && (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-4 py-2.5 text-sm text-success">
          <ShieldCheck className="size-4 shrink-0" />
          Audit chain verified · {local.data.total_count} entries
        </div>
      )}
      {!isLocal && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-4 py-2.5 text-sm text-muted-foreground">
          <Server className="size-4 shrink-0" />
          Cluster-wide event log (aggregated from all nodes; not hash-chain verified — switch to “This server” for the tamper-evident log).
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search actor, action, target, IP…"
            value={q}
            onChange={(e) => { setQ(e.target.value); resetPage(); }}
          />
        </div>
        <Select value={server} onValueChange={(v) => { setServer(v); resetPage(); }}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Server" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={LOCAL}>This server (verified)</SelectItem>
            <SelectItem value={ALL}>All servers</SelectItem>
            {servers.map((s) => (
              <SelectItem key={s.node_id} value={s.node_id}>
                {s.node_name || s.node_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={action} onValueChange={(v) => { setAction(v); resetPage(); }}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-80 w-full" />
      ) : !view.data || view.data.entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries" />
      ) : (
        <>
          <div className="rounded-lg border border-border" style={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  {!isLocal && <TableHead>Server</TableHead>}
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLocal
                  ? local.data!.entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.id}</TableCell>
                        <TableCell className="font-medium">{e.actor}</TableCell>
                        <TableCell><Badge variant={actionVariant(e.action)}>{e.action}</Badge></TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.target ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.ip ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(e.created_at)}</TableCell>
                      </TableRow>
                    ))
                  : cluster.data!.entries.map((e) => (
                      <TableRow key={`${e.node_id}-${e.id}`}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.id}</TableCell>
                        <TableCell className="text-xs">{e.node_name || e.node_id}</TableCell>
                        <TableCell className="font-medium">{e.actor}</TableCell>
                        <TableCell><Badge variant={actionVariant(e.action)}>{e.action}</Badge></TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.target ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.ip ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{e.ts ? formatDateTime(e.ts) : "—"}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {page + 1} of {Math.max(1, pages)} · {filteredCount} results
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
