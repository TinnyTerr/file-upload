import { useEffect, useState } from "react";
import { formatBytes, parseSize } from "../../../lib/api";
import { useToast } from "../../../providers/ToastProvider";
import { Card, Eyebrow, Input, Spinner } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { fetchStorage, runLifecycle as runLifecycleJob, updateStorageCap } from "../services/adminService";
import { BarList, DashCard, MetricTile, StatList, StatusPills, StorageRing } from "./charts";

interface StorageData {
  global_storage_quota_bytes: number;
  used_bytes: number;
  allocated_quota_bytes: number;
  storage_summary?: { free_under_cap_bytes?: number };
  total_files?: number;
  active_links?: number;
  total_links?: number;
  total_api_keys?: number;
  dedup_saved_bytes?: number;
  archive_saved_bytes?: number;
  disk?: { free_bytes?: number };
  users?: { username: string; used_bytes?: number; quota_bytes?: number | null }[];
  content_type_counts?: { content_type: string; count: number; stored_bytes?: number }[];
  lifecycle_counts?: Record<string, number>;
  link_status_counts?: Record<string, number>;
  api_key_status_counts?: Record<string, number>;
  recent_audit_counts?: { action: string; count: number }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fun_stats?: any;
}

const LIFECYCLE_BTNS = [
  { path: "/admin/lifecycle/archive-idle", label: "Archive idle" },
  { path: "/admin/lifecycle/temp-expiry", label: "Temp expiry" },
  { path: "/admin/lifecycle/link-expiry", label: "Link expiry" },
  { path: "/admin/lifecycle/reconcile", label: "Reconcile" },
];

export function OverviewTab({ version, bump }: { version: number; bump: () => void }) {
  const { showToast } = useToast();
  const [d, setD] = useState<StorageData | null>(null);
  const [cap, setCap] = useState("");
  const [lifeResult, setLifeResult] = useState("");
  const [busyPath, setBusyPath] = useState("");

  async function load() {
    try {
      const data: StorageData = await fetchStorage();
      setD(data);
      setCap(formatBytes(data.global_storage_quota_bytes));
    } catch {
      showToast("Failed to load storage details.", "error");
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function saveCap() {
    const bytes = parseSize(cap);
    if (bytes === null) return showToast('Invalid cap — use "500 GB"', "error");
    try {
      await updateStorageCap(bytes);
      showToast("Storage cap updated.");
      bump();
    } catch {
      showToast("Failed to update cap.", "error");
    }
  }

  async function runLifecycle(path: string) {
    setBusyPath(path);
    try {
      const res = await runLifecycleJob(path);
      const msg = `Last run processed ${res.processed ?? 0} item(s).`;
      setLifeResult(msg);
      showToast(msg);
      bump();
    } catch {
      showToast("Lifecycle action failed.", "error");
    } finally {
      setBusyPath("");
    }
  }

  if (!d)
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-[var(--color-ink-muted)]">
        <Spinner /> Loading…
      </div>
    );

  const fun = d.fun_stats || {};
  const typeTotal = (d.content_type_counts || []).reduce((s, r) => s + (r.stored_bytes || 0), 0);

  return (
    <div className="space-y-5">
      {/* Storage cap + ring */}
      <Card>
        <div className="flex flex-col gap-5 md:flex-row md:items-center">
          <StorageRing used={d.used_bytes} total={d.global_storage_quota_bytes} />
          <div className="flex-1 space-y-3">
            <div>
              <Eyebrow>Global storage cap</Eyebrow>
              <div className="mt-1.5 flex gap-2">
                <Input value={cap} onChange={(e) => setCap(e.target.value)} className="max-w-[200px]" />
                <Button onClick={saveCap}>Save</Button>
              </div>
            </div>
            <BarList
              rows={[
                { label: "Used storage", value: d.used_bytes, total: d.global_storage_quota_bytes, bytes: true, tone: "capacity" },
                { label: "Allocated quotas", value: d.allocated_quota_bytes, total: d.global_storage_quota_bytes, bytes: true },
                { label: "Free under cap", value: d.storage_summary?.free_under_cap_bytes || 0, total: d.global_storage_quota_bytes, bytes: true },
              ]}
            />
          </div>
        </div>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <MetricTile label="Files" value={Number(d.total_files || 0).toLocaleString()} sub="stored objects" />
        <MetricTile label="Links" value={`${Number(d.active_links || 0).toLocaleString()} / ${Number(d.total_links || 0).toLocaleString()}`} sub="active / total" />
        <MetricTile label="API keys" value={Number(d.total_api_keys || 0).toLocaleString()} sub="all users" />
        <MetricTile label="Dedup savings" value={formatBytes(d.dedup_saved_bytes || 0)} sub="duplicate blobs" />
        <MetricTile label="Archive savings" value={formatBytes(d.archive_saved_bytes || 0)} sub="archiving" />
        <MetricTile label="Disk free" value={formatBytes(d.disk?.free_bytes || 0)} sub="filesystem" />
        <MetricTile label="Users" value={Number((d.users || []).length).toLocaleString()} sub="accounts" />
      </div>

      {/* Charts grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DashCard title="Per-user storage">
          <BarList
            rows={(d.users || []).map((u) => ({
              label: u.username,
              value: u.used_bytes || 0,
              total: u.quota_bytes || Math.max(u.used_bytes || 0, 1),
              bytes: true,
              tone: "capacity",
            }))}
          />
        </DashCard>
        <DashCard title="File types">
          <BarList
            rows={(d.content_type_counts || []).map((r) => ({
              label: r.content_type,
              value: r.stored_bytes || 0,
              total: typeTotal || 1,
              bytes: true,
            }))}
          />
        </DashCard>
        <DashCard title="Lifecycle states">
          <StatusPills
            counts={d.lifecycle_counts}
            labels={{
              active: { label: "active", color: "var(--color-good)" },
              archived: { label: "archived", color: "var(--color-accent)" },
              archiving: { label: "archiving", color: "var(--color-warn)" },
              unarchiving: { label: "unarchiving", color: "var(--color-warn)" },
            }}
          />
        </DashCard>
        <DashCard title="Links status">
          <StatusPills
            counts={d.link_status_counts}
            labels={{
              active: { label: "active", color: "var(--color-good)" },
              inactive: { label: "inactive", color: "var(--color-ink-muted)" },
              expired: { label: "expired", color: "var(--color-bad)" },
              used_up: { label: "used up", color: "var(--color-warn)" },
            }}
          />
        </DashCard>
        <DashCard title="API keys status">
          <StatusPills
            counts={d.api_key_status_counts}
            labels={{
              active: { label: "active", color: "var(--color-good)" },
              inactive: { label: "revoked", color: "var(--color-ink-muted)" },
              bound: { label: "IP bound", color: "var(--color-accent)" },
              unbound: { label: "unbound", color: "var(--color-ink-dim)" },
            }}
          />
        </DashCard>
        <DashCard title="Recent audit activity">
          <BarList
            rows={(d.recent_audit_counts || []).map((r) => ({
              label: r.action,
              value: r.count || 0,
              total: (d.recent_audit_counts || []).reduce((s, x) => s + (x.count || 0), 0) || 1,
            }))}
          />
        </DashCard>
      </div>

      {/* Fun stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatList
          title="Most downloaded"
          rows={(fun.top_downloaded_files || []).map((r: { filename: string; downloads?: number; id: number }) => ({
            label: r.filename,
            value: `${Number(r.downloads || 0).toLocaleString()} dl`,
            sub: `file ${r.id}`,
          }))}
        />
        <StatList
          title="Biggest files"
          rows={(fun.biggest_files || []).map((r: { filename: string; size_bytes?: number; stored_size_bytes?: number }) => ({
            label: r.filename,
            value: formatBytes(r.size_bytes || 0),
            sub: `stored ${formatBytes(r.stored_size_bytes || 0)}`,
          }))}
        />
        <StatList
          title="Top storage users"
          rows={(fun.top_storage_users || []).map((r: { username: string; used_bytes?: number; quota_bytes?: number }) => ({
            label: r.username,
            value: formatBytes(r.used_bytes || 0),
            sub: r.quota_bytes ? `of ${formatBytes(r.quota_bytes)}` : "",
          }))}
        />
        <StatList
          title="Upload sources"
          rows={Object.entries(fun.source_type_counts || {}).map(([source, count]) => ({
            label: source,
            value: Number(count || 0).toLocaleString(),
          }))}
        />
        <StatList
          title="Busy folders"
          rows={(fun.busiest_directories || []).map((r: { title: string; file_count?: number; total_bytes?: number }) => ({
            label: r.title,
            value: `${Number(r.file_count || 0).toLocaleString()} files`,
            sub: formatBytes(r.total_bytes || 0),
          }))}
        />
        <StatList
          title="Remote jobs"
          rows={Object.entries(fun.remote_upload_counts || {}).map(([status, count]) => ({
            label: status,
            value: Number(count || 0).toLocaleString(),
          }))}
        />
      </div>

      {/* Lifecycle controls */}
      <Card>
        <Eyebrow>Lifecycle controls</Eyebrow>
        <div className="mt-3 flex flex-wrap gap-2">
          {LIFECYCLE_BTNS.map((b) => (
            <Button key={b.path} variant="ghost" disabled={busyPath === b.path} onClick={() => runLifecycle(b.path)}>
              {busyPath === b.path ? "Running…" : b.label}
            </Button>
          ))}
        </div>
        {lifeResult && <div className="mt-2 text-sm text-[var(--color-ink-muted)]">{lifeResult}</div>}
      </Card>
    </div>
  );
}
