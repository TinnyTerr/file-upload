import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { FolderX, FolderArchive, Download, Save, Eye } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { EncryptionBanner } from "@/features/download/components/EncryptionBanner";
import { UserAvatar } from "@/components/ui/user-avatar";
import { ListRow } from "@/components/ui/list-row";
import { iconForType } from "@/features/files/lib/fileMeta";
import { isPreviewableType } from "@/features/download/components/FilePreview";
import { useDirInfo, useFolderZip, downloadMember } from "../hooks/useFolderView";
import { readClientKeyFromHash, readServerKeyFromQuery } from "@/lib/download";
import { useAuth } from "@/features/auth/hooks/auth";
import { useSaveFolder } from "../hooks/useSaveFolder";
import { formatBytes } from "@/lib/bytes";
import { FolderFilePreviewModal } from "./FolderFilePreviewModal";
import type { PublicDirMember } from "../services/publicDirService";

export function FolderPage() {
  const { slug = "" } = useParams();
  const { data: info, isLoading, isError } = useDirInfo(slug);
  const { user } = useAuth();
  const saveFolder = useSaveFolder();
  const [previewMember, setPreviewMember] = useState<PublicDirMember | null>(null);

  const clientKey = useMemo(() => readClientKeyFromHash(), []);
  const serverKey = useMemo(() => readServerKeyFromQuery(), []);
  const keys = { clientKey, serverKey };

  const { downloadAll, status, progress } = useFolderZip(slug, info?.title ?? "folder", info?.encryption_mode ?? "none");

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !info) {
    return <EmptyState icon={FolderX} title="Folder not found" description="This folder may have expired or never existed." />;
  }

  const hasKey =
    info.encryption_mode === "client" ? !!clientKey : info.encryption_mode === "server" ? !!serverKey : true;
  const zipping = status === "working";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-5 p-6">
          <div className="flex items-start gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary/50">
              <FolderArchive className="size-7 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-xl font-bold">{info.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {info.file_count} files · {formatBytes(info.total_bytes)}
              </p>
            </div>
          </div>

          <EncryptionBanner mode={info.encryption_mode} hasKey={hasKey} />

          {/* Uploader info */}
          {info.uploader && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <UserAvatar
                userId={info.uploader.user_id}
                username={info.uploader.username}
                hasAvatar={info.uploader.has_avatar}
                size="sm"
              />
              <span>Shared by <strong>{info.uploader.username}</strong></span>
            </div>
          )}

          <div className="space-y-2">
            <Button
              size="lg"
              className="w-full"
              disabled={(info.encryption_mode !== "none" && !hasKey) || zipping || info.file_count === 0}
              loading={zipping}
              onClick={() => downloadAll(info.files, keys)}
            >
              <Download /> {zipping ? "Preparing…" : "Download all (.zip)"}
            </Button>
            {zipping && <Progress value={progress.total ? Math.round((progress.done / progress.total) * 100) : 0} />}
            {user && (
              <Button
                variant="secondary"
                className="w-full"
                loading={saveFolder.isPending}
                disabled={info.already_saved}
                onClick={() => saveFolder.mutate(slug)}
              >
                <Save /> {info.already_saved ? "Already saved" : "Save folder to my files"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-5">
          <h2 className="text-sm font-semibold">Files</h2>
          {info.files.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">This folder is empty.</p>
          ) : (
            <div className="space-y-1.5">
              {info.files.map((m) => {
                const Icon = iconForType(m.content_type);
                const canView = info.encryption_mode === "none" && isPreviewableType(m.content_type);
                return (
                  <ListRow
                    key={m.slug}
                    leading={<Icon className="size-4 shrink-0 text-muted-foreground" />}
                    trailing={
                      <div className="flex items-center gap-1">
                        {canView && (
                          <Button variant="ghost" size="icon" onClick={() => setPreviewMember(m)}>
                            <Eye />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={info.encryption_mode !== "none" && !hasKey}
                          onClick={() => downloadMember(m, info.encryption_mode, keys)}
                        >
                          <Download />
                        </Button>
                      </div>
                    }
                  >
                    <span className="flex items-center gap-2 truncate text-sm" title={m.filename}>
                      <span className="truncate">{m.filename}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(m.size_bytes)}</span>
                    </span>
                  </ListRow>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <FolderFilePreviewModal
        member={previewMember}
        open={previewMember !== null}
        onOpenChange={(open) => !open && setPreviewMember(null)}
      />
    </div>
  );
}
