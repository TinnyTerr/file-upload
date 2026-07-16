import { useRef, useState } from "react";
import { ChevronDown, Folder, Trash2, ExternalLink, X, FilePlus, Link2, Info, KeyRound, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Tooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListRow } from "@/components/ui/list-row";
import { EncryptionBadge, iconForType } from "@/features/files/lib/fileMeta";
import { useDirMembers, useDeleteDirectory, useRemoveMember } from "../hooks/useDirectories";
import { useAddFiles } from "../hooks/useAddFiles";
import { useDialogs } from "@/providers/DialogProvider";
import { useAuth } from "@/features/auth/hooks/auth";
import { folderUrl, shareUrl } from "@/features/files/lib/shareUrl";
import { ShareModal, type ShareEntry } from "@/features/files/components/ShareModal";
import { verifyFolderKey } from "../lib/folderKey";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import type { Directory, DirectoryMember } from "../types";
import { FolderLinksModal } from "./FolderLinksModal";
import { isPreviewableType, PreviewMedia } from "@/features/download/components/FilePreview";
import { previewPath } from "@/features/download/services/publicService";

function extractClientKey(value: string): string {
  const trimmed = value.trim();
  const marker = "#ek=";
  const idx = trimmed.indexOf(marker);
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + marker.length).split(/[?&#]/)[0];
}

export function FolderRow({ dir }: { dir: Directory }) {
  const [expanded, setExpanded] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [infoEntry, setInfoEntry] = useState<ShareEntry | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [clientKey, setClientKey] = useState<Uint8Array | null>(null);
  const [clientKeyB64, setClientKeyB64] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [previewMember, setPreviewMember] = useState<DirectoryMember | null>(null);
  const { data: members, isLoading } = useDirMembers(dir.id, expanded);
  const del = useDeleteDirectory();
  const removeMember = useRemoveMember(dir.id);
  const { addFiles, busy: adding } = useAddFiles(dir.id, dir.encryption_mode);
  const { confirm } = useDialogs();
  const { can } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canDelete = can("can_delete") || dir.role === "owner";
  const canManageLinks = can("can_regenerate_links") || dir.role === "owner";
  const canAddFiles = can("can_upload");
  const url = shareUrl(folderUrl(dir.slug), dir.encryption_mode, { accessKey: dir.access_key, clientKeyB64 });

  const shareEntry = (): ShareEntry => ({
    filename: dir.title,
    mode: dir.encryption_mode,
    baseUrl: folderUrl(dir.slug),
    accessKey: dir.access_key,
    clientKeyB64,
  });

  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete folder?",
      description: `“${dir.title}” and all ${dir.file_count} files will be removed.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) del.mutate(dir.id);
  };

  const openAddFiles = () => {
    if (dir.encryption_mode === "client" && !clientKey) {
      setPendingFiles(null);
      setUnlockOpen(true);
      return;
    }
    fileInputRef.current?.click();
  };

  const onFilesSelected = (files: File[]) => {
    if (!files.length) return;
    if (dir.encryption_mode === "client" && !clientKey) {
      setPendingFiles(files);
      setUnlockOpen(true);
      return;
    }
    addFiles(files, clientKey ?? undefined);
  };

  const unlockFolder = async () => {
    setKeyError(null);
    if (!dir.key_check_blob) {
      setKeyError("This folder was created before key checks existed. Recreate it to add encrypted files later.");
      return;
    }
    setUnlocking(true);
    try {
      const normalized = extractClientKey(keyInput);
      const key = await verifyFolderKey(normalized, dir.key_check_blob);
      setClientKey(key);
      setClientKeyB64(normalized);
      setKeyInput("");
      setUnlockOpen(false);
      if (pendingFiles?.length) {
        const files = pendingFiles;
        setPendingFiles(null);
        addFiles(files, key);
      }
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Invalid folder key.");
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <>
      <ListRow
        leading={
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
            <Folder className="size-4 text-muted-foreground" />
          </div>
        }
        trailing={
          <>
            <CopyButton value={url} tooltip="Copy folder URL" />
            <Tooltip content="Folder info & share">
              <Button variant="ghost" size="sm" onClick={() => setInfoEntry(shareEntry())} className="gap-1.5">
                <Info /> Info
              </Button>
            </Tooltip>
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
                <Button variant="ghost" size="icon" loading={adding} onClick={openAddFiles}>
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
                if (e.target.files?.length) onFilesSelected(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </>
        }
        footer={
          expanded && (
            <div className="space-y-1.5">
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
                  const canView = !!m.slug && m.encryption_mode === "none" && isPreviewableType(m.content_type);
                  return (
                    <ListRow
                      key={m.id}
                      noHover
                      className="bg-background/30"
                      leading={<Icon className="size-4 shrink-0 text-muted-foreground" />}
                      trailing={
                        <>
                          {canView && (
                            <Tooltip content="View">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-6"
                                onClick={() => setPreviewMember(m)}
                              >
                                <Eye className="size-3.5" />
                              </Button>
                            </Tooltip>
                          )}
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
                        </>
                      }
                    >
                      <span className="flex items-center gap-2 truncate text-xs" title={m.filename}>
                        <span className="truncate">{m.filename}</span>
                        <span className="shrink-0 text-muted-foreground">{formatBytes(m.size_bytes)}</span>
                      </span>
                    </ListRow>
                  );
                })
              )}
            </div>
          )
        }
      >
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
      </ListRow>

      <FolderLinksModal
        open={linksOpen}
        onOpenChange={setLinksOpen}
        dirId={dir.id}
        dirTitle={dir.title}
        encryptionMode={dir.encryption_mode}
        accessKey={dir.access_key}
      />

      <ShareModal
        entries={infoEntry ? [infoEntry] : []}
        open={!!infoEntry}
        onOpenChange={(o) => !o && setInfoEntry(null)}
        title="Folder info"
        description="Share links, key and download details for this folder."
      />

      <Dialog open={unlockOpen} onOpenChange={(o) => {
        setUnlockOpen(o);
        if (!o) {
          setPendingFiles(null);
          setKeyError(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" /> Unlock folder
            </DialogTitle>
            <DialogDescription>Paste the folder key or full #ek= URL before adding end-to-end encrypted files.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`folder-key-${dir.id}`}>Folder key</Label>
            <Input
              id={`folder-key-${dir.id}`}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste key or full folder URL"
            />
            {keyError && <p className="text-sm font-medium text-destructive">{keyError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlockOpen(false)}>Cancel</Button>
            <Button onClick={unlockFolder} loading={unlocking}>Unlock</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewMember !== null} onOpenChange={(o) => !o && setPreviewMember(null)}>
        <DialogContent className="max-w-2xl">
          {previewMember && (
            <>
              <DialogHeader>
                <DialogTitle className="truncate">{previewMember.filename}</DialogTitle>
              </DialogHeader>
              <PreviewMedia
                src={previewPath(previewMember.slug!)}
                contentType={previewMember.content_type}
                filename={previewMember.filename}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
