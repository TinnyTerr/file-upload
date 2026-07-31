import { Clipboard, FolderPlus, RotateCw } from "lucide-react";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";

/** Right-clicking the empty background of the listing. */
export function BackgroundMenuItems({
	canCreate,
	onNewFolder,
	onPaste,
	pasteReason,
	onRefresh,
}: {
	canCreate: boolean;
	onNewFolder: () => void;
	onPaste: () => void;
	/** Non-null disables paste; it is also what the item explains. */
	pasteReason: string | null;
	onRefresh: () => void;
}) {
	return (
		<>
			<DropdownMenuItem disabled={!canCreate} onSelect={onNewFolder}>
				<FolderPlus /> New folder
				<DropdownMenuShortcut>⌃⇧N</DropdownMenuShortcut>
			</DropdownMenuItem>
			<DropdownMenuItem disabled={!!pasteReason} onSelect={onPaste}>
				<Clipboard /> Paste
				<DropdownMenuShortcut>⌃V</DropdownMenuShortcut>
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={onRefresh}>
				<RotateCw /> Refresh
				<DropdownMenuShortcut>F5</DropdownMenuShortcut>
			</DropdownMenuItem>
		</>
	);
}
