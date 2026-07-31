import { FolderInput, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DriveItem } from "../lib/items";

/** Bulk actions for a multi-item selection. Appears only once something is
 * selected, so it costs nothing in the common case. */
export function SelectionBar({
	items,
	onMove,
	onDelete,
	onClear,
	canDelete,
	busy,
}: {
	items: DriveItem[];
	onMove: () => void;
	onDelete: () => void;
	onClear: () => void;
	canDelete: boolean;
	busy?: boolean;
}) {
	if (!items.length) return null;
	const folders = items.filter((i) => i.kind === "folder").length;
	const files = items.length - folders;

	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2">
			<span className="text-sm font-medium">
				{[
					folders && `${folders} folder${folders === 1 ? "" : "s"}`,
					files && `${files} file${files === 1 ? "" : "s"}`,
				]
					.filter(Boolean)
					.join(" · ")}{" "}
				selected
			</span>
			<div className="ml-auto flex items-center gap-1.5">
				<Button size="sm" variant="outline" onClick={onMove} loading={busy}>
					<FolderInput /> Move
				</Button>
				{canDelete && (
					<Button
						size="sm"
						variant="outline"
						className="text-destructive"
						onClick={onDelete}
						loading={busy}
					>
						<Trash2 /> Delete
					</Button>
				)}
				<Button
					size="icon"
					variant="ghost"
					onClick={onClear}
					aria-label="Clear selection"
				>
					<X />
				</Button>
			</div>
		</div>
	);
}
