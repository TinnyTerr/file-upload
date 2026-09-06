import { Link2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { EncryptionBadge } from "@/features/files/lib/fileMeta";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/time";
import { useDropTarget } from "../../hooks/useDropTarget";
import { useExplorer } from "../../hooks/useExplorer";
import { type ColumnDef, columnWidth } from "../../lib/columns";
import { type DriveItem, itemKey, itemName } from "../../lib/items";
import { typeLabel } from "../../lib/typeLabel";
import { InlineRename } from "./InlineRename";
import { ItemThumb } from "./ItemThumb";

/** Just the modifier flags — the same shape `useDriveSelection.onItemClick`
 * takes, so a synthetic "toggle this one" can be expressed without faking a
 * whole MouseEvent. */
export interface ClickModifiers {
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

export interface ItemRowProps {
	item: DriveItem;
	columns: ColumnDef[];
	onOpen: (item: DriveItem) => void;
	onSelectClick: (item: DriveItem, e: ClickModifiers) => void;
	onRename: (item: DriveItem, name: string) => void;
	dragProps: React.HTMLAttributes<HTMLElement> & { draggable: boolean };
	cut?: boolean;
}

function cellValue(item: DriveItem, colId: string) {
	switch (colId) {
		case "date":
			return formatDate(
				item.kind === "folder" ? item.dir.created_at : item.file.created_at,
			);
		case "size":
			return item.kind === "folder"
				? item.dir.total_bytes
					? formatBytes(item.dir.total_bytes)
					: "—"
				: formatBytes(item.file.size_bytes);
		case "type":
			return typeLabel(item);
		default:
			return null;
	}
}

/** One row of the Details view. */
export function ItemRow({
	item,
	columns,
	onOpen,
	onSelectClick,
	onRename,
	dragProps,
	cut,
}: ItemRowProps) {
	const {
		selection,
		focusKey,
		setFocusKey,
		renameKey,
		setRenameKey,
		busy,
		prefs,
	} = useExplorer();
	const widths = prefs.columnWidths;
	const key = itemKey(item);
	const selected = selection.isSelected(item);
	const renaming = renameKey === key;

	// Only folders accept a drop; a file has nothing to put anything inside.
	const drop = useDropTarget(
		item.kind === "folder" ? { kind: "folder", dir: item.dir } : null,
	);

	return (
		<div
			role="row"
			aria-selected={selected}
			tabIndex={focusKey === key ? 0 : -1}
			data-item-key={key}
			{...dragProps}
			{...drop.dropProps}
			onClick={(e) => {
				setFocusKey(key);
				onSelectClick(item, e);
			}}
			onDoubleClick={() => onOpen(item)}
			className={cn(
				"group flex items-center border-b border-border/40 pr-3 text-sm outline-none transition-colors",
				selected ? "bg-primary/12" : "hover:bg-secondary/50",
				focusKey === key && "ring-1 ring-inset ring-primary/50",
				drop.active && "bg-primary/15 ring-1 ring-inset ring-primary/50",
				// A cut item stays put until the paste lands; dimming is the only
				// signal that it is queued to move.
				cut && "opacity-50",
			)}
		>
			{columns.map((col) => {
				const width = columnWidth(col, widths);
				if (col.id === "name") {
					return (
						<div
							key={col.id}
							role="gridcell"
							className="flex min-w-0 shrink-0 items-center gap-2 px-2 py-1.5"
							style={{ width, minWidth: col.minWidth }}
						>
							<Checkbox
								checked={selected}
								onCheckedChange={() => {}}
								onClick={(e) => {
									e.stopPropagation();
									// A checkbox always *toggles*, never replaces the
									// selection — that's the whole reason it exists next to
									// plain click-to-select.
									onSelectClick(item, {
										ctrlKey: true,
										metaKey: false,
										shiftKey: false,
									});
								}}
								aria-label={`Select ${itemName(item)}`}
								// Hidden until it is useful: hover, focus, or something
								// already selected. Same as Explorer.
								className={cn(
									"shrink-0 transition-opacity",
									!selected &&
										"opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
								)}
							/>
							<ItemThumb item={item} />
							{renaming ? (
								<InlineRename
									initial={itemName(item)}
									isFolder={item.kind === "folder"}
									busy={busy}
									onCommit={(name) => {
										setRenameKey(null);
										onRename(item, name);
									}}
									onCancel={() => setRenameKey(null)}
								/>
							) : (
								<span className="truncate">{itemName(item)}</span>
							)}
						</div>
					);
				}
				if (col.id === "encryption") {
					const mode =
						item.kind === "folder"
							? item.dir.encryption_mode
							: item.file.encryption_mode;
					const overridden =
						item.kind === "folder"
							? item.dir.encryption_overridden
							: item.file.encryption_overridden;
					return (
						<div
							key={col.id}
							role="gridcell"
							className="shrink-0 px-2 py-1.5"
							style={{ width, minWidth: col.minWidth }}
						>
							<EncryptionBadge mode={mode} inherited={!overridden} />
						</div>
					);
				}
				if (col.id === "links") {
					const n = item.kind === "file" ? item.file.links.length : null;
					return (
						<div
							key={col.id}
							role="gridcell"
							className="flex shrink-0 items-center justify-end gap-1 px-2 py-1.5 text-xs text-muted-foreground"
							style={{ width, minWidth: col.minWidth }}
						>
							{n ? (
								<>
									<Link2 className="size-3" />
									{n}
								</>
							) : null}
						</div>
					);
				}
				return (
					<div
						key={col.id}
						role="gridcell"
						className={cn(
							"shrink-0 truncate px-2 py-1.5 text-xs text-muted-foreground",
							col.align === "right" && "text-right",
						)}
						style={{ width, minWidth: col.minWidth }}
					>
						{cellValue(item, col.id)}
					</div>
				);
			})}
		</div>
	);
}
