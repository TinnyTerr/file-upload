import {
	Clapperboard,
	ExternalLink,
	LayoutGrid,
	Link2,
	Lock,
	Share2,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { FolderLinksModal } from "@/features/directories/components/FolderLinksModal";
import { useSetGalleryView } from "@/features/directories/hooks/useDirectories";
import type { Directory } from "@/features/directories/types";
import { EncryptionBadge } from "@/features/files/lib/fileMeta";
import { folderUrl } from "@/features/files/lib/shareUrl";
import {
	type PublishTarget,
	PublishToLibraryDialog,
} from "@/features/media/components/PublishToLibraryDialog";
import { formatBytes } from "@/lib/bytes";
import { formatDate } from "@/lib/time";
import { useExplorer } from "../../../hooks/useExplorer";
import type { DriveItem } from "../../../lib/items";
import { Row, Section } from "./DetailRow";

/** Everything the old `CurrentFolderBar` icon row did, given room to say what
 * each thing means. */
export function FolderDetails({ dir }: { dir: Directory }) {
	const { actions, perms } = useExplorer();
	const setGallery = useSetGalleryView(dir.id);
	const [linksOpen, setLinksOpen] = useState(false);
	const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(
		null,
	);

	const item: DriveItem = { kind: "folder", id: dir.id, dir };
	const isOwner = dir.role === "owner";

	return (
		<>
			<Section title="Details">
				<Row label="Contents">
					{dir.subdirectory_count} folder
					{dir.subdirectory_count === 1 ? "" : "s"} · {dir.file_count} file
					{dir.file_count === 1 ? "" : "s"}
				</Row>
				<Row label="Size">{formatBytes(dir.total_bytes)}</Row>
				<Row label="Added">{formatDate(dir.created_at)}</Row>
				<Row label="Your role">{dir.role ?? "viewer"}</Row>
			</Section>

			<Section title="Encryption">
				<div className="flex items-center gap-2">
					<EncryptionBadge
						mode={dir.encryption_mode}
						inherited={!dir.encryption_overridden}
					/>
					<span className="text-xs text-muted-foreground">
						{dir.encryption_overridden
							? "Holds its own key"
							: "Inherited from the folder above"}
					</span>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="w-full"
					onClick={() => actions.encryption(item)}
				>
					<Lock className="size-3.5" /> Change encryption
				</Button>
			</Section>

			<Section title="Public page">
				<Row label="Link">
					<a
						href={folderUrl(dir.slug)}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
					>
						Open <ExternalLink className="size-3" />
					</a>
				</Row>
				<div className="flex items-center justify-between gap-2">
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<LayoutGrid className="size-3.5" /> Gallery view
					</span>
					<Tooltip content="Show the public page as a grid of posters instead of a file list. Cosmetic only.">
						<Switch
							checked={dir.gallery_view}
							onCheckedChange={(v) => setGallery.mutate(v)}
						/>
					</Tooltip>
				</div>
				<div className="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						onClick={() => actions.share(item)}
					>
						<Share2 className="size-3.5" /> Share
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						disabled={!perms.canManageLinks && !isOwner}
						onClick={() => setLinksOpen(true)}
					>
						<Link2 className="size-3.5" /> Links
					</Button>
				</div>
			</Section>

			{isOwner && (
				<Section title="Library">
					<Button
						variant="outline"
						size="sm"
						className="w-full"
						onClick={() =>
							setPublishTarget({
								directoryId: dir.id,
								title: dir.title,
								isPublished: dir.is_library,
								visibility: dir.library_visibility,
								kind: dir.library_kind,
								overview: dir.library_overview,
							})
						}
					>
						<Clapperboard className="size-3.5" />
						{dir.is_library ? "Library settings" : "Publish to library"}
					</Button>
				</Section>
			)}

			<Section title="Danger">
				<Button
					variant="outline"
					size="sm"
					className="w-full text-destructive hover:bg-destructive/10"
					disabled={!perms.canDelete && !isOwner}
					onClick={() => actions.remove([item])}
				>
					<Trash2 className="size-3.5" /> Delete folder
				</Button>
			</Section>

			<FolderLinksModal
				open={linksOpen}
				onOpenChange={setLinksOpen}
				dirId={dir.id}
				dirTitle={dir.title}
				encryptionMode={dir.encryption_mode}
				accessKey={dir.access_key}
			/>
			<PublishToLibraryDialog
				target={publishTarget}
				open={publishTarget !== null}
				onOpenChange={(o) => !o && setPublishTarget(null)}
			/>
		</>
	);
}
