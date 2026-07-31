import type { ReactNode } from "react";

/** A labelled fact in the details pane. */
export function Row({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-right">{children}</span>
		</div>
	);
}

export function Section({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="space-y-2 border-t border-border px-3 py-3 first:border-t-0">
			<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				{title}
			</h3>
			{children}
		</section>
	);
}
