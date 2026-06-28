import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { FolderX, FolderArchive, Download, Save } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { EncryptionBanner } from "@/features/download/components/EncryptionBanner";
import { iconForType } from "@/features/files/lib/fileMeta";
import { useDirInfo, useFolderZip, downloadMember } from "../hooks/useFolderView";
import { readClientKeyFromHash, readServerKeyFromQuery } from "@/lib/download";
import { useAuth } from "@/features/auth/hooks/auth";
import { useSaveFolder } from "../hooks/useSaveFolder";
import { formatBytes } from "@/lib/bytes";

export function FolderPage() {
  const { slug = "" } = useParams();
  const { data: info, isLoading, isError } = useDirInfo(slug);
  const { user } = useAuth();
  const saveFolder = useSaveFolder();

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
              {info.uploader.has_avatar ? (
                <img
                  src={`/account/avatar/${info.uploader.user_id}`}
                  alt={info.uploader.username}
                  className="size-6 rounded-full object-cover"
                />
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white">
                  {info.uploader.username.slice(0, 2).toUpperCase()}
                </span>
              )}
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
            <ul className="space-y-1.5">
              {info.files.map((m) => {
                const Icon = iconForType(m.content_type);
                return (
                  <li key={m.slug} className="flex items-center gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm" title={m.filename}>
                      {m.filename}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatBytes(m.size_bytes)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={info.encryption_mode !== "none" && !hasKey}
                      onClick={() => downloadMember(m, info.encryption_mode, keys)}
                    >
                      <Download />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
