import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one full-page error surface: a big status code, a line of explanation
 * and whatever actions the caller can offer.
 *
 * Deliberately dependency-free beyond `cn` and the theme tokens — it is
 * rendered by `RootErrorBoundary` after a render has already failed, so it
 * must not reach for the router, a query client or a provider that might be
 * the thing that broke.
 */
export function ErrorPage({
	code,
	title,
	description,
	actions,
	className,
}: {
	code?: string | number;
	title: string;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-dvh flex-col items-center justify-center gap-3 px-6 py-16 text-center",
				className,
			)}
		>
			{code !== undefined && (
				<p className="text-gradient text-6xl font-extrabold leading-none tracking-tight">
					{code}
				</p>
			)}
			<div className="space-y-1">
				<h1 className="text-lg font-semibold">{title}</h1>
				{description && (
					<div className="mx-auto max-w-md text-sm text-muted-foreground">
						{description}
					</div>
				)}
			</div>
			{actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
		</div>
	);
}
