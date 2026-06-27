import { Badge, Card, EmptyState, Eyebrow, Field, Input, Spinner } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { useApiKeys } from "../hooks/useApiKeys";

export function ApiKeysSection() {
  const {
    keys, newKey, resetId, pw, setPw,
    create, revoke, confirmReset,
    openReset, closeNewKey, closeReset, copyKey,
  } = useApiKeys();

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
                  <Button size="sm" variant="ghost" onClick={() => openReset(k.id)}>
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
        onClose={closeNewKey}
        title="API key created"
        footer={
          <Button variant="ghost" onClick={closeNewKey}>
            Done
          </Button>
        }
      >
        <p className="mb-3 text-sm text-[var(--color-warn)]">⚠ Copy this key now — it won't be shown again.</p>
        <div className="mb-3 break-all rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] text-[var(--color-ink)]">
          {newKey}
        </div>
        <Button size="sm" variant="ghost" onClick={copyKey}>
          Copy key
        </Button>
      </Modal>

      {/* Reset IP */}
      <Modal
        open={resetId != null}
        onClose={closeReset}
        title="Reset IP binding"
        footer={
          <>
            <Button variant="ghost" onClick={closeReset}>
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
