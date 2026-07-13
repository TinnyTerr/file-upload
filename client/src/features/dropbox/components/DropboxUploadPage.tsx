import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, CheckCircle2, FileWarning, UploadCloud, FileIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Dropzone } from "@/features/files/components/Dropzone";
import { dropboxService } from "../services/dropboxService";
import { formatBytes } from "@/lib/bytes";
import { ApiError } from "@/config/api";

export function DropboxUploadPage({ token }: { token: string }) {
  const info = useQuery({
    queryKey: ["dropbox", token],
    queryFn: () => dropboxService.info(token),
    enabled: !!token,
    retry: false,
  });

  const [file, setFile] = useState<File | null>(null);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [phase, setPhase] = useState<"uploading" | "finalizing">("uploading");
  const [error, setError] = useState<string | null>(null);

  const upload = async () => {
    if (!file) return;
    setStatus("uploading");
    setPhase("uploading");
    setPercent(0);
    setError(null);
    try {
      await dropboxService.upload(token, file, file.name, (progress) => {
        setPhase(progress.phase);
        setPercent(progress.percent);
      });
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStatus("error");
    }
  };

  if (info.isLoading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  // 404/410 → link never existed, already used, or expired.
  if (info.isError) {
    const gone = info.error instanceof ApiError && info.error.status === 410;
    return (
      <EmptyState
        icon={FileWarning}
        title={gone ? "This link has already been used or expired" : "Receive link not found"}
        description="Ask the recipient to send you a new link."
      />
    );
  }

  if (status === "done") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-success/15">
            <CheckCircle2 className="size-7 text-success" />
          </div>
          <h1 className="break-words text-xl font-bold">File sent</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Your file was uploaded successfully. This one-time link is now closed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-xl bg-brand-gradient shadow-lg shadow-primary/20">
            <Inbox className="size-6 text-white" />
          </div>
          <div>
            <h1 className="break-words text-xl font-bold">Send a file</h1>
            <p className="text-sm text-muted-foreground">Upload one file to the person who shared this link.</p>
          </div>
        </div>

        {!file ? (
          <Dropzone multiple={false} onFiles={(fs) => setFile(fs[0] ?? null)} hint="One file only" />
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-2">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm">{file.name}</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {formatBytes(file.size)}
              {status === "idle" && (
                <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                  Change
                </Button>
              )}
            </span>
          </div>
        )}

        {status === "uploading" && <Progress value={percent} />}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button className="w-full" size="lg" disabled={!file || status === "uploading"} loading={status === "uploading"} onClick={upload}>
          <UploadCloud /> {status === "uploading" ? (phase === "finalizing" ? "Finalizing…" : `Uploading… ${percent}%`) : "Upload file"}
        </Button>
      </CardContent>
    </Card>
  );
}
