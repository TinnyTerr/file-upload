import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "./Nav";

/** Minimal chrome for public share pages (download / directory). */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-canvas)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-6">
          <Link to="/">
            <Wordmark />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">{children}</main>
    </>
  );
}

export function PublicBanner({ tone, children }: { tone: "info" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-l-[var(--color-bad)] bg-[var(--color-bad-soft)] text-[var(--color-bad)]"
      : "border-l-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink-dim)]";
  return (
    <div className={`mb-6 rounded-[var(--radius-field)] border-l-[3px] px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}
