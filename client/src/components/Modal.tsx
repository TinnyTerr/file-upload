import { useEffect, type ReactNode } from "react";
import { cn } from "../lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Max width class (default narrow). */
  width?: string;
  /** Disable backdrop-click / Escape close. */
  locked?: boolean;
}

export function Modal({ open, onClose, title, children, footer, width = "max-w-md", locked }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, locked]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm animate-[overlay-in_0.18s_ease]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "glass my-[8vh] w-full rounded-[var(--radius-pop)] p-5 shadow-[var(--shadow-pop)] animate-[modal-in_0.24s_var(--ease-out)]",
          width,
        )}
      >
        {title && (
          <div className="mb-3 font-[var(--font-display)] text-lg font-semibold text-[var(--color-ink)]">
            {title}
          </div>
        )}
        {children}
        {footer && <div className="mt-5 flex justify-end gap-2.5">{footer}</div>}
      </div>
    </div>
  );
}
