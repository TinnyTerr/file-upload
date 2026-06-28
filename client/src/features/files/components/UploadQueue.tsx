import { X, CheckCircle2, AlertCircle, Lock } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/bytes";
import type { UploadItem } from "../hooks/useUpload";

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  encrypting: "Encrypting",
  uploading: "Uploading",
  finalizing: "Finalizing",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

function StatusIcon({ status }: { status: UploadItem["status"] }) {
  if (status === "done") return <CheckCircle2 className="size-4 text-success" />;
  if (status === "error") return <AlertCircle className="size-4 text-destructive" />;
  if (status === "encrypting") return <Lock className="size-4 text-primary" />;
  return null;
}

export function UploadQueue({
  items,
  onCancel,
}: {
  items: UploadItem[];
  onCancel: (id: string) => void;
}) {
  if (!items.length) return null;

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const active = item.status === "encrypting" || item.status === "uploading" || item.status === "finalizing";
        return (
          <li key={item.id} className="rounded-lg border border-border bg-secondary/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <StatusIcon status={item.status} />
                <span className="truncate text-sm font-medium" title={item.filename}>
                  {item.filename}
                </span>
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {formatBytes(item.size)}
                {active && (
                  <Tooltip content="Cancel">
                    <Button variant="ghost" size="icon" className="size-6" onClick={() => onCancel(item.id)}>
                      <X className="size-3.5" />
                    </Button>
                  </Tooltip>
                )}
              </span>
            </div>
            {active && <Progress value={item.percent} className="mt-2 h-1.5" />}
            <p className="mt-1 text-xs text-muted-foreground">
              {PHASE_LABEL[item.status]}
              {active && ` · ${item.percent}%`}
              {item.status === "error" && item.error && ` · ${item.error}`}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
