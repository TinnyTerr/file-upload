import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PERMISSION_META } from "@/config/permissions";
import { useAdminUsers } from "../hooks/useAdminUsers";
import type { AdminUser, UserPermissions } from "../types";

const GB = 1024 ** 3;

export function PermissionsDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { setPermissions } = useAdminUsers();
  const [draft, setDraft] = useState<Partial<UserPermissions>>({});
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const base = user.permissions;

  const value = (key: keyof UserPermissions): boolean =>
    (draft[key] ?? (base ? (base[key] as boolean) : false)) as boolean;

  const onSave = async () => {
    setError(null);
    try {
      await setPermissions.mutateAsync({ id: user.id, permissions: draft });
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save permissions.");
    }
  };

  const groups = ["essentials", "advanced", "admin"] as const;

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Permissions · {user.username}</DialogTitle>
          <DialogDescription>Toggle capabilities and set storage limits.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
              {PERMISSION_META.filter((p) => p.group === group).map((perm) => (
                <div key={perm.key} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Label className="block">{perm.label}</Label>
                    <p className="text-xs text-muted-foreground">{perm.description}</p>
                  </div>
                  <Switch
                    checked={value(perm.key)}
                    onCheckedChange={(v) => setDraft((d) => ({ ...d, [perm.key]: v }))}
                  />
                </div>
              ))}
            </div>
          ))}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-border pt-3">
            <div className="space-y-1">
              <Label className="text-xs">Quota (GB)</Label>
              <Input
                type="number"
                min={0}
                defaultValue={base ? (base.quota_bytes / GB).toFixed(0) : ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, quota_bytes: Math.max(0, Math.round(parseFloat(e.target.value) * GB)) }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max file (GB)</Label>
              <Input
                type="number"
                min={0}
                defaultValue={base ? (base.max_file_bytes / GB).toFixed(0) : ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, max_file_bytes: Math.max(0, Math.round(parseFloat(e.target.value) * GB)) }))
                }
              />
            </div>
          </div>
        </div>

        {error && <div className="mt-2 text-sm font-medium text-destructive">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} loading={setPermissions.isPending}>
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
