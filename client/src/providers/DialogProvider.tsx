import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";

export interface AlertOpts {
  title?: string;
  message?: string;
  glyph?: string;
  kind?: "" | "error" | "success";
}
export interface ConfirmOpts {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  glyph?: string;
}
export interface PromptOpts {
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  glyph?: string;
}

interface DialogCtx {
  alert: (opts?: AlertOpts) => Promise<void>;
  confirm: (opts?: ConfirmOpts) => Promise<boolean>;
  prompt: (opts?: PromptOpts) => Promise<string | null>;
}

const Ctx = createContext<DialogCtx | null>(null);

export function useDialog(): DialogCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDialog must be used within DialogProvider");
  return c;
}

type Spec =
  | { kind: "alert"; opts: AlertOpts; resolve: (v: void) => void }
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

const GLYPH_BG: Record<string, string> = {
  danger: "bg-[var(--color-bad-soft)] text-[var(--color-bad)]",
  success: "bg-[var(--color-good-soft)] text-[var(--color-good)]",
  accent: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
};

export function DialogProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [field, setField] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => setSpec(null), []);

  const alert = useCallback(
    (opts: AlertOpts = {}) =>
      new Promise<void>((resolve) => setSpec({ kind: "alert", opts, resolve })),
    [],
  );
  const confirm = useCallback(
    (opts: ConfirmOpts = {}) =>
      new Promise<boolean>((resolve) => setSpec({ kind: "confirm", opts, resolve })),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOpts = {}) =>
      new Promise<string | null>((resolve) => {
        setField(opts.defaultValue || "");
        setSpec({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  function settle(value: unknown) {
    if (!spec) return;
    (spec.resolve as (v: unknown) => void)(value);
    close();
  }

  let glyph = "?";
  let glyphTone = "accent";
  let title = "";
  let message = "";
  let footer: ReactNode = null;

  if (spec) {
    const o = spec.opts as AlertOpts & ConfirmOpts & PromptOpts;
    message = o.message || "";
    if (spec.kind === "alert") {
      title = o.title || "Heads up";
      glyph = o.glyph || "!";
      glyphTone = o.kind === "error" ? "danger" : o.kind === "success" ? "success" : "accent";
      footer = (
        <Button onClick={() => settle(undefined)} autoFocus>
          OK
        </Button>
      );
    } else if (spec.kind === "confirm") {
      title = o.title || "Are you sure?";
      glyph = o.glyph || (o.danger ? "⚠" : "?");
      glyphTone = o.danger ? "danger" : "accent";
      footer = (
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            {o.cancelText || "Cancel"}
          </Button>
          <Button variant={o.danger ? "danger" : "primary"} onClick={() => settle(true)} autoFocus>
            {o.confirmText || "Confirm"}
          </Button>
        </>
      );
    } else {
      title = o.title || "Enter a value";
      glyph = o.glyph || "✎";
      footer = (
        <>
          <Button variant="ghost" onClick={() => settle(null)}>
            {o.cancelText || "Cancel"}
          </Button>
          <Button variant="primary" onClick={() => settle(field)}>
            {o.confirmText || "OK"}
          </Button>
        </>
      );
    }
  }

  const cancelValue = spec?.kind === "confirm" ? false : spec?.kind === "prompt" ? null : undefined;

  return (
    <Ctx.Provider value={{ alert, confirm, prompt }}>
      {children}
      <Modal
        open={!!spec}
        onClose={() => settle(cancelValue)}
        footer={footer}
        width="max-w-[460px]"
      >
        {spec && (
          <div className="flex gap-3.5">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-field)] text-lg ${GLYPH_BG[glyphTone]}`}
            >
              {glyph}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-[var(--font-display)] text-base font-semibold text-[var(--color-ink)]">
                {title}
              </div>
              {message && (
                <div className="mt-1 text-sm leading-relaxed text-[var(--color-ink-dim)]">
                  {message}
                </div>
              )}
              {spec.kind === "prompt" && (
                <input
                  ref={inputRef}
                  autoFocus
                  className="mt-3 h-10 w-full rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                  placeholder={spec.opts.placeholder}
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") settle(field);
                  }}
                />
              )}
            </div>
          </div>
        )}
      </Modal>
    </Ctx.Provider>
  );
}
