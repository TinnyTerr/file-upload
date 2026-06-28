import { cn } from "@/lib/cn";

/** Shimmering placeholder block. Compose to mirror real layout (zero CLS). */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-secondary/60",
        "before:absolute before:inset-0 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-white/5 before:to-transparent before:[animation:var(--animate-shimmer)]",
        className,
      )}
      {...props}
    />
  );
}
