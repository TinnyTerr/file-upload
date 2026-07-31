import { ChevronRight, Folder, HardDrive, Loader2 } from "lucide-react";
import { useState } from "react";
import type { Directory } from "@/features/directories/types";
import { cn } from "@/lib/cn";
import { useDriveChildren } from "../hooks/useDrive";
import type { DriveLocation } from "../types";

interface NodeProps {
	loc: DriveLocation;
	label: string;
	/** The row this node was rendered from; absent for the root. */
	dir?: Directory;
	depth: number;
	value: number | null;
	onChange: (v: number | null) => void;
	/** Folder ids that can't be a destination — the ones being moved. Their
	 * subtrees are unreachable too, which is why a blocked node never expands. */
	blocked: Set<number>;
	blockedLabel: string;
	/** Per-folder veto: return a short reason to make a folder unselectable.
	 * Unlike `blocked`, this still lets the visitor expand *through* it — an
	 * end-to-end folder can perfectly well contain a usable subfolder. */
	veto?: (dir: Directory) => string | null;
	defaultExpanded?: boolean;
}

function Node({
	loc,
	label,
	dir,
	depth,
	value,
	onChange,
	blocked,
	blockedLabel,
	veto,
	defaultExpanded = false,
}: NodeProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const id = loc === "root" ? null : loc;
	const isBlocked = id !== null && blocked.has(id);
	const vetoed = dir && veto ? veto(dir) : null;
	const selectable = !isBlocked && !vetoed;
	const enabled = expanded && !isBlocked;
	// Children are only fetched once a node is opened -- the picker walks the
	// same one-level-at-a-time endpoint the explorer does, and a collapsed node
	// costs nothing.
	const { data, isLoading } = useDriveChildren(loc, enabled);

	return (
		<div>
			<div
				className={cn(
					"flex items-center gap-1 rounded-md pr-2 text-sm",
					value === id && selectable && "bg-primary/15 text-primary",
					!selectable && "opacity-50",
				)}
				style={{ paddingLeft: `${depth * 0.85}rem` }}
			>
				<button
					type="button"
					aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
					onClick={() => setExpanded((e) => !e)}
					disabled={isBlocked}
					className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none"
				>
					<ChevronRight
						className={cn(
							"size-3.5 transition-transform",
							expanded && "rotate-90",
						)}
					/>
				</button>
				<button
					type="button"
					onClick={() => selectable && onChange(id)}
					disabled={!selectable}
					className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left disabled:pointer-events-none"
				>
					{loc === "root" ? (
						<HardDrive className="size-4 shrink-0 text-muted-foreground" />
					) : (
						<Folder className="size-4 shrink-0 text-muted-foreground" />
					)}
					<span className="truncate">{label}</span>
					{(isBlocked || vetoed) && (
						<span className="shrink-0 text-xs text-muted-foreground">
							{isBlocked ? blockedLabel : vetoed}
						</span>
					)}
				</button>
			</div>
			{enabled && (
				<>
					{isLoading && (
						<p
							className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
							style={{ paddingLeft: `${(depth + 1) * 0.85 + 1.6}rem` }}
						>
							<Loader2 className="size-3 animate-spin" /> Loading…
						</p>
					)}
					{data?.directories.map((d) => (
						<Node
							key={d.id}
							loc={d.id}
							label={d.title}
							dir={d}
							depth={depth + 1}
							value={value}
							onChange={onChange}
							blocked={blocked}
							blockedLabel={blockedLabel}
							veto={veto}
						/>
					))}
					{!isLoading && data && data.directories.length === 0 && (
						<p
							className="py-1 text-xs text-muted-foreground"
							style={{ paddingLeft: `${(depth + 1) * 0.85 + 1.6}rem` }}
						>
							No subfolders
						</p>
					)}
				</>
			)}
		</div>
	);
}

/**
 * Expandable folder tree, lazy at every level.
 *
 * Shared by "Move to…" and by every "where should this land?" picker outside
 * the explorer (remote upload, receive links, torrents, the upload form) — a
 * flat `<select>` of folder titles stopped being meaningful the moment folders
 * could nest and two of them could share a name at different depths.
 */
export function FolderPicker({
	value,
	onChange,
	blocked,
	rootLabel = "My Drive",
	blockedLabel = "can't move here",
	veto,
	className,
}: {
	value: number | null;
	onChange: (v: number | null) => void;
	/** Folders that can't be chosen. Their subtrees are unreachable too. */
	blocked?: Set<number>;
	/** What selecting the root means here: the drive itself, or "no folder". */
	rootLabel?: string;
	blockedLabel?: string;
	/** Per-folder veto with a reason; the subtree stays browsable. */
	veto?: (dir: Directory) => string | null;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"max-h-72 overflow-y-auto rounded-md border border-border bg-secondary/20 p-1",
				className,
			)}
		>
			<Node
				loc="root"
				label={rootLabel}
				depth={0}
				value={value}
				onChange={onChange}
				blocked={blocked ?? EMPTY}
				blockedLabel={blockedLabel}
				veto={veto}
				defaultExpanded
			/>
		</div>
	);
}

const EMPTY: Set<number> = new Set();
