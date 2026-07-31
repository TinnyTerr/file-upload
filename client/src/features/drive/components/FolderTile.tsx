import { Folder, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Tooltip } from "@/components/ui/tooltip";
import type { Directory } from "@/features/directories/types";
import { EncryptionBadge } from "@/features/files/lib/fileMeta";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { drivePath } from "../types";

function contents(dir: Directory): string {
	const parts: string[] = [];
	if (dir.subdirectory_count)
		parts.push(
			`${dir.subdirectory_count} folder${dir.subdirectory_count === 1 ? "" : "s"}`,
		);
	parts.push(`${dir.file_count} file${dir.file_count === 1 ? "" : "s"}`);
	if (dir.total_bytes) parts.push(formatBytes(dir.total_bytes));
	return parts.join(" · ");
}

/** A folder in the explorer grid. The tile body is the link into the folder;
 * `menu` sits on top of it and swallows its own clicks. */
export function FolderTile({
	dir,
	menu,
	selected,
	dropActive,
	onSelectClick,
	containerProps,
}: {
	dir: Directory;
	menu?: ReactNode;
	selected?: boolean;
	/** Something is hovering over this tile mid-drag. */
	dropActive?: boolean;
	onSelectClick?: (e: React.MouseEvent) => void;
	containerProps?: React.HTMLAttributes<HTMLDivElement> & {
		draggable?: boolean;
	};
}) {
	const navigate = useNavigate();
	return (
		<div
			{...containerProps}
			className={cn(
				"group relative rounded-lg border border-border bg-secondary/20 transition-colors hover:border-primary/40 hover:bg-secondary/40",
				selected && "border-primary/60 bg-primary/10 hover:bg-primary/15",
				dropActive && "border-primary bg-primary/20 ring-2 ring-primary/40",
				containerProps?.className,
			)}
		>
			<div className="flex min-w-0 items-start gap-3 p-3">
				<Link
					to={drivePath(dir.id)}
					aria-label={`Open ${dir.title}`}
					className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Folder className="size-4 text-muted-foreground group-hover:hidden" />
					<FolderOpen className="hidden size-4 text-primary group-hover:block" />
				</Link>
				{/* The name selects; the icon and a double-click open. Same split
				    every file explorer uses, so a click doesn't navigate away from a
				    selection the user is still building. */}
				<button
					type="button"
					onClick={onSelectClick}
					onDoubleClick={() => navigate(drivePath(dir.id))}
					disabled={!onSelectClick}
					className="block min-w-0 flex-1 text-left disabled:cursor-default"
				>
					<div className="flex min-w-0 items-center gap-2">
						<span className="truncate text-sm font-medium" title={dir.title}>
							{dir.title}
						</span>
						{dir.encryption_mode !== "none" &&
							(dir.encryption_overridden ? (
								<EncryptionBadge mode={dir.encryption_mode} />
							) : (
								<Tooltip content="Encryption inherited from a folder above this one">
									<span>
										<EncryptionBadge mode={dir.encryption_mode} inherited />
									</span>
								</Tooltip>
							))}
					</div>
					<p className="mt-0.5 truncate text-xs text-muted-foreground">
						{contents(dir)}
					</p>
				</button>
				{menu && <div className="shrink-0">{menu}</div>}
			</div>
		</div>
	);
}
