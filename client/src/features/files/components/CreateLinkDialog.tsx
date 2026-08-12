import { EyeOff, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { parseDuration } from "@/lib/time";
import { useLinks } from "../hooks/useLinks";

export function CreateLinkDialog({ fileId }: { fileId: number }) {
	const { mint } = useLinks();
	const [open, setOpen] = useState(false);
	const [maxUses, setMaxUses] = useState("");
	const [expiresIn, setExpiresIn] = useState("");
	const [hideUploader, setHideUploader] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onCreate = async () => {
		setError(null);
		try {
			await mint.mutateAsync({
				fileId,
				max_uses: maxUses.trim() ? Math.max(1, parseInt(maxUses, 10)) : null,
				expires_in_seconds: expiresIn.trim() ? parseDuration(expiresIn) : null,
				hide_uploader: hideUploader,
			});
			setOpen(false);
			setMaxUses("");
			setExpiresIn("");
			setHideUploader(false);
		} catch (err) {
			setError(
				err instanceof Error && err.message
					? err.message
					: "Failed to create link",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<Plus /> Link
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>New share link</DialogTitle>
					<DialogDescription>
						Create an additional link with its own limits.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="max-uses">Max downloads</Label>
						<Input
							id="max-uses"
							type="number"
							min={1}
							placeholder="∞"
							value={maxUses}
							onChange={(e) => setMaxUses(e.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="expires">Expires in</Label>
						<Input
							id="expires"
							placeholder="e.g. 7d"
							value={expiresIn}
							onChange={(e) => setExpiresIn(e.target.value)}
						/>
					</div>
					<div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5">
						<div className="flex items-center gap-2">
							<EyeOff className="size-4 text-muted-foreground" />
							<div>
								<p className="text-sm font-medium">Hide uploader info</p>
								<p className="text-xs text-muted-foreground">
									Recipients won't see your name or avatar
								</p>
							</div>
						</div>
						<Switch
							id="hide-uploader"
							checked={hideUploader}
							onCheckedChange={setHideUploader}
						/>
					</div>
				</div>
				{error && (
					<div className="text-sm font-medium text-destructive">{error}</div>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={onCreate} loading={mint.isPending}>
						Create link
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
