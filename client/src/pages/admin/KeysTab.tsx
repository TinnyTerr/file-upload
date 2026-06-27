import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useToast } from "../../providers/ToastProvider";
import { useDialog } from "../../providers/DialogProvider";
import { Badge, Card, EmptyState, Field, Input, Select, Spinner } from "../../components/primitives";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import type { AdminKey, Selection } from "./types";

interface Props {
  version: number;
  bump: () => void;
  selection: Selection;
  toggleSel: (kind: keyof Selection, id: number) => void;
}

export function KeysTab({ version, bump, selection, toggleSel }: Props) {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [keys, setKeys] = useState<AdminKey[] | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [pw, setPw] = useState("");

  async function load() {
    const resp = await apiFetch("/admin/keys");
    if (!resp.ok) return showToast("Failed to load API keys.", "error");
    const data = await resp.json();
    setKeys(data.keys || []);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const needle = filter.trim().toLowerCase();
  const shown = (keys || []).filter((k) => {
    if (statusFilter === "active" && !k.active) return false;
    if (statusFilter === "inactive" && k.active) return false;
    if (statusFilter === "bound" && !k.bound_ip) return false;
    if (statusFilter === "unbound" && k.bound_ip) return false;
    if (!needle) return true;
    return [k.owner_username, `uid:${k.owner_id}`, String(k.owner_id), String(k.user_key_number ?? k.id), k.bound_ip || ""].some(
      (v) => (v || "").toLowerCase().includes(needle),
    );
  });

  async function create() {
    const resp = await apiFetch("/keys/", { method: "POST", json: {} });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      return showToast(d.detail || "Failed to create key.", "error");
    }
    const data = await resp.json();
    setNewKey(data.key);
  }
  async function revoke(id: number) {
    const ok = await dialog.confirm({
      title: "Revoke API key?",
      message: "Any integration using this key will immediately stop working. This cannot be undone.",
      confirmText: "Revoke key",
      danger: true,
    });
    if (!ok) return;
    const resp = await apiFetch(`/keys/${id}`, { method: "DELETE" });
    if (resp.ok) {
      showToast("Key revoked.");
      bump();
    } else showToast("Failed to revoke key.", "error");
  }
  async function confirmReset() {
    if (!pw || resetId == null) return;
    const resp = await apiFetch(`/keys/${resetId}/reset-ip`, { method: "POST", json: { password: pw } });
    setResetId(null);
    setPw("");
    if (resp.ok) {
      showToast("IP binding cleared.");
      bump();
    } else {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Failed to reset IP.", "error");
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input placeholder="Filter keys…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-[160px]">
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="inactive">Revoked</option>
          <option value="bound">IP bound</option>
          <option value="unbound">Unbound</option>
        </Select>
        <Button className="ml-auto" onClick={create}>
          + New key
        </Button>
      </div>

      {keys === null ? (
        <div className="flex items-center gap-2 py-10 text-sm text-[var(--color-ink-muted)]">
          <Spinner /> Loading…
        </div>
      ) : !keys.length ? (
        <EmptyState icon="🔑">No API keys yet.</EmptyState>
      ) : !shown.length ? (
        <EmptyState icon="⌕">No API keys match the filter.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((k) => (
            <Card key={k.id} className="p-0 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={selection.keys.has(k.id)}
                  onChange={() => toggleSel("keys", k.id)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="font-[var(--font-mono)] font-medium text-[var(--color-ink)]">
                  Key #{k.user_key_number ?? k.id}
                </span>
                <Badge tone="neutral">{k.owner_username || `uid:${k.owner_id}`}</Badge>
                <span className="text-xs text-[var(--color-ink-muted)]">{k.bound_ip ? `📍 ${k.bound_ip}` : "unbound"}</span>
                <Badge tone={k.active ? "good" : "neutral"}>{k.active ? "active" : "inactive"}</Badge>
                {k.active && (
                  <div className="ml-auto flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setResetId(k.id)}>Reset IP</Button>
                    <Button size="sm" variant="ghost" className="!text-[var(--color-bad)]" onClick={() => revoke(k.id)}>Revoke</Button>
                  </div>
                )}
              </div>
              <div className="px-4 py-2 text-xs text-[var(--color-ink-muted)]">
                Created: {new Date(k.created_at).toLocaleString()}
                {k.last_used_at && ` · Last used: ${new Date(k.last_used_at).toLocaleString()}`}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={!!newKey}
        onClose={() => {
          setNewKey(null);
          bump();
        }}
        title="API key created"
        footer={<Button variant="ghost" onClick={() => { setNewKey(null); bump(); }}>Done</Button>}
      >
        <p className="mb-3 text-sm text-[var(--color-warn)]">⚠ Copy this key now — it won't be shown again.</p>
        <div className="mb-3 break-all rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] text-[var(--color-ink)]">
          {newKey}
        </div>
        <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(newKey || "").then(() => showToast("Copied!")).catch(() => {}); }}>
          Copy key
        </Button>
      </Modal>

      <Modal
        open={resetId != null}
        onClose={() => { setResetId(null); setPw(""); }}
        title="Reset IP binding"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setResetId(null); setPw(""); }}>Cancel</Button>
            <Button onClick={confirmReset}>Reset IP</Button>
          </>
        }
      >
        <Field label="Confirm your password">
          <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmReset()} />
        </Field>
      </Modal>
    </div>
  );
}
