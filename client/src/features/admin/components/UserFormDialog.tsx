import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useAdminUsers } from "../hooks/useAdminUsers";
import type { AdminUser } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Provide to edit; omit to create. */
  editing?: AdminUser | null;
}

export function UserFormDialog({ open, onClose, editing }: Props) {
  const { create, update } = useAdminUsers();
  const isEdit = !!editing;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [canUpload, setCanUpload] = useState(true);

  useEffect(() => {
    if (open) {
      setUsername(editing?.username ?? "");
      setPassword("");
      setRole(editing?.role ?? "user");
      setCanUpload(editing?.permissions?.can_upload ?? true);
    }
  }, [open, editing]);

  const onSubmit = async () => {
    if (isEdit && editing) {
      await update.mutateAsync({
        id: editing.id,
        username: username || undefined,
        password: password || undefined,
        role,
      });
    } else {
      await create.mutateAsync({ username, password, role, can_upload: canUpload });
    }
    onClose();
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${editing?.username}` : "New user"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Leave password blank to keep it unchanged." : "Password must be at least 12 characters."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="u-name">Username</Label>
            <Input id="u-name" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-pass">Password</Label>
            <Input id="u-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="master">Master</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isEdit && (
            <div className="flex items-center justify-between">
              <Label>Can upload</Label>
              <Switch checked={canUpload} onCheckedChange={setCanUpload} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={pending} disabled={!username || (!isEdit && password.length < 12)}>
            {isEdit ? "Save" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
