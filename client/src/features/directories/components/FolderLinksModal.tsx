import { Power, PowerOff, Trash2, Plus, Link2, EyeOff, Eye } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialogs } from "@/providers/DialogProvider";
import { useDirLinks, useCreateDirLink, useUpdateDirLink, useDeleteDirLink } from "../hooks/useDirectories";
import { formatDateTime } from "@/lib/time";
import type { DirectoryLink } from "../types";
import type { EncryptionMode } from "@/features/files/types";

function linkStatus(link: DirectoryLink): { label: string; variant: "success" | "secondary" | "warning" | "destructive" } {
  if (!link.active) return { label: "inactive", variant: "secondary" };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { label: "expired", variant: "warning" };
  if (link.max_uses != null && link.use_count >= link.max_uses) return { label: "used up", variant: "destructive" };
  return { label: "active", variant: "success" };
}

export function FolderLinksModal({
  open,
  onOpenChange,
  dirId,
  dirTitle,
  encryptionMode,
  accessKey,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dirId: number;
  dirTitle: string;
  encryptionMode: EncryptionMode;
  accessKey: string | null;
}) {
  const { data: links, isLoading } = useDirLinks(dirId, open);
  const create = useCreateDirLink(dirId);
  const update = useUpdateDirLink(dirId);
  const del = useDeleteDirLink(dirId);
  const { confirm } = useDialogs();

  const onDelete = async (link: DirectoryLink) => {
    const ok = await confirm({ title: "Delete link?", description: "This permanently removes the share link.", confirmText: "Delete", destructive: true });
    if (ok) del.mutate(link.id);
  };

  const buildUrl = (link: DirectoryLink) => {
    const base = link.url;
    if (encryptionMode === "server" && accessKey) return `${base}?ek=${encodeURIComponent(accessKey)}`;
    return base;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-4 text-primary" /> Links · {dirTitle}
          </DialogTitle>
          <DialogDescription>Manage share links for this folder.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !links?.length ? (
            <p className="text-sm text-muted-foreground">No links yet.</p>
          ) : (
            <ul className="space-y-2">
              {links.map((link) => {
                const status = linkStatus(link);
                const url = buildUrl(link);
                return (
                  <li key={link.id} className="rounded-md border border-border bg-background/30 p-2.5">
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate font-mono text-xs">{url}</code>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          {link.use_count}{link.max_uses != null ? ` / ${link.max_uses}` : " / ∞"} downloads
                          {link.expires_at ? ` · expires ${formatDateTime(link.expires_at)}` : ""}
                        </span>
                        {link.hide_uploader && (
                          <span className="flex items-center gap-1">
                            <EyeOff className="size-3" /> anon
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5">
                        <CopyButton value={url} />
                        <Tooltip content={link.hide_uploader ? "Show uploader" : "Hide uploader"}>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => update.mutate({ linkId: link.id, hide_uploader: !link.hide_uploader })}
                          >
                            {link.hide_uploader ? <Eye /> : <EyeOff />}
                          </Button>
                        </Tooltip>
                        <Tooltip content={link.active ? "Deactivate" : "Reactivate"}>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => update.mutate({ linkId: link.id, active: !link.active })}
                          >
                            {link.active ? <PowerOff /> : <Power />}
                          </Button>
                        </Tooltip>
                        <Tooltip content="Delete link">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive"
                            loading={del.isPending}
                            onClick={() => onDelete(link)}
                          >
                            <Trash2 />
                          </Button>
                        </Tooltip>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            loading={create.isPending}
            onClick={() => create.mutate({})}
          >
            <Plus className="size-4" /> New link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
