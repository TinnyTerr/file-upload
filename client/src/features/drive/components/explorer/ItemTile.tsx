import { EncryptionBadge } from "@/features/files/lib/fileMeta";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { useDropTarget } from "../../hooks/useDropTarget";
import { useExplorer } from "../../hooks/useExplorer";
import { type DriveItem, itemKey, itemName } from "../../lib/items";
import { typeLabel } from "../../lib/typeLabel";
import { InlineRename } from "./InlineRename";
import type { ClickModifiers } from "./ItemRow";
import { ItemThumb } from "./ItemThumb";

/**
 * A tile in the Large icons / Tiles / List views. Same selection, drag and drop
 * contract as `ItemRow` — only the shape differs.
 *
 * `list` is a single dense line: Details without the columns. It is deliberately
 * one item per row rather than Windows' column-flowing List, because the
 * keyboard model already treats it as a vertical list and a column-flowing
 * layout would make ↓ mean two different things depending on the view.
 */
export function ItemTile({
	item,
	variant,
	onOpen,
	onSelectClick,
	onRename,
	dragProps,
	cut,
}: {
	item: DriveItem;
	variant: "icons" | "tiles" | "list";
	onOpen: (item: DriveItem) => void;
	onSelectClick: (item: DriveItem, e: ClickModifiers) => void;
	onRename: (item: DriveItem, name: string) => void;
	dragProps: React.HTMLAttributes<HTMLElement> & { draggable: boolean };
	cut?: boolean;
}) {
	const { selection, focusKey, setFocusKey, renameKey, setRenameKey, busy } =
		useExplorer();
	const key = itemKey(item);
	const selected = selection.isSelected(item);
	const renaming = renameKey === key;

	const drop = useDropTarget(
		item.kind === "folder" ? { kind: "folder", dir: item.dir } : null,
	);

	const subtitle =
		item.kind === "folder"
			? `${item.dir.subdirectory_count + item.dir.file_count} item${
					item.dir.subdirectory_count + item.dir.file_count === 1 ? "" : "s"
				}`
			: `${typeLabel(item)} · ${formatBytes(item.file.size_bytes)}`;

	return (
		<div
			role="gridcell"
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
				"flex cursor-default select-none rounded-lg border border-transparent outline-none transition-colors",
				variant === "icons" &&
					"w-32 flex-col items-center gap-1.5 p-2 text-center",
				variant === "tiles" && "items-center gap-3 p-2",
				variant === "list" && "items-center gap-2 px-2 py-1",
				selected
					? "border-primary/50 bg-primary/12"
					: "hover:border-border hover:bg-secondary/50",
				focusKey === key && "ring-1 ring-primary/50",
				drop.active && "border-primary bg-primary/15",
				cut && "opacity-50",
			)}
		>
			<ItemThumb item={item} size={variant === "list" ? "sm" : "lg"} />
			<div
				className={cn(
					"flex min-w-0 gap-0.5",
					variant === "list" ? "flex-1 items-center" : "flex-col",
					variant === "icons" ? "w-full items-center" : "flex-1",
				)}
			>
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
						className="w-full"
					/>
				) : (
					<span
						className={cn(
							"w-full text-sm",
							variant === "icons" ? "line-clamp-2 break-words" : "truncate",
						)}
						title={itemName(item)}
					>
						{itemName(item)}
					</span>
				)}
				{variant !== "list" && (
					<span className="truncate text-xs text-muted-foreground">
						{subtitle}
					</span>
				)}
				{variant === "tiles" && (
					<EncryptionBadge
						mode={
							item.kind === "folder"
								? item.dir.encryption_mode
								: item.file.encryption_mode
						}
						inherited={
							!(item.kind === "folder"
								? item.dir.encryption_overridden
								: item.file.encryption_overridden)
						}
					/>
				)}
			</div>
			{variant === "list" && (
				<span className="shrink-0 text-xs text-muted-foreground">
					{subtitle}
				</span>
			)}
		</div>
	);
}
