import { useState } from "react";
import { Save, Archive, Clock, Link2Off, RefreshCw, Trash2, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StorageRing, BarList, StatusPills, QuotaBars, Donut, StackedBar } from "./charts";
import { StatsGrid } from "./StatsGrid";
import { BulkConfirmDialog } from "./BulkConfirmDialog";
import { useStorageDetails, useStorageMutations } from "../hooks/useAdminDashboard";
import { useBulk } from "../hooks/useBulk";
import { formatBytes } from "@/lib/bytes";
import type { LifecycleJob } from "../types";

const JOBS: { id: LifecycleJob; label: string; icon: typeof Archive }[] = [
  { id: "archive-idle", label: "Archive idle", icon: Archive },
  { id: "temp-expiry", label: "Expire temp files", icon: Clock },
  { id: "link-expiry", label: "Expire links", icon: Link2Off },
  { id: "reconcile", label: "Reconcile states", icon: RefreshCw },
];

export function OverviewTab() {
  const { data, isLoading } = useStorageDetails();
  const { setCap, runJob } = useStorageMutations();
  const bulk = useBulk();
  const [capGb, setCapGb] = useState("");

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }

  const onSaveCap = () => {
    const gb = parseFloat(capGb);
    if (!Number.isFinite(gb) || gb <= 0) return;
    setCap.mutate(Math.round(gb * 1024 ** 3));
  };

  const sourceData = Object.entries(data.fun_stats.source_type_counts).map(([label, value]) => ({ label, value }));

  return (
    <div className="space-y-4">
      <StatsGrid data={data} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Global storage</CardTitle>
            <CardDescription>Used against the configured cap.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <StorageRing used={data.used_bytes} total={data.global_storage_quota_bytes} />
            <div className="grid w-full grid-cols-2 gap-2 text-center text-xs">
              <div className="rounded-md bg-secondary/30 p-2">
                <div className="font-semibold">{formatBytes(data.storage_summary.free_under_cap_bytes)}</div>
                <div className="text-muted-foreground">free under cap</div>
              </div>
              <div className="rounded-md bg-secondary/30 p-2">
                <div className="font-semibold">{formatBytes(data.allocated_quota_bytes)}</div>
                <div className="text-muted-foreground">allocated</div>
              </div>
            </div>
            <div className="flex w-full items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground">Set cap (GB)</label>
                <Input
                  type="number"
                  min={1}
                  placeholder={(data.global_storage_quota_bytes / 1024 ** 3).toFixed(0)}
                  value={capGb}
                  onChange={(e) => setCapGb(e.target.value)}
                />
              </div>
              <Button onClick={onSaveCap} loading={setCap.isPending}>
                <Save /> Save
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Per-user storage</CardTitle>
            <CardDescription>Top consumers by used bytes.</CardDescription>
          </CardHeader>
          <CardContent>
            <QuotaBars rows={data.fun_stats.top_storage_users.length ? data.fun_stats.top_storage_users : data.users} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Storage allocation</CardTitle>
          <CardDescription>How the global cap is divided.</CardDescription>
        </CardHeader>
        <CardContent>
          <StackedBar
            data={[
              { label: "used", value: data.used_bytes },
              { label: "allocated (free)", value: Math.max(0, data.allocated_quota_bytes - data.used_bytes) },
              { label: "unallocated", value: data.storage_summary.unallocated_quota_bytes },
            ]}
            formatValue={formatBytes}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Link status</CardTitle>
          </CardHeader>
          <CardContent>
            <Donut data={Object.entries(data.link_status_counts).map(([label, value]) => ({ label, value }))} unit="links" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">API key status</CardTitle>
          </CardHeader>
          <CardContent>
            <Donut data={Object.entries(data.api_key_status_counts).map(([label, value]) => ({ label, value }))} unit="keys" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload sources</CardTitle>
          </CardHeader>
          <CardContent>
            <Donut data={sourceData} unit="files" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">File types</CardTitle>
          </CardHeader>
          <CardContent>
            <Donut data={data.content_type_counts.slice(0, 6).map((c) => ({ label: c.content_type, value: c.count }))} unit="files" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top downloaded</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList data={data.fun_stats.top_downloaded_files.slice(0, 8).map((f) => ({ label: f.filename, value: f.downloads }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Biggest files</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              data={data.fun_stats.biggest_files.slice(0, 8).map((f) => ({ label: f.filename, value: f.size_bytes }))}
              formatValue={formatBytes}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Busiest folders</CardTitle>
        </CardHeader>
        <CardContent>
          <BarList
            data={data.fun_stats.busiest_directories.slice(0, 8).map((d) => ({ label: d.title, value: d.total_bytes }))}
            formatValue={formatBytes}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Links</p>
            <StatusPills counts={data.link_status_counts} />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">API keys</p>
            <StatusPills counts={data.api_key_status_counts} />
          </div>
          {Object.keys(data.lifecycle_counts).length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Lifecycle</p>
              <StatusPills counts={data.lifecycle_counts} />
            </div>
          )}
          {Object.keys(data.fun_stats.remote_upload_counts).length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Remote jobs</p>
              <StatusPills counts={data.fun_stats.remote_upload_counts} />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Run lifecycle jobs</CardTitle>
            <CardDescription>Trigger background maintenance immediately.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {JOBS.map((job) => (
              <Button
                key={job.id}
                variant="secondary"
                size="sm"
                onClick={() => runJob.mutate(job.id)}
                loading={runJob.isPending && runJob.variables === job.id}
              >
                <job.icon /> {job.label}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base">Global maintenance</CardTitle>
            <CardDescription>Repository-wide cleanup. Each needs confirmation.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={bulk.loading} onClick={() => bulk.startPreview("run_cleanup_jobs")}>
              <Wrench /> Run all cleanup jobs
            </Button>
            <Button variant="destructive" size="sm" loading={bulk.loading} onClick={() => bulk.startPreview("delete_inactive_links")}>
              <Trash2 /> Delete inactive links
            </Button>
          </CardContent>
        </Card>
      </div>

      <BulkConfirmDialog bulk={bulk} />
    </div>
  );
}
