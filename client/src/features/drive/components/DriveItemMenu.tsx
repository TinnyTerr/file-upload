import {
	Download,
	FolderInput,
	FolderOpen,
	Lock,
	Pencil,
	Share2,
	Trash2,
} from "lucide-react";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { isKeyHeldByUser } from "@/features/files/types";
import type { DriveItem } from "../lib/items";

export interface DriveActions {
	open: (item: DriveItem) => void;
	share: (item: DriveItem) => void;
	download: (item: DriveItem) => void;
	rename: (item: DriveItem) => void;
	encryption: (item: DriveItem) => void;
	move: (items: DriveItem[]) => void;
	remove: (items: DriveItem[]) => void;
}

export interface DrivePermissions {
	canDelete: boolean;
	canRename: boolean;
	canShare: boolean;
}

/**
 * The body of both the right-click menu and the per-item "⋮" menu.
 *
 * `items` is the effective selection: right-clicking inside a multi-item
 * selection acts on the whole thing, right-clicking outside it collapses to
 * the one item. Single-item actions (rename, open, share) only appear when
 * there is exactly one.
 */
export function DriveItemMenu({
	items,
	actions,
	perms,
}: {
	items: DriveItem[];
	actions: DriveActions;
	perms: DrivePermissions;
}) {
	const single = items.length === 1 ? items[0] : null;
	// A client- or sealed-mode file downloads as ciphertext, which is only
	// useful with the key -- that route is the public page, not this menu.
	const downloadable =
		single?.kind === "file" &&
		single.file.links.length > 0 &&
		!isKeyHeldByUser(single.file.encryption_mode);
	// Sharing means handing over a link, so a file whose last link was deleted
	// has nothing to share -- `actions.share` would silently do nothing.
	const shareable =
		single?.kind === "folder" ||
		(single?.kind === "file" && single.file.links.length > 0);

	return (
		<>
			{single?.kind === "folder" && (
				<DropdownMenuItem onSelect={() => actions.open(single)}>
					<FolderOpen /> Open
				</DropdownMenuItem>
			)}
			{downloadable && single && (
				<DropdownMenuItem onSelect={() => actions.download(single)}>
					<Download /> Download
				</DropdownMenuItem>
			)}
			{single && perms.canShare && shareable && (
				<DropdownMenuItem onSelect={() => actions.share(single)}>
					<Share2 /> Share…
				</DropdownMenuItem>
			)}
			{single && perms.canRename && (
				<DropdownMenuItem onSelect={() => actions.rename(single)}>
					<Pencil /> Rename…
				</DropdownMenuItem>
			)}
			{single && (
				<DropdownMenuItem onSelect={() => actions.encryption(single)}>
					<Lock /> Encryption…
				</DropdownMenuItem>
			)}
			<DropdownMenuItem onSelect={() => actions.move(items)}>
				<FolderInput /> Move to…
			</DropdownMenuItem>
			{perms.canDelete && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem destructive onSelect={() => actions.remove(items)}>
						<Trash2 />
						{items.length > 1 ? `Delete ${items.length} items` : "Delete"}
					</DropdownMenuItem>
				</>
			)}
		</>
	);
}
