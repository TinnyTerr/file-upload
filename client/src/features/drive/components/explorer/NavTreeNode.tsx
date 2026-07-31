import { ChevronRight, Folder, FolderOpen, HardDrive } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ContextMenu } from "@/components/ui/context-menu";
import type { Directory } from "@/features/directories/types";
import { cn } from "@/lib/cn";
import { useDriveChildren } from "../../hooks/useDrive";
import { useDropTarget } from "../../hooks/useDropTarget";
import { useExplorer } from "../../hooks/useExplorer";
import type { DriveItem } from "../../lib/items";
import { type DriveLocation, drivePath } from "../../types";

export interface NavTreeNodeProps {
	loc: DriveLocation;
	label: string;
	/** The row this node came from; absent for the synthetic root. */
	dir?: Directory;
	depth: number;
	expanded: Set<number>;
	onToggle: (id: number) => void;
	/** Where the explorer currently is, for the highlight. */
	currentId: number | null;
}

/**
 * One folder in the navigation pane.
 *
 * Written fresh rather than generalising `FolderPicker`: that component has
 * five consumers outside the explorer and is a *selection* control, with
 * `value`/`blocked`/`veto` semantics. This one needs drop targets, context
 * menus, route highlighting and auto-expansion. Merging them would produce a
 * twelve-prop component serving neither well; the genuinely shared part is
 * `useDriveChildren(loc, expanded)`, which is already a hook.
 */
export function NavTreeNode({
	loc,
	label,
	dir,
	depth,
	expanded,
	onToggle,
	currentId,
}: NavTreeNodeProps) {
	const navigate = useNavigate();
	const { menuFor } = useExplorer();
	const id = loc === "root" ? null : loc;
	const isOpen = id === null ? true : expanded.has(id);
	// Children are fetched only once a node is opened -- the tree walks the same
	// one-level endpoint the listing does, so a collapsed node costs nothing.
	const { data } = useDriveChildren(loc, isOpen);
	const isCurrent = currentId === id;

	const { active, dropProps } = useDropTarget(
		dir ? { kind: "folder", dir } : { kind: "current", dir: null },
	);

	const item: DriveItem | null = dir
		? { kind: "folder", id: dir.id, dir }
		: null;

	const row = (
		<div
			{...dropProps}
			className={cn(
				"group flex items-center gap-0.5 rounded-md pr-1 text-sm transition-colors",
				isCurrent
					? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
					: "hover:bg-secondary/60",
				active && "bg-primary/15 ring-1 ring-primary/40",
			)}
			style={{ paddingLeft: `${depth * 0.75}rem` }}
		>
			<button
				type="button"
				aria-label={isOpen ? `Collapse ${label}` : `Expand ${label}`}
				onClick={() => id !== null && onToggle(id)}
				className={cn(
					"rounded p-1 text-muted-foreground transition-colors hover:text-foreground",
					id === null && "invisible",
				)}
			>
				<ChevronRight
					className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
				/>
			</button>
			<button
				type="button"
				draggable={!!dir}
				onDragStart={(e) => {
					if (!item) return;
					e.dataTransfer.setData(
						"application/x-fileupload-drive-items",
						JSON.stringify([{ kind: "folder", id: item.id }]),
					);
					e.dataTransfer.effectAllowed = "move";
				}}
				onClick={() => navigate(drivePath(loc))}
				className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
			>
				{loc === "root" ? (
					<HardDrive className="size-4 shrink-0 text-muted-foreground" />
				) : isOpen ? (
					<FolderOpen className="size-4 shrink-0 text-primary/80" />
				) : (
					<Folder className="size-4 shrink-0 text-muted-foreground" />
				)}
				<span className="truncate">{label}</span>
			</button>
		</div>
	);

	return (
		<div role="treeitem" aria-expanded={isOpen} aria-selected={isCurrent}>
			{item ? <ContextMenu menu={menuFor(item)}>{row}</ContextMenu> : row}
			{isOpen && data && (
				<div role="group">
					{data.directories.map((d) => (
						<NavTreeNode
							key={d.id}
							loc={d.id}
							label={d.title}
							dir={d}
							depth={depth + 1}
							expanded={expanded}
							onToggle={onToggle}
							currentId={currentId}
						/>
					))}
				</div>
			)}
		</div>
	);
}
