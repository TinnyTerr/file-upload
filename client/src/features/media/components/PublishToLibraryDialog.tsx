import { Clapperboard } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useMediaCuration } from "../hooks/useMedia";
import type { MediaKind, MediaVisibility } from "../types";

export interface PublishTarget {
	directoryId: number;
	title: string;
	isPublished: boolean;
	visibility: MediaVisibility;
	kind: MediaKind;
	overview: string | null;
}

/** Publishes a folder as a library collection, or edits how it's presented.
 * Only folders containing video/audio can be published — the backend rejects
 * the rest rather than listing an empty tile. */
export function PublishToLibraryDialog({
	target,
	open,
	onOpenChange,
}: {
	target: PublishTarget | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { publish, unpublish } = useMediaCuration();
	const [visibility, setVisibility] = useState<MediaVisibility>("restricted");
	const [kind, setKind] = useState<MediaKind>("series");
	const [overview, setOverview] = useState("");

	useEffect(() => {
		if (!target) return;
		setVisibility(target.visibility);
		setKind(target.kind);
		setOverview(target.overview ?? "");
	}, [target]);

	if (!target) return null;

	const onSubmit = async () => {
		await publish.mutateAsync({
			directoryId: target.directoryId,
			input: {
				visibility,
				kind,
				overview: overview.trim() || null,
			},
		});
		onOpenChange(false);
	};

	const onRemove = async () => {
		await unpublish.mutateAsync(target.directoryId);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Clapperboard className="size-4" />
						{target.isPublished ? "Library settings" : "Publish to the library"}
					</DialogTitle>
					<DialogDescription>
						“{target.title}” appears in the library, and its video and audio
						files become playable titles.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="library-visibility">Who can watch</Label>
						<Select
							value={visibility}
							onValueChange={(v) => setVisibility(v as MediaVisibility)}
						>
							<SelectTrigger id="library-visibility">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="restricted">
									Accounts with library access
								</SelectItem>
								<SelectItem value="public">Anyone with the link</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							{visibility === "public"
								? "No sign-in and no play key needed — treat this like a public share link."
								: "Needs an account holding “Watch library”, or a play key you mint for it."}
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="library-kind">Presented as</Label>
						<Select value={kind} onValueChange={(v) => setKind(v as MediaKind)}>
							<SelectTrigger id="library-kind">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="series">Series (episode list)</SelectItem>
								<SelectItem value="movie">Movie (single title)</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="library-overview">Description (optional)</Label>
						<textarea
							id="library-overview"
							value={overview}
							onChange={(e) => setOverview(e.target.value)}
							rows={3}
							maxLength={2000}
							className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							placeholder="What is this?"
						/>
					</div>
				</div>

				<DialogFooter className="sm:justify-between">
					{target.isPublished ? (
						<Button
							variant="ghost"
							className="text-destructive"
							onClick={onRemove}
							disabled={unpublish.isPending}
						>
							Remove from library
						</Button>
					) : (
						<span />
					)}
					<div className="flex gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button onClick={onSubmit} disabled={publish.isPending}>
							{target.isPublished ? "Save" : "Publish"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
