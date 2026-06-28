import { HardDrive } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes, percent } from "@/lib/bytes";
import { useUsage } from "../hooks/useUsage";
import { cn } from "@/lib/cn";

export function UsageMeter() {
  const { data, isLoading } = useUsage();

  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-2 w-full" />
        <Skeleton className="mt-2 h-3 w-24" />
      </Card>
    );
  }

  const pct = percent(data.used_bytes, data.quota_bytes);
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <HardDrive className="size-4 text-muted-foreground" />
          Storage
        </div>
        <Tooltip content={`Per-file limit: ${formatBytes(data.max_file_bytes)}`}>
          <span className="text-xs text-muted-foreground">{pct.toFixed(0)}% used</span>
        </Tooltip>
      </div>
      <Progress
        value={pct}
        className="mt-3"
        indicatorClassName={cn(
          tone === "danger" && "!bg-destructive",
          tone === "warn" && "!bg-warning",
        )}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {formatBytes(data.used_bytes)} of {formatBytes(data.quota_bytes)}
      </p>
    </Card>
  );
}
