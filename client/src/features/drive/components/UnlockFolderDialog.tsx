import { KeyRound } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyFolderKey } from "@/features/directories/lib/folderKey";
import type { Directory } from "@/features/directories/types";

/** Pull the key out of a pasted share URL, or accept a bare key. */
function extractClientKey(value: string): string {
	const trimmed = value.trim();
	const idx = trimmed.indexOf("#ek=");
	if (idx === -1) return trimmed;
	return trimmed.slice(idx + 4).split(/[?&#]/)[0];
}

/**
 * An end-to-end folder's key never reached this server, so the browser has to
 * be handed it before anything can be encrypted *into* that folder. The key is
 * checked against the folder's `key_check_blob` before we accept it -- getting
 * this wrong silently would produce a folder full of files nobody can read.
 */
export function UnlockFolderDialog({
	dir,
	open,
	onOpenChange,
	onUnlocked,
}: {
	dir: Directory;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onUnlocked: (key: Uint8Array) => void;
}) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setError(null);
		if (!dir.key_check_blob) {
			setError("This folder has no key check stored; it can't be verified.");
			return;
		}
		setBusy(true);
		try {
			const key = await verifyFolderKey(
				extractClientKey(value),
				dir.key_check_blob,
			);
			setValue("");
			onOpenChange(false);
			onUnlocked(key);
		} catch (err) {
			setError(
				err instanceof Error && err.message
					? err.message
					: "That key doesn't open this folder.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<KeyRound className="size-4" /> Unlock “{dir.title}”
					</DialogTitle>
					<DialogDescription>
						This folder is end-to-end encrypted. Paste its key (or the full
						share link) so your browser can encrypt into it.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-1.5">
					<Label htmlFor="folder-key">Folder key</Label>
					<Input
						id="folder-key"
						autoFocus
						placeholder="#ek=… or the key itself"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
						}}
					/>
				</div>
				{error && (
					<p className="text-sm font-medium text-destructive">{error}</p>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={submit} loading={busy} disabled={!value.trim()}>
						Unlock
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
