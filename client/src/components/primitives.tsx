import {
  forwardRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../lib/cn";

/* ── Layout ──────────────────────────────────────────────────────────────── */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-5xl px-6 py-10", className)}>{children}</div>;
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "glass rounded-[var(--radius-card)] p-5 shadow-[var(--shadow-soft)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("eyebrow", className)}>{children}</div>;
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */
const FIELD =
  "h-10 w-full rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-ink)] outline-none transition-colors placeholder:text-[var(--color-ink-muted)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/25";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(FIELD, className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(FIELD, "cursor-pointer", className)} {...rest}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(FIELD, "h-auto min-h-20 py-2 font-[var(--font-mono)]", className)}
        {...rest}
      />
    );
  },
);

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      {label && (
        <span className="mb-1.5 block font-[var(--font-mono)] text-[11px] uppercase tracking-wider text-[var(--color-ink-muted)]">
          {label}
        </span>
      )}
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-ink-muted)]">{hint}</span>}
    </label>
  );
}

/* ── Toggle switch ───────────────────────────────────────────────────────── */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5 select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-[var(--radius-pill)] transition-colors",
          checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-3)]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
      {label && <span className="text-sm text-[var(--color-ink-dim)]">{label}</span>}
    </label>
  );
}

/* ── Badge ───────────────────────────────────────────────────────────────── */
type BadgeTone = "neutral" | "good" | "bad" | "warn" | "accent";
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--color-surface-3)] text-[var(--color-ink-dim)]",
  good: "bg-[var(--color-good-soft)] text-[var(--color-good)]",
  bad: "bg-[var(--color-bad-soft)] text-[var(--color-bad)]",
  warn: "bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
  accent: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
};
export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 font-[var(--font-mono)] text-[11px] font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Progress ────────────────────────────────────────────────────────────── */
export function ProgressBar({ percent, tone }: { percent: number; tone?: BadgeTone }) {
  const color =
    tone === "bad"
      ? "var(--color-bad)"
      : tone === "warn"
        ? "var(--color-warn)"
        : tone === "good"
          ? "var(--color-good)"
          : "var(--color-accent)";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-surface-3)]">
      <div
        className="h-full rounded-[var(--radius-pill)] transition-[width] duration-200"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: color }}
      />
    </div>
  );
}

/* ── Empty / spinner ─────────────────────────────────────────────────────── */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-[spin_0.7s_linear_infinite] rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function EmptyState({ icon = "⟐", children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center text-[var(--color-ink-muted)]">
      <div className="text-3xl opacity-60">{icon}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/* ── Segmented control (mode group) ──────────────────────────────────────── */
export interface ModeOption {
  value: string;
  label: ReactNode;
}
export function ModeGroup({
  options,
  value,
  onChange,
  className,
}: {
  options: ModeOption[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex gap-1 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition-colors",
            value === o.value
              ? "bg-[var(--color-accent)] text-[var(--color-accent-ink)]"
              : "text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Copy helpers ────────────────────────────────────────────────────────── */
export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
}: {
  value: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={cn(
        "shrink-0 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-surface-2)] font-medium text-[var(--color-ink-dim)] transition-colors hover:text-[var(--color-ink)]",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
      )}
    >
      {done ? "Copied!" : label}
    </button>
  );
}

export function CopyRow({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-field)] border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1.5 pl-3">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink-dim)]",
          mono && "font-[var(--font-mono)]",
        )}
      >
        {value}
      </span>
      <CopyButton value={value} />
    </div>
  );
}
