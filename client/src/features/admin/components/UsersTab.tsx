import { useState, useMemo } from "react";
import { UserPlus, Pencil, Shield, Trash2, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { ListRow } from "@/components/ui/list-row";
import { UserAvatar } from "@/components/ui/user-avatar";
import { UserFormDialog } from "./UserFormDialog";
import { PermissionsDialog } from "./PermissionsDialog";
import { useAdminUsers } from "../hooks/useAdminUsers";
import { useStorageDetails } from "../hooks/useAdminDashboard";
import { useDialogs } from "@/providers/DialogProvider";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatBytes, percent } from "@/lib/bytes";
import { formatDate } from "@/lib/time";
import { PERMISSION_FLAGS } from "@/config/permissions";
import type { AdminUser } from "../types";

export function UsersTab() {
  const { list, remove } = useAdminUsers();
  const { data: storage } = useStorageDetails();
  const { confirm } = useDialogs();
  const { user: me } = useAuth();
  const [filter, setFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [permsFor, setPermsFor] = useState<AdminUser | null>(null);

  const usageById = useMemo(() => {
    const m = new Map<number, { used: number; quota: number | null }>();
    storage?.users.forEach((u) => m.set(u.id, { used: u.used_bytes, quota: u.quota_bytes }));
    return m;
  }, [storage]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return list.data ?? [];
    return (list.data ?? []).filter(
      (u) => u.username.toLowerCase().includes(q) || u.role.includes(q) || String(u.id) === q,
    );
  }, [list.data, filter]);

  const onDelete = async (u: AdminUser) => {
    const ok = await confirm({
      title: `Delete ${u.username}?`,
      description: "All of their files, links and keys will be removed.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) remove.mutate(u.id);
  };

  const grantedCount = (u: AdminUser) =>
    u.permissions ? PERMISSION_FLAGS.filter((f) => u.permissions![f]).length : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter by username, role or id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
          <UserPlus /> New user
        </Button>
      </div>

      {list.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Users} title="No users" description="Create the first additional account." />
      ) : (
        <div className="space-y-2">
          {filtered.map((u) => {
            const usage = usageById.get(u.id);
            const pct = usage?.quota ? percent(usage.used, usage.quota) : 0;
            return (
              <ListRow
                key={u.id}
                leading={<UserAvatar userId={u.id} username={u.username} hasAvatar={u.has_avatar} size="md" />}
                trailing={
                  <>
                    <div className="hidden w-44 sm:block">
                      {usage && (
                        <>
                          <Progress value={pct} className="h-1.5" />
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatBytes(usage.used)}
                            {usage.quota ? ` / ${formatBytes(usage.quota)}` : ""}
                          </p>
                        </>
                      )}
                    </div>
                    <Tooltip content="Edit">
                      <Button variant="ghost" size="icon" onClick={() => { setEditing(u); setFormOpen(true); }}>
                        <Pencil />
                      </Button>
                    </Tooltip>
                    <Tooltip content="Permissions">
                      <Button variant="ghost" size="icon" onClick={() => setPermsFor(u)}>
                        <Shield />
                      </Button>
                    </Tooltip>
                    <Tooltip content={u.id === me?.id ? "You can't delete yourself" : "Delete"}>
                      <span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                          disabled={u.id === me?.id}
                          loading={remove.isPending}
                          onClick={() => onDelete(u)}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    </Tooltip>
                  </>
                }
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{u.username}</span>
                  <Badge variant={u.role === "master" ? "accent" : "secondary"}>{u.role}</Badge>
                  {u.must_change_credentials && <Badge variant="warning">setup</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {grantedCount(u)} permissions · joined {formatDate(u.created_at)}
                </p>
                {usage && (
                  <div className="mt-2 max-w-44 sm:hidden">
                    <Progress value={pct} className="h-1.5" />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatBytes(usage.used)}
                      {usage.quota ? ` / ${formatBytes(usage.quota)}` : ""}
                    </p>
                  </div>
                )}
              </ListRow>
            );
          })}
        </div>
      )}

      <UserFormDialog open={formOpen} editing={editing} onClose={() => setFormOpen(false)} />
      <PermissionsDialog user={permsFor} onClose={() => setPermsFor(null)} />
    </div>
  );
}
