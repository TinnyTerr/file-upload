import { useState } from "react";
import { Modal } from "../../../components/ui/Modal";
import { Button } from "../../../components/ui/Button";
import { QRCode } from "../../../components/ui/QRCode";
import { cn } from "../../../lib/cn";

function MiniBtn({ label, onClick }: { label: string; onClick: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        onClick();
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="shrink-0 rounded-[7px] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink-dim)] transition-colors hover:text-[var(--color-ink)]"
    >
      {done ? "✓" : label}
    </button>
  );
}

export interface ShareRow {
  label: string;
  value: string;
  filename?: string;
  open?: boolean;
}

export interface ShareSpec {
  title: string;
  subtitle?: string;
  rows: ShareRow[];
  hint?: { tone: "warn" | "accent"; text: string };
  qr?: string;
}

export function ShareModal({ spec, onClose }: { spec: ShareSpec | null; onClose: () => void }) {
  const copy = (t: string) => navigator.clipboard.writeText(t).catch(() => {});
  return (
    <Modal
      open={!!spec}
      onClose={onClose}
      title={spec?.title}
      width="max-w-lg"
      footer={<Button variant="ghost" onClick={onClose}>Done</Button>}
    >
      {spec && (
        <div className="space-y-3">
          {spec.subtitle && (
            <p className="text-sm text-[var(--color-ink-dim)]">{spec.subtitle}</p>
          )}
          {spec.rows.map((r, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1.5 pl-3"
            >
              <span className="w-12 shrink-0 font-[var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--color-ink-muted)]">
                {r.label}
              </span>
              <span className="min-w-0 flex-1 break-all font-[var(--font-mono)] text-[12px] text-[var(--color-ink-dim)]">
                {r.value}
              </span>
              <div className="flex shrink-0 gap-1.5">
                <MiniBtn label="Copy" onClick={() => copy(r.value)} />
                {r.filename && (
                  <>
                    <MiniBtn label="MD" onClick={() => copy(`[${r.filename}](${r.value})`)} />
                    <MiniBtn label="HTML" onClick={() => copy(`<a href="${r.value}">${r.filename}</a>`)} />
                  </>
                )}
                {r.open && (
                  <MiniBtn label="Open" onClick={() => window.open(r.value, "_blank", "noopener")} />
                )}
              </div>
            </div>
          ))}
          {spec.hint && (
            <p
              className={cn(
                "text-[13px] leading-relaxed",
                spec.hint.tone === "warn"
                  ? "text-[var(--color-warn)]"
                  : "text-[var(--color-accent)]",
              )}
            >
              {spec.hint.text}
            </p>
          )}
          {spec.qr && (
            <div className="flex justify-center pt-1">
              <QRCode value={spec.qr} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
