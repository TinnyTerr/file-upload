import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Floating action bar that animates in when rows are selected. */
export function BulkBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: React.ReactNode;
}) {
  const open = count > 0;
  return (
    <div
      inert={!open ? "" : undefined}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4 transition-all duration-300",
        open ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0",
      )}
      aria-hidden={!open}
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border glass px-3 py-2 shadow-xl shadow-black/25">
        <span className="flex items-center gap-2 pl-1 pr-1 text-sm">
          <span className="flex size-6 items-center justify-center rounded-full bg-brand-gradient text-xs font-bold text-primary-foreground">
            {count}
          </span>
          selected
        </span>
        <div className="h-5 w-px bg-border" />
        {children}
        <div className="h-5 w-px bg-border" />
        <Button variant="ghost" size="icon" className="size-8 rounded-full" onClick={onClear} aria-label="Clear selection">
          <X />
        </Button>
      </div>
    </div>
  );
}
