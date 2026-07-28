import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ListRowProps {
	/** Leading slot — icon tile or avatar, rendered before the main content. */
	leading?: ReactNode;
	/** Main/center content — takes up remaining width, should handle its own truncation. */
	children: ReactNode;
	/** Trailing slot — actions, badges, buttons. Rendered right-aligned. */
	trailing?: ReactNode;
	/** Optional content shown below a divider, e.g. expanded details. */
	footer?: ReactNode;
	/** Disable the hover background transition (e.g. for static/non-interactive rows). */
	noHover?: boolean;
	className?: string;
}

/** Shared bordered-row layout used across files, folders, keys, and admin lists. */
export function ListRow({
	leading,
	children,
	trailing,
	footer,
	noHover,
	className,
}: ListRowProps) {
	return (
		<div
			className={cn(
				"rounded-lg border border-border bg-secondary/20",
				!noHover && "transition-colors hover:bg-secondary/30",
				className,
			)}
		>
			<div className="flex items-center gap-3 px-3 py-2">
				{leading}
				<div className="min-w-0 flex-1">{children}</div>
				{trailing && (
					<div className="flex items-center gap-1.5">{trailing}</div>
				)}
			</div>
			{footer && (
				<div className="border-t border-border px-3 py-2.5">{footer}</div>
			)}
		</div>
	);
}
