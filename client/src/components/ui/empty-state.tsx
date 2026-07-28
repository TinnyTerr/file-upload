import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Illustrative placeholder for empty lists/tables. */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
				className,
			)}
		>
			<div className="relative flex size-16 items-center justify-center rounded-2xl border border-border bg-secondary/40">
				<div className="absolute inset-0 rounded-2xl bg-brand-gradient opacity-10 blur-xl" />
				<Icon className="size-7 text-muted-foreground" />
			</div>
			<div className="space-y-1">
				<h3 className="text-base font-semibold">{title}</h3>
				{description && (
					<p className="mx-auto max-w-sm text-sm text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			{action && <div className="mt-1">{action}</div>}
		</div>
	);
}
