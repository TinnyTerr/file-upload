import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface PageHeaderProps {
	title: string;
	subtitle?: string;
	icon?: LucideIcon;
	/** Right-aligned actions slot (buttons etc). */
	actions?: ReactNode;
}

/** Standard page header: icon tile + title + subtitle, with an optional right-aligned actions slot. */
export function PageHeader({
	title,
	subtitle,
	icon: Icon,
	actions,
}: PageHeaderProps) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex items-center gap-3">
				{Icon && (
					<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-gradient shadow-lg shadow-primary/20">
						<Icon className="size-5 text-white" />
					</div>
				)}
				<div>
					<h1 className="text-2xl font-bold tracking-tight">{title}</h1>
					{subtitle && (
						<p className="text-sm text-muted-foreground">{subtitle}</p>
					)}
				</div>
			</div>
			{actions && <div className="flex items-center gap-2">{actions}</div>}
		</div>
	);
}
