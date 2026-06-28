import { useState, useMemo } from "react";
import { Search, KeyRound, Plus, Lock, Globe, RotateCcw, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { NewKeyModal } from "@/features/apikeys/components/NewKeyModal";
import { BulkBar } from "./BulkBar";
import { BulkConfirmDialog } from "./BulkConfirmDialog";
import { useAdminKeys } from "../hooks/useAdminData";
import { useApiKeys } from "@/features/apikeys/hooks/useApiKeys";
import { useBulk } from "../hooks/useBulk";
import { useSelection } from "../hooks/useSelection";
import { formatDate, relativeTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { NewApiKey } from "@/features/apikeys/types";

type StatusFilter = "all" | "active" | "inactive" | "bound" | "unbound";

export function KeysTab() {
  const keys = useAdminKeys();
  const { create } = useApiKeys();
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [newKey, setNewKey] = useState<NewApiKey | null>(null);
  const selection = useSelection();
  const bulk = useBulk(selection.clear);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (keys.data ?? []).filter((k) => {
      if (q && !k.owner_username.toLowerCase().includes(q) && String(k.owner_id) !== q && String(k.id) !== q) return false;
      if (status === "active" && !k.active) return false;
      if (status === "inactive" && k.active) return false;
      if (status === "bound" && !k.bound_ip) return false;
      if (status === "unbound" && k.bound_ip) return false;
      return true;
    });
  }, [keys.data, filter, status]);

  const onCreate = async () => setNewKey(await create.mutateAsync());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter by owner or id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="bound">Bound</SelectItem>
            <SelectItem value="unbound">Unbound</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={onCreate} loading={create.isPending}>
          <Plus /> New key
        </Button>
      </div>

      {keys.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={KeyRound} title="No API keys" />
      ) : (
        <div className="space-y-2 pb-16">
          {filtered.map((k) => (
            <Card key={k.id} className={cn(selection.has(k.id) && "ring-1 ring-primary/50")}>
              <CardContent className="flex items-center gap-3 p-3">
                <Checkbox checked={selection.has(k.id)} onCheckedChange={() => selection.toggle(k.id)} aria-label="Select key" />
                <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {k.owner_username} · key #{k.user_key_number}
                    </span>
                    {k.active ? <Badge variant="success">active</Badge> : <Badge variant="secondary">inactive</Badge>}
                    {k.bound_ip ? (
                      <Badge variant="accent">
                        <Lock /> {k.bound_ip}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        <Globe /> unbound
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    created {formatDate(k.created_at)} · last used {relativeTime(k.last_used_at)}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <BulkBar count={selection.count} onClear={selection.clear}>
        <Button variant="ghost" size="sm" onClick={() => bulk.startPreview("reset_api_key_ips", selection.list)}>
          <RotateCcw /> Reset IP
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => bulk.startPreview("delete_api_keys", selection.list)}>
          <Trash2 /> Delete
        </Button>
      </BulkBar>
      <BulkConfirmDialog bulk={bulk} />
      <NewKeyModal apiKey={newKey} onClose={() => setNewKey(null)} />
    </div>
  );
}
