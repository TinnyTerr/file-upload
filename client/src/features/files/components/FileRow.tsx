import { useState } from "react";
import { ChevronDown, Trash2, Link2, Archive } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { LinkList } from "./LinkList";
import { CreateLinkDialog } from "./CreateLinkDialog";
import { iconForType, EncryptionBadge } from "../lib/fileMeta";
import { useDeleteFile } from "../hooks/useFiles";
import { useDialogs } from "@/providers/DialogProvider";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatBytes } from "@/lib/bytes";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { FileObject } from "../types";

function UploaderAvatar({ ownerId, ownerUsername, hasAvatar }: {
  ownerId: number;
  ownerUsername: string;
  hasAvatar: boolean;
}) {
  const cls = "flex size-6 shrink-0 items-center justify-center rounded-full overflow-hidden";
  if (hasAvatar) {
    return (
      <span className={cls}>
        <img
          src={`/account/avatar/${ownerId}`}
          alt={ownerUsername}
          className="size-full object-cover"
        />
      </span>
    );
  }
  return (
    <span className={cn(cls, "bg-brand-gradient text-[9px] font-semibold text-white")}>
      {ownerUsername.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function FileRow({ file }: { file: FileObject }) {
  const [expanded, setExpanded] = useState(false);
  const del = useDeleteFile();
  const { confirm } = useDialogs();
  const { can } = useAuth();

  const canDelete = can("can_delete");
  const canLinks = can("can_regenerate_links");
  const Icon = iconForType(file.content_type);

  const isImage = (file.content_type ?? "").startsWith("image/");
  const isVideo = (file.content_type ?? "").startsWith("video/");
  const canPreview = file.encryption_mode !== "client" && !file.compressed && !file.archived;

  const ownerUsername = file.owner_username ?? "unknown";
  const hasAvatar = file.has_avatar ?? false;

  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete file?",
      description: `"${file.original_filename}" and all its links will be removed.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) del.mutate(file.id);
  };

  return (
    <div className="rounded-lg border border-border bg-secondary/20 transition-colors hover:bg-secondary/30">
      <div className="flex items-center gap-3 p-3">
        {/* Icon slot — replaced by thumbnail for previewable images */}
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background/50 overflow-hidden">
          {isImage && canPreview ? (
            <img
              src={`/files/${file.id}/thumb`}
              alt={file.original_filename}
              className="size-full object-cover"
              loading="lazy"
            />
          ) : (
            <Icon className="size-4 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" title={file.original_filename}>
              {file.original_filename}
            </span>
            <EncryptionBadge mode={file.encryption_mode} />
            {file.compressed && (
              <Tooltip content="zstd-compressed">
                <Badge variant="secondary">zst</Badge>
              </Tooltip>
            )}
            {file.archived && (
              <Badge variant="secondary">
                <Archive /> archived
              </Badge>
            )}
          </div>
          {/* Uploader + meta */}
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <UploaderAvatar ownerId={file.owner_id} ownerUsername={ownerUsername} hasAvatar={hasAvatar} />
            <span className="font-medium text-foreground/70">{ownerUsername}</span>
            <span>·</span>
            <span>{formatBytes(file.size_bytes)}</span>
            <span>·</span>
            <span>{formatDate(file.created_at)}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {canLinks && <CreateLinkDialog fileId={file.id} />}
          {canDelete && (
            <Tooltip content="Delete file">
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                onClick={onDelete}
                loading={del.isPending}
                aria-label={`Delete ${file.original_filename}`}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={`${file.links.length} link${file.links.length === 1 ? "" : "s"}`}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((e) => !e)}
              className="gap-1"
              aria-label={`${expanded ? "Hide" : "Show"} ${file.links.length} share link${file.links.length === 1 ? "" : "s"} for ${file.original_filename}`}
              aria-expanded={expanded}
            >
              <Link2 className="size-4" />
              <span>
                {file.links.length} <span className="hidden sm:inline">links</span>
              </span>
              <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2.5 space-y-2.5">
          {/* Inline video player for video files */}
          {isVideo && canPreview && (
            <video
              controls
              preload="none"
              className="w-full rounded-md max-h-72 bg-black"
              src={`/files/${file.id}/raw`}
            />
          )}
          <LinkList file={file} />
        </div>
      )}
    </div>
  );
}
