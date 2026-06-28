import { useRef, useState } from "react";
import { ChevronDown, Folder, Trash2, ExternalLink, X, FilePlus, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Tooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { EncryptionBadge, iconForType } from "@/features/files/lib/fileMeta";
import { useDirMembers, useDeleteDirectory, useRemoveMember } from "../hooks/useDirectories";
import { useAddFiles } from "../hooks/useAddFiles";
import { useDialogs } from "@/providers/DialogProvider";
import { useAuth } from "@/features/auth/hooks/auth";
import { folderUrl, shareUrl } from "@/features/files/lib/shareUrl";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import type { Directory } from "../types";
import { FolderLinksModal } from "./FolderLinksModal";

export function FolderRow({ dir }: { dir: Directory }) {
  const [expanded, setExpanded] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const { data: members, isLoading } = useDirMembers(dir.id, expanded);
  const del = useDeleteDirectory();
  const removeMember = useRemoveMember(dir.id);
  const { addFiles, busy: adding } = useAddFiles(dir.id, dir.encryption_mode);
  const { confirm } = useDialogs();
  const { can } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canDelete = can("can_delete") || dir.role === "owner";
  const canManageLinks = can("can_regenerate_links") || dir.role === "owner";
  // Adding files to a folder is only safe for unencrypted folders (no stored key).
  const canAddFiles = can("can_upload") && dir.encryption_mode === "none";
  const url = shareUrl(folderUrl(dir.slug), dir.encryption_mode, { accessKey: dir.access_key, clientKeyB64: null });

  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete folder?",
      description: `“${dir.title}” and all ${dir.file_count} files will be removed.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) del.mutate(dir.id);
  };

  return (
    <div className="rounded-lg border border-border bg-secondary/20 transition-colors hover:bg-secondary/30">
      <div className="flex items-center gap-3 p-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
          <Folder className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" title={dir.title}>
              {dir.title}
            </span>
            <EncryptionBadge mode={dir.encryption_mode} />
            {dir.role === "editor" && <Badge variant="secondary">shared</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {dir.file_count} files · {formatBytes(dir.total_bytes)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <CopyButton value={url} tooltip="Copy folder URL" />
          <Tooltip content="Open folder">
            <Button variant="ghost" size="icon" asChild>
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          </Tooltip>
          {canManageLinks && (
            <Tooltip content="Manage links">
              <Button variant="ghost" size="icon" onClick={() => setLinksOpen(true)}>
                <Link2 />
              </Button>
            </Tooltip>
          )}
          {canAddFiles && (
            <Tooltip content="Add files">
              <Button variant="ghost" size="icon" loading={adding} onClick={() => fileInputRef.current?.click()}>
                <FilePlus />
              </Button>
            </Tooltip>
          )}
          {canDelete && (
            <Tooltip content="Delete folder">
              <Button variant="ghost" size="icon" className="text-destructive" onClick={onDelete} loading={del.isPending}>
                <Trash2 />
              </Button>
            </Tooltip>
          )}
          <Button variant="ghost" size="icon" onClick={() => setExpanded((e) => !e)}>
            <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <FolderLinksModal
        open={linksOpen}
        onOpenChange={setLinksOpen}
        dirId={dir.id}
        dirTitle={dir.title}
        encryptionMode={dir.encryption_mode}
        accessKey={dir.access_key}
      />

      {expanded && (
        <div className="space-y-1.5 border-t border-border px-3 py-2.5">
          {isLoading ? (
            <>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </>
          ) : !members || members.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">This folder is empty.</p>
          ) : (
            members.map((m) => {
              const Icon = iconForType(m.content_type);
              return (
                <div key={m.id} className="flex items-center gap-2 rounded-md border border-border bg-background/30 px-2.5 py-1.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-xs" title={m.filename}>
                    {m.filename}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatBytes(m.size_bytes)}</span>
                  {canDelete && (
                    <Tooltip content="Remove from folder">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-destructive"
                        onClick={() => removeMember.mutate(m.id)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
