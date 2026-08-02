import { ChevronRight, Folder, FolderOpen, Home } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { useBrowse } from "../hooks/useDirectories";

/** A small nested folder-tree navigator used to pick a destination for
 * move-file / move-folder actions. Reuses the same browse() endpoint as the
 * main file browser rather than a separate "folder tree" API. */
export function MoveDialog({
	open,
	onOpenChange,
	title,
	description,
	/** Folder id (and everything under it) that can't be picked -- used when
	 * moving a folder itself, so it can't become its own descendant. The
	 * backend also rejects this; this just avoids a round trip. */
	excludeDirId,
	currentDirId,
	onConfirm,
	confirming,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	excludeDirId?: number;
	currentDirId: number | null;
	onConfirm: (targetId: number | null) => void;
	confirming?: boolean;
}) {
	const [cursor, setCursor] = useState<number | null>(null);
	const { data, isLoading } = useBrowse(cursor);

	const folders = (data?.folders ?? []).filter((f) => f.id !== excludeDirId);
	const disabled = cursor === currentDirId;

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				onOpenChange(o);
				if (!o) setCursor(null);
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>

				<div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
					<button
						type="button"
						className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary/50 hover:text-foreground"
						onClick={() => setCursor(null)}
					>
						<Home className="size-3" /> Root
					</button>
					{(data?.breadcrumb ?? []).map((c) => (
						<span key={c.id} className="flex items-center gap-1">
							<ChevronRight className="size-3" />
							<button
								type="button"
								className="rounded px-1.5 py-0.5 hover:bg-secondary/50 hover:text-foreground"
								onClick={() => setCursor(c.id)}
							>
								{c.title}
							</button>
						</span>
					))}
				</div>

				<div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-1.5">
					{isLoading ? (
						<>
							<Skeleton className="h-8 w-full" />
							<Skeleton className="h-8 w-full" />
						</>
					) : folders.length === 0 ? (
						<EmptyState
							icon={FolderOpen}
							title="No subfolders here"
							description="You can still move into this folder."
						/>
					) : (
						folders.map((f) => (
							<button
								key={f.id}
								type="button"
								disabled={f.locked}
								onClick={() => setCursor(f.id)}
								className={cn(
									"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/50",
									f.locked && "cursor-not-allowed opacity-50",
								)}
							>
								<Folder className="size-4 shrink-0 text-muted-foreground" />
								<span className="truncate">{f.title}</span>
							</button>
						))
					)}
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={disabled}
						loading={confirming}
						onClick={() => onConfirm(cursor)}
					>
						Move here
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
