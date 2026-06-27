import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "ghost" | "danger" | "subtle";
type Size = "md" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  full?: boolean;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-field)] font-medium transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50 disabled:pointer-events-none select-none";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-gradient-to-b from-[var(--color-accent-hover)] to-[var(--color-accent)] text-[var(--color-accent-ink)] font-semibold shadow-[var(--shadow-soft)] hover:from-[#b3a6ff] hover:to-[var(--color-accent-hover)] hover:-translate-y-px active:translate-y-0",
  ghost:
    "bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] border border-[var(--color-line)] hover:text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface-3)]",
  subtle:
    "bg-transparent text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-2)]",
  danger:
    "bg-[var(--color-bad)] text-white font-semibold hover:bg-[var(--color-bad-hover)] hover:-translate-y-px active:translate-y-0",
};

const SIZES: Record<Size, string> = {
  md: "h-10 px-4 text-sm",
  sm: "h-8 px-3 text-[13px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", full, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], full && "w-full", className)}
      {...rest}
    />
  );
});
