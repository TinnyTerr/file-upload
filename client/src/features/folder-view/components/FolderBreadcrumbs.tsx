import { ChevronRight, FolderArchive } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PublicDirCrumb } from "../services/publicDirService";

/** Path from the shared folder down to the one being viewed. Never above the
 * entry — what's above it isn't part of what was shared. */
export function FolderBreadcrumbs({
	trail,
	onNavigate,
}: {
	trail: PublicDirCrumb[];
	onNavigate: (dirId: number | null) => void;
}) {
	if (trail.length <= 1) return null;
	return (
		<nav
			aria-label="Folder path"
			className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm"
		>
			{trail.map((crumb, i) => {
				const last = i === trail.length - 1;
				return (
					<span key={crumb.id} className="flex shrink-0 items-center gap-1">
						{i > 0 && (
							<ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
						)}
						<button
							type="button"
							disabled={last}
							onClick={() => onNavigate(i === 0 ? null : crumb.id)}
							title={crumb.title}
							className={cn(
								"flex max-w-[14rem] items-center gap-1.5 truncate rounded-md px-2 py-1 transition-colors",
								last
									? "font-medium text-foreground"
									: "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
							)}
						>
							{i === 0 && <FolderArchive className="size-4 shrink-0" />}
							<span className="truncate">{crumb.title}</span>
						</button>
					</span>
				);
			})}
		</nav>
	);
}
