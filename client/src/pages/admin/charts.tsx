import type { ReactNode } from "react";
import { formatBytes } from "../../lib/api";
import { Card } from "../../components/primitives";

function pctOf(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
}

export interface BarRow {
  label: string;
  value: number;
  total: number;
  bytes?: boolean;
  tone?: "capacity" | "info";
}

export function BarList({ rows }: { rows: BarRow[] }) {
  const filtered = rows.filter((r) => r.value > 0 || r.total > 0);
  if (!filtered.length)
    return <div className="text-sm text-[var(--color-ink-muted)]">No data yet.</div>;
  return (
    <div className="space-y-2.5">
      {filtered.slice(0, 8).map((r, i) => {
        const pct = pctOf(r.value, r.total || 1);
        const tone =
          r.tone === "capacity" ? (pct >= 90 ? "bad" : pct >= 70 ? "warn" : "accent") : "accent";
        const color =
          tone === "bad" ? "var(--color-bad)" : tone === "warn" ? "var(--color-warn)" : "var(--color-accent)";
        return (
          <div key={i}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-[var(--color-ink-dim)]">{r.label}</span>
              <span className="shrink-0 font-[var(--font-mono)] text-[var(--color-ink-muted)]">
                {r.bytes
                  ? `${formatBytes(r.value)} / ${formatBytes(r.total)} (${pct.toFixed(1)}%)`
                  : r.value.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-surface-3)]">
              <div className="h-full rounded-[var(--radius-pill)]" style={{ width: `${pct}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface PillDef {
  label: string;
  color?: string;
}
export function StatusPills({
  counts,
  labels,
}: {
  counts: Record<string, number> | undefined;
  labels: Record<string, PillDef>;
}) {
  const entries = Object.entries(counts || {});
  if (!entries.length)
    return <div className="text-sm text-[var(--color-ink-muted)]">No data yet.</div>;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, value]) => {
        const info = labels[key] || { label: key.replaceAll("_", " ") };
        return (
          <div
            key={key}
            className="flex items-center gap-1.5 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-1.5"
          >
            <strong className="font-[var(--font-mono)] text-sm" style={{ color: info.color }}>
              {Number(value || 0).toLocaleString()}
            </strong>
            <span className="text-xs text-[var(--color-ink-dim)]">{info.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-2)]/50 p-3.5">
      <div className="font-[var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)]">
        {label}
      </div>
      <div className="mt-1 font-[var(--font-display)] text-xl font-semibold text-[var(--color-ink)]">
        {value}
      </div>
      {sub && <div className="text-xs text-[var(--color-ink-muted)]">{sub}</div>}
    </div>
  );
}

export function StorageRing({ used, total }: { used: number; total: number }) {
  const pct = pctOf(used, total);
  const radius = 48;
  const circ = 2 * Math.PI * radius;
  return (
    <div className="relative grid place-items-center">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--color-surface-3)" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="url(#ringGrad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${((circ * pct) / 100).toFixed(1)} ${circ.toFixed(1)}`}
        />
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" />
            <stop offset="100%" stopColor="var(--color-cyan)" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute text-center">
        <div className="font-[var(--font-display)] text-lg font-bold text-[var(--color-ink)]">
          {pct.toFixed(1)}%
        </div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)]">used</div>
      </div>
    </div>
  );
}

export function StatList({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; sub?: string }[];
}) {
  return (
    <Card>
      <div className="mb-2 font-[var(--font-display)] text-sm font-semibold text-[var(--color-ink)]">
        {title}
      </div>
      {!rows.length ? (
        <div className="text-sm text-[var(--color-ink-muted)]">No data yet.</div>
      ) : (
        <div className="divide-y divide-[var(--color-line)]">
          {rows.slice(0, 6).map((r, i) => (
            <div key={i} className="flex items-center gap-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-[var(--color-ink-dim)]">{r.label}</span>
              <span className="shrink-0 font-[var(--font-mono)] text-xs text-[var(--color-ink)]">
                {r.value}
              </span>
              {r.sub && <span className="shrink-0 text-xs text-[var(--color-ink-muted)]">{r.sub}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function DashCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-3 font-[var(--font-display)] text-sm font-semibold text-[var(--color-ink)]">
        {title}
      </div>
      {children}
    </Card>
  );
}
