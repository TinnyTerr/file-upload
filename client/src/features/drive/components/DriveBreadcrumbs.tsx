import { ChevronRight, HardDrive } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import type { Breadcrumb } from "../types";
import { drivePath } from "../types";

/** Root-first path to the open folder. The last crumb is where you are, so it
 * isn't a link. Folders can nest ten deep, so the strip scrolls rather than
 * wrapping into the toolbar. */
export function DriveBreadcrumbs({ trail }: { trail: Breadcrumb[] }) {
	return (
		<nav
			aria-label="Folder path"
			className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm"
		>
			<Link
				to={drivePath("root")}
				className={cn(
					"flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
					trail.length === 0
						? "font-medium text-foreground"
						: "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
				)}
			>
				<HardDrive className="size-4" />
				My Drive
			</Link>
			{trail.map((crumb, i) => {
				const last = i === trail.length - 1;
				return (
					<span key={crumb.id} className="flex shrink-0 items-center gap-1">
						<ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
						{last ? (
							<span
								aria-current="page"
								className="max-w-[16rem] truncate rounded-md px-2 py-1 font-medium"
								title={crumb.title}
							>
								{crumb.title}
							</span>
						) : (
							<Link
								to={drivePath(crumb.id)}
								title={crumb.title}
								className="max-w-[10rem] truncate rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
							>
								{crumb.title}
							</Link>
						)}
					</span>
				);
			})}
		</nav>
	);
}
