import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
  leaving?: boolean;
}

interface ToastCtx {
  showToast: (msg: string, kind?: ToastKind) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast must be used within ToastProvider");
  return c;
}

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-l-[var(--color-good)]",
  error: "border-l-[var(--color-bad)]",
  info: "border-l-[var(--color-accent)]",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const showToast = useCallback((msg: string, kind: ToastKind = "success") => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => {
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 260);
    }, 3500);
  }, []);

  return (
    <Ctx.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[120] flex flex-col gap-2.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "glass pointer-events-auto min-w-[220px] max-w-[360px] rounded-[var(--radius-field)] border-l-4 px-4 py-3 text-sm text-[var(--color-ink)] shadow-[var(--shadow-pop)]",
              KIND_STYLES[t.kind],
              t.leaving ? "animate-[toast-in_0.22s_reverse_forwards]" : "animate-[toast-in_0.3s_var(--ease-out)]",
            )}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
