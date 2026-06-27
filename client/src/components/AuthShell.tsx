import { type ReactNode } from "react";
import { Wordmark } from "./Nav";

export function AuthShell({
  title,
  subtitle,
  children,
  foot,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-16">
      <div className="w-full max-w-[420px]">
        <div className="reveal mb-7 text-center">
          <div className="mb-5 flex justify-center">
            <Wordmark className="scale-110" />
          </div>
          <h1 className="font-[var(--font-display)] text-2xl font-bold text-[var(--color-ink)]">
            {title}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-dim)]">{subtitle}</p>
        </div>

        <div className="glass reveal rounded-[var(--radius-pop)] p-6 shadow-[var(--shadow-pop)]">
          {children}
        </div>

        {foot && (
          <p className="mt-6 text-center font-[var(--font-mono)] text-xs leading-relaxed text-[var(--color-ink-muted)]">
            {foot}
          </p>
        )}
      </div>
    </div>
  );
}

export function InlineAlert({
  kind,
  children,
}: {
  kind: "error" | "success" | "info";
  children: ReactNode;
}) {
  const tone =
    kind === "error"
      ? "border-l-[var(--color-bad)] bg-[var(--color-bad-soft)] text-[var(--color-bad)]"
      : kind === "success"
        ? "border-l-[var(--color-good)] bg-[var(--color-good-soft)] text-[var(--color-good)]"
        : "border-l-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]";
  return (
    <div className={`mb-4 rounded-[var(--radius-field)] border-l-[3px] px-3.5 py-2.5 text-sm ${tone}`}>
      {children}
    </div>
  );
}
