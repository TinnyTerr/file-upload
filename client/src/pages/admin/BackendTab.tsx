import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, formatDate } from "../../lib/api";
import { useToast } from "../../providers/ToastProvider";
import { useDialog } from "../../providers/DialogProvider";
import { Input, Select, Toggle } from "../../components/primitives";
import { Button } from "../../components/Button";
import { cn } from "../../lib/cn";
import type { BackendLogEntry } from "./types";

const LEVEL_TONE: Record<string, string> = {
  debug: "text-[var(--color-ink-muted)]",
  info: "text-[var(--color-cyan)]",
  warning: "text-[var(--color-warn)]",
  error: "text-[var(--color-bad)]",
  critical: "text-[var(--color-bad)]",
};

export function BackendTab() {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [entries, setEntries] = useState<BackendLogEntry[]>([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("");
  const [auto, setAuto] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qRef = useRef(q);
  const levelRef = useRef(level);
  qRef.current = q;
  levelRef.current = level;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "300" });
    if (qRef.current.trim()) params.set("q", qRef.current.trim());
    if (levelRef.current) params.set("level", levelRef.current);
    const resp = await apiFetch(`/admin/backend/logs?${params.toString()}`);
    if (!resp.ok) return showToast("Failed to load backend logs.", "error");
    const data = await resp.json();
    setEntries(data.entries || []);
    setStatus(`${Number(data.filtered_count || 0).toLocaleString()} shown / ${Number(data.total_count || 0).toLocaleString()} captured`);
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 3s while enabled.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [auto, load]);

  function onSearch(v: string) {
    setQ(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(load, 220);
  }

  async function restart() {
    const ok = await dialog.confirm({
      title: "Restart backend workers?",
      message:
        "This restarts the background scheduler jobs for lifecycle scans, cleanup, link expiry, and stale upload cleanup. Active HTTP requests are not restarted.",
      confirmText: "Restart workers",
      danger: true,
    });
    if (!ok) return;
    setRestarting(true);
    const resp = await apiFetch("/admin/backend/restart-workers", { method: "POST", json: {} });
    setRestarting(false);
    if (!resp.ok) return showToast("Failed to restart backend workers.", "error");
    const d = await resp.json();
    showToast(`Backend workers ${d.status}.`);
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Filter logs…" value={q} onChange={(e) => onSearch(e.target.value)} className="max-w-xs" />
        <Select value={level} onChange={(e) => { setLevel(e.target.value); setTimeout(load, 0); }} className="max-w-[160px]">
          <option value="">All levels</option>
          <option value="DEBUG">Debug</option>
          <option value="INFO">Info</option>
          <option value="WARNING">Warning</option>
          <option value="ERROR">Error</option>
          <option value="CRITICAL">Critical</option>
        </Select>
        <Toggle checked={auto} onChange={setAuto} label="Auto-refresh" />
        <Button variant="ghost" onClick={load}>Refresh</Button>
        <Button variant="danger" disabled={restarting} onClick={restart} className="ml-auto">
          {restarting ? "Restarting…" : "Restart workers"}
        </Button>
      </div>

      <div className="text-xs text-[var(--color-ink-muted)]">{status}</div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-canvas-2)]/40 font-[var(--font-mono)] text-[12px]">
        {!entries.length ? (
          <div className="px-3 py-8 text-center text-[var(--color-ink-muted)]">No backend logs match the filters.</div>
        ) : (
          <div className="divide-y divide-[var(--color-line)]">
            {entries.map((e, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5">
                <span className="shrink-0 text-[var(--color-ink-muted)]">{formatDate(e.created_at)}</span>
                <span className={cn("shrink-0 font-semibold uppercase", LEVEL_TONE[(e.level || "info").toLowerCase()])}>
                  {e.level || "INFO"}
                </span>
                <span className="shrink-0 text-[var(--color-accent)]">{e.logger || "app"}</span>
                <span className="min-w-0 flex-1 break-words text-[var(--color-ink-dim)]">{e.message || ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
