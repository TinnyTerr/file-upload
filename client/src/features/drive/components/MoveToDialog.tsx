import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { type DriveItem, itemName } from "../lib/items";
import { FolderPicker } from "./FolderPicker";

/** "Move to…" — the keyboard-and-mouse alternative to dragging a tile. */
export function MoveToDialog({
	items,
	open,
	onOpenChange,
	currentDirectoryId,
	onMove,
	busy,
}: {
	items: DriveItem[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentDirectoryId: number | null;
	onMove: (destination: number | null) => Promise<boolean>;
	busy?: boolean;
}) {
	const [destination, setDestination] = useState<number | null>(
		currentDirectoryId,
	);

	useEffect(() => {
		if (open) setDestination(currentDirectoryId);
	}, [open, currentDirectoryId]);

	// A folder can't be moved into itself or anything below it; the picker
	// refuses to open those branches rather than letting the server say no.
	const blocked = new Set(
		items.filter((i) => i.kind === "folder").map((i) => i.id),
	);

	const label =
		items.length === 1 ? `“${itemName(items[0])}”` : `${items.length} items`;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Move {label}</DialogTitle>
					<DialogDescription>
						Pick the folder to move into. Encryption doesn't follow the move —
						what's already encrypted stays under the key it has now.
					</DialogDescription>
				</DialogHeader>
				<FolderPicker
					value={destination}
					onChange={setDestination}
					blocked={blocked}
				/>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						loading={busy}
						disabled={destination === currentDirectoryId}
						onClick={async () => {
							if (await onMove(destination)) onOpenChange(false);
						}}
					>
						Move here
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
