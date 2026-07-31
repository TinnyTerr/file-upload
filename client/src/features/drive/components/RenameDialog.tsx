import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type DriveItem, itemName } from "../lib/items";

export function RenameDialog({
	item,
	open,
	onOpenChange,
	onRename,
	busy,
}: {
	item: DriveItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRename: (name: string) => Promise<boolean>;
	busy?: boolean;
}) {
	const [name, setName] = useState("");

	useEffect(() => {
		if (open && item) setName(itemName(item));
	}, [open, item]);

	if (!item) return null;

	const submit = async () => {
		const trimmed = name.trim();
		if (!trimmed || trimmed === itemName(item)) {
			onOpenChange(false);
			return;
		}
		if (await onRename(trimmed)) onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>
						Rename {item.kind === "folder" ? "folder" : "file"}
					</DialogTitle>
				</DialogHeader>
				<div className="space-y-1.5">
					<Label htmlFor="rename-input">Name</Label>
					<Input
						id="rename-input"
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
						}}
					/>
					{item.kind === "file" && (
						<p className="text-xs text-muted-foreground">
							Only the display name changes — storage is content-addressed and
							never named after the upload.
						</p>
					)}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={submit} loading={busy} disabled={!name.trim()}>
						Rename
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
