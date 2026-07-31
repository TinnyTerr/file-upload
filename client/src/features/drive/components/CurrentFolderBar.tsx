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
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/hooks/auth";
import { FolderLinksModal } from "@/features/directories/components/FolderLinksModal";
import {
	useDeleteDirectory,
	useSetGalleryView,
} from "@/features/directories/hooks/useDirectories";
import type { Directory } from "@/features/directories/types";
import {
	type ShareEntry,
	ShareModal,
} from "@/features/files/components/ShareModal";
import { folderUrl, shareUrl } from "@/features/files/lib/shareUrl";
import {
	type PublishTarget,
	PublishToLibraryDialog,
} from "@/features/media/components/PublishToLibraryDialog";
import { useDialogs } from "@/providers/DialogProvider";
import { useInvalidateDrive } from "../hooks/useDrive";
import { drivePath } from "../types";
import { EncryptionPanel } from "./EncryptionPanel";

/** Actions that belong to the folder you are currently inside, rather than to
 * anything in the listing: share it, manage its links, publish it, delete it. */
export function CurrentFolderBar({ dir }: { dir: Directory }) {
	const navigate = useNavigate();
	const { can } = useAuth();
	const { confirm } = useDialogs();
	const del = useDeleteDirectory();
	const setGallery = useSetGalleryView(dir.id);
	const invalidate = useInvalidateDrive();
	const [linksOpen, setLinksOpen] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(
		null,
	);
	const [encryptionOpen, setEncryptionOpen] = useState(false);

	const canDelete = can("can_delete") || dir.role === "owner";
	const canManageLinks = can("can_regenerate_links") || dir.role === "owner";

	const shareEntry: ShareEntry = {
		filename: dir.title,
		mode: dir.encryption_mode,
		baseUrl: folderUrl(dir.slug),
		accessKey: dir.access_key,
		// An end-to-end folder's key isn't ours to hand out from here -- it never
		// reached the server, so the share URL is only complete for whoever
		// already holds it.
		clientKeyB64: null,
	};

	const onDelete = async () => {
		const ok = await confirm({
			title: "Delete folder?",
			description: `“${dir.title}”, everything inside it, and all its links will be removed.`,
			confirmText: "Delete",
			destructive: true,
		});
		if (!ok) return;
		await del.mutateAsync(dir.id);
		invalidate();
		navigate(drivePath(dir.parent_directory_id ?? "root"));
	};

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<Tooltip content="Open the public folder page">
				<Button
					variant="ghost"
					size="icon"
					onClick={() =>
						window.open(
							shareUrl(folderUrl(dir.slug), dir.encryption_mode, {
								accessKey: dir.access_key,
							}),
							"_blank",
							"noopener",
						)
					}
					aria-label="Open public folder page"
				>
					<ExternalLink />
				</Button>
			</Tooltip>
			<Tooltip content="Share this folder">
				<Button
					variant="ghost"
					size="icon"
					onClick={() => setShareOpen(true)}
					aria-label="Share folder"
				>
					<Share2 />
				</Button>
			</Tooltip>
			{canManageLinks && (
				<Tooltip content="Manage share links">
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setLinksOpen(true)}
						aria-label="Manage folder links"
					>
						<Link2 />
					</Button>
				</Tooltip>
			)}
			<Tooltip
				content={
					dir.gallery_view
						? "Public page: gallery. Click for the plain list."
						: "Public page: file list. Click for a gallery of tiles and inline players."
				}
			>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => setGallery.mutate(!dir.gallery_view)}
					loading={setGallery.isPending}
					aria-label="Toggle gallery view on the public folder page"
					aria-pressed={dir.gallery_view}
				>
					<LayoutGrid className={dir.gallery_view ? "text-primary" : ""} />
				</Button>
			</Tooltip>
			{dir.role === "owner" && (
				<Tooltip
					content={
						dir.is_library ? "Library settings" : "Publish to the media library"
					}
				>
					<Button
						variant="ghost"
						size="icon"
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
						aria-label="Publish to library"
					>
						<Clapperboard className={dir.is_library ? "text-primary" : ""} />
					</Button>
				</Tooltip>
			)}
			<Tooltip content="Encryption">
				<Button
					variant="ghost"
					size="icon"
					onClick={() => setEncryptionOpen(true)}
					aria-label="Folder encryption"
				>
					<Lock />
				</Button>
			</Tooltip>
			{canDelete && (
				<Tooltip content="Delete this folder">
					<Button
						variant="ghost"
						size="icon"
						className="text-destructive"
						onClick={onDelete}
						loading={del.isPending}
						aria-label="Delete folder"
					>
						<Trash2 />
					</Button>
				</Tooltip>
			)}

			<FolderLinksModal
				open={linksOpen}
				onOpenChange={setLinksOpen}
				dirId={dir.id}
				dirTitle={dir.title}
				encryptionMode={dir.encryption_mode}
				accessKey={dir.access_key}
			/>
			<ShareModal
				entries={[shareEntry]}
				open={shareOpen}
				onOpenChange={setShareOpen}
				title="Share folder"
				description="Anyone with this link can browse the folder."
			/>
			<EncryptionPanel
				item={{ kind: "folder", id: dir.id, dir }}
				open={encryptionOpen}
				onOpenChange={setEncryptionOpen}
			/>
			<PublishToLibraryDialog
				target={publishTarget}
				open={publishTarget !== null}
				onOpenChange={(o) => !o && setPublishTarget(null)}
			/>
		</div>
	);
}
