import { Boxes } from "lucide-react";
import { cn } from "@/lib/cn";

/** App wordmark + logo. */
export function Brand({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-gradient shadow-lg shadow-primary/20">
        <Boxes className="size-5 text-primary-foreground" />
      </div>
      {!collapsed && (
        <div className="flex flex-col leading-none">
          <span className="text-base font-bold tracking-tight">Oxymoron</span>
          <span className="text-[11px] text-muted-foreground">(for files)</span>
        </div>
      )}
    </div>
  );
}
