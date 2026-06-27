import { useEffect, useRef, useState } from "react";
import { apiFetch, formatDate } from "../../lib/api";
import { useToast } from "../../providers/ToastProvider";
import { Badge, Card, Input, Select, Spinner } from "../../components/primitives";
import { Button } from "../../components/Button";
import type { AuditEntry } from "./types";

const LIMIT = 50;

function actionTone(action: string): "good" | "bad" | "warn" | "neutral" {
  if (/(deleted|deactivat|revoked|broken|failed)/i.test(action)) return "bad";
  if (/(created|uploaded|added|login)/i.test(action)) return "good";
  if (/(updated|edited|changed|reset)/i.test(action)) return "warn";
  return "neutral";
}

export function AuditTab() {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [chainOk, setChainOk] = useState(true);
  const [total, setTotal] = useState(0);
  const [filtered, setFiltered] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(off = offset) {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(off) });
    if (q.trim()) params.set("q", q.trim());
    if (action) params.set("action", action);
    const resp = await apiFetch(`/audit/?${params.toString()}`);
    setLoading(false);
    if (!resp.ok) return showToast("Failed to load audit log.", "error");
    const data = await resp.json();
    setEntries(data.entries);
    setActions(data.actions || []);
    setChainOk(!!data.chain_ok);
    setTotal(Number(data.total_count || 0));
    setFiltered(Number(data.filtered_count || 0));
  }

  // Reload when offset/action change, debounced for q.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, action]);

  function onSearch(value: string) {
    setQ(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setOffset(0);
      load(0);
    }, 220);
  }

  return (
    <div className="space-y-4">
      <Card className="flex items-center gap-2.5">
        <Badge tone={chainOk ? "good" : "bad"}>{chainOk ? "verified" : "broken"}</Badge>
        <span className="text-sm text-[var(--color-ink-dim)]">
          {chainOk
            ? "Audit log integrity is verified."
            : "Audit log integrity failed. Treat the log as potentially tampered until investigated."}
        </span>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search actor, action, target, IP…" value={q} onChange={(e) => onSearch(e.target.value)} className="max-w-xs" />
        <Select value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} className="max-w-[200px]">
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          onClick={() => {
            setQ("");
            setAction("");
            setOffset(0);
            load(0);
          }}
        >
          Clear
        </Button>
        <Button variant="ghost" onClick={() => load()}>Refresh</Button>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--color-surface-2)] text-left font-[var(--font-mono)] text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
              <th className="px-3 py-2.5">#</th>
              <th className="px-3 py-2.5">Actor</th>
              <th className="px-3 py-2.5">Action</th>
              <th className="px-3 py-2.5">Target</th>
              <th className="px-3 py-2.5">IP</th>
              <th className="px-3 py-2.5">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--color-ink-muted)]">
                  <Spinner /> Loading…
                </td>
              </tr>
            ) : !entries.length ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--color-ink-muted)]">
                  No audit entries match the filters.
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="hover:bg-[var(--color-surface-2)]/40">
                  <td className="px-3 py-2 font-[var(--font-mono)] text-xs">{e.id}</td>
                  <td className="px-3 py-2 font-[var(--font-mono)] text-xs">{e.actor}</td>
                  <td className="px-3 py-2">
                    <Badge tone={actionTone(e.action)}>{e.action}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-ink-muted)]">{e.target || "–"}</td>
                  <td className="px-3 py-2 font-[var(--font-mono)] text-xs text-[var(--color-ink-muted)]">{e.ip || "–"}</td>
                  <td className="px-3 py-2 text-xs text-[var(--color-ink-muted)]">{formatDate(e.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-[var(--color-ink-muted)]">
        <span>
          {entries.length
            ? `${offset + 1}–${offset + entries.length} of ${filtered.toLocaleString()}${filtered !== total ? ` filtered (${total.toLocaleString()} total)` : ""}`
            : "No audit entries"}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
            Prev
          </Button>
          <Button size="sm" variant="ghost" disabled={offset + entries.length >= filtered} onClick={() => setOffset(offset + LIMIT)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
