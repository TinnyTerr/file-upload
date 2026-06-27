import { type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TabDef {
  id: string;
  label: ReactNode;
}

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto border-b border-[var(--color-line)]",
        className,
      )}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "relative whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors",
            active === t.id
              ? "text-[var(--color-ink)]"
              : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink-dim)]",
          )}
        >
          {t.label}
          {active === t.id && (
            <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-cyan)]" />
          )}
        </button>
      ))}
    </div>
  );
}
