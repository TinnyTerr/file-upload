import { useState } from "react";
import { Search, ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useAudit } from "../hooks/useAdminData";
import { formatDateTime } from "@/lib/time";

const PAGE = 50;

function actionVariant(action: string): "success" | "destructive" | "warning" | "secondary" {
  if (action.includes("created")) return "success";
  if (action.includes("deleted") || action.includes("revoked")) return "destructive";
  if (action.includes("updated") || action.includes("edited") || action.includes("archived")) return "warning";
  return "secondary";
}

export function AuditTab() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(0);

  const { data, isLoading, isPlaceholderData } = useAudit({
    limit: PAGE,
    offset: page * PAGE,
    q: q || undefined,
    action: action === "all" ? undefined : action,
  });

  const pages = data ? Math.ceil(data.filtered_count / PAGE) : 0;

  return (
    <div className="space-y-4">
      {data && !data.chain_ok && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <ShieldAlert className="size-4 shrink-0" />
          Audit log hash-chain is broken — possible tampering detected.
        </div>
      )}
      {data && data.chain_ok && (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-4 py-2.5 text-sm text-success">
          <ShieldCheck className="size-4 shrink-0" />
          Audit chain verified · {data.total_count} entries
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search actor, action, target, IP…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
          />
        </div>
        <Select value={action} onValueChange={(v) => { setAction(v); setPage(0); }}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {data?.actions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-80 w-full" />
      ) : !data || data.entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries" />
      ) : (
        <>
          <div className="rounded-lg border border-border" style={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.id}</TableCell>
                    <TableCell className="font-medium">{e.actor}</TableCell>
                    <TableCell>
                      <Badge variant={actionVariant(e.action)}>{e.action}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.target ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.ip ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(e.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {page + 1} of {Math.max(1, pages)} · {data.filtered_count} results
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
