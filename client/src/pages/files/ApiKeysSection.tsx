import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useToast } from "../../providers/ToastProvider";
import { useDialog } from "../../providers/DialogProvider";
import { Badge, Card, EmptyState, Eyebrow, Field, Input, Spinner } from "../../components/primitives";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import type { ApiKeyObj } from "./types";

export function ApiKeysSection() {
  const { showToast } = useToast();
  const dialog = useDialog();
  const [keys, setKeys] = useState<ApiKeyObj[] | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [pw, setPw] = useState("");

  async function load() {
    const resp = await apiFetch("/keys/");
    if (!resp.ok) return showToast("Failed to load API keys.", "error");
    const data = await resp.json();
    setKeys(data.keys.filter((k: ApiKeyObj) => k.active));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      load();
    } else showToast("Failed to revoke key.", "error");
  }

  async function confirmReset() {
    if (!pw || resetId == null) return;
    const resp = await apiFetch(`/keys/${resetId}/reset-ip`, { method: "POST", json: { password: pw } });
    setResetId(null);
    setPw("");
    if (resp.ok) {
      showToast("IP binding cleared.");
      load();
    } else {
      const d = await resp.json().catch(() => ({}));
      showToast(d.detail || "Failed to reset IP.", "error");
    }
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <Eyebrow>API keys</Eyebrow>
        <Button size="sm" onClick={create}>
          + New key
        </Button>
      </div>

      {keys === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-[var(--color-ink-muted)]">
          <Spinner /> Loading…
        </div>
      ) : keys.length === 0 ? (
        <EmptyState icon="🔑">No API keys yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {keys.map((k) => (
            <Card key={k.id} className="p-0 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2.5">
                <span className="font-[var(--font-mono)] font-medium text-[var(--color-ink)]">
                  Key #{k.user_key_number ?? k.id}
                </span>
                {k.bound_ip ? (
                  <Badge tone="neutral">📍 {k.bound_ip}</Badge>
                ) : (
                  <Badge tone="neutral">unbound</Badge>
                )}
                <div className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setResetId(k.id)}>
                    Reset IP
                  </Button>
                  <Button size="sm" variant="ghost" className="!text-[var(--color-bad)]" onClick={() => revoke(k.id)}>
                    Revoke
                  </Button>
                </div>
              </div>
              <div className="px-4 py-2 text-xs text-[var(--color-ink-muted)]">
                Created: {new Date(k.created_at).toLocaleString()}
                {k.last_used_at && ` · Last used: ${new Date(k.last_used_at).toLocaleString()}`}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* New key reveal */}
      <Modal
        open={!!newKey}
        onClose={() => {
          setNewKey(null);
          load();
        }}
        title="API key created"
        footer={
          <Button
            variant="ghost"
            onClick={() => {
              setNewKey(null);
              load();
            }}
          >
            Done
          </Button>
        }
      >
        <p className="mb-3 text-sm text-[var(--color-warn)]">⚠ Copy this key now — it won't be shown again.</p>
        <div className="mb-3 break-all rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] text-[var(--color-ink)]">
          {newKey}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            navigator.clipboard.writeText(newKey || "").then(() => showToast("Copied!")).catch(() => {});
          }}
        >
          Copy key
        </Button>
      </Modal>

      {/* Reset IP */}
      <Modal
        open={resetId != null}
        onClose={() => {
          setResetId(null);
          setPw("");
        }}
        title="Reset IP binding"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setResetId(null);
                setPw("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={confirmReset}>Reset IP</Button>
          </>
        }
      >
        <Field label="Confirm your password">
          <Input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmReset()}
          />
        </Field>
      </Modal>
    </section>
  );
}
