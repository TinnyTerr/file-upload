import {
	Clapperboard,
	ExternalLink,
	FolderClosed,
	Info,
	Link2,
	Lock,
	MoreHorizontal,
	Pencil,
	ShieldPlus,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListRow } from "@/components/ui/list-row";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/hooks/auth";
import { MoveDialog } from "@/features/directories/components/MoveDialog";
import {
	useDeleteDirectory,
	useEncryptDirectory,
	useUpdateDirectory,
} from "@/features/directories/hooks/useDirectories";
import type { BrowseFolder } from "@/features/directories/types";
import { cn } from "@/lib/cn";
import { useDialogs } from "@/providers/DialogProvider";
import { EncryptionBadge } from "../lib/fileMeta";
import { folderUrl, shareUrl } from "../lib/shareUrl";
import { FolderLinksModal } from "@/features/directories/components/FolderLinksModal";
import {
	type PublishTarget,
	PublishToLibraryDialog,
} from "@/features/media/components/PublishToLibraryDialog";
import { type ShareEntry, ShareModal } from "./ShareModal";

export function BrowserFolderRow({
	dir,
	onOpen,
}: {
	dir: BrowseFolder;
	onOpen: () => void;
}) {
	const { can } = useAuth();
	const { confirm, prompt } = useDialogs();
	const del = useDeleteDirectory();
	const update = useUpdateDirectory();
	const encrypt = useEncryptDirectory();
	const [linksOpen, setLinksOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);
	const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(
		null,
	);
	const [infoEntry, setInfoEntry] = useState<ShareEntry | null>(null);
	const [encryptResult, setEncryptResult] = useState<ShareEntry | null>(null);

	const canDelete = can("can_delete") || dir.role === "owner";
	const canManageLinks = can("can_regenerate_links") || dir.role === "owner";
	const isOwner = dir.role === "owner";
	const url = shareUrl(folderUrl(dir.slug), dir.encryption_mode, {
		accessKey: dir.access_key,
	});

	const onDelete = async () => {
		const ok = await confirm({
			title: "Delete folder?",
			description: `"${dir.title}" and all ${dir.file_count} files inside it (including subfolders) will be removed.`,
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) del.mutate(dir.id);
	};

	const onRename = async () => {
		const next = await prompt({
			title: "Rename folder",
			label: "Title",
			defaultValue: dir.title,
			confirmText: "Rename",
		});
		if (next?.trim() && next.trim() !== dir.title) {
			update.mutate({ dirId: dir.id, title: next.trim() });
		}
	};

	const onEncrypt = async () => {
		const ok = await confirm({
			title: "Encrypt this folder?",
			description:
				"Turns on server-side encryption for this folder and everything currently inside it. Anything already independently encrypted is left alone (it'll show as needing its own key). This can't be undone from here.",
			confirmText: "Encrypt",
		});
		if (!ok) return;
		const result = await encrypt.mutateAsync(dir.id);
		setEncryptResult({
			filename: dir.title,
			mode: "server",
			baseUrl: folderUrl(dir.slug),
			accessKey: result.access_key,
		});
	};

	return (
		<>
			<ListRow
				leading={
					<button
						type="button"
						onClick={onOpen}
						className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50 hover:bg-background"
					>
						<FolderClosed className="size-4 text-muted-foreground" />
					</button>
				}
				trailing={
					<>
						<CopyButton value={url} tooltip="Copy folder URL" />
						{canManageLinks && (
							<Tooltip content="Manage links">
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setLinksOpen(true)}
								>
									<Link2 />
								</Button>
							</Tooltip>
						)}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon">
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() =>
										setInfoEntry({
											filename: dir.title,
											mode: dir.encryption_mode,
											baseUrl: folderUrl(dir.slug),
											accessKey: dir.access_key,
										})
									}
								>
									<Info /> Info & share
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<a href={url} target="_blank" rel="noreferrer">
										<ExternalLink /> Open
									</a>
								</DropdownMenuItem>
								{isOwner && (
									<DropdownMenuItem onClick={onRename}>
										<Pencil /> Rename
									</DropdownMenuItem>
								)}
								{isOwner && (
									<DropdownMenuItem onClick={() => setMoveOpen(true)}>
										<FolderClosed /> Move
									</DropdownMenuItem>
								)}
								{isOwner && dir.encryption_mode === "none" && (
									<DropdownMenuItem
										onClick={onEncrypt}
										disabled={encrypt.isPending}
									>
										<ShieldPlus /> Encrypt folder
									</DropdownMenuItem>
								)}
								{isOwner && (
									<DropdownMenuItem
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
										<Clapperboard /> Media library
									</DropdownMenuItem>
								)}
								{canDelete && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											className="text-destructive"
											onClick={onDelete}
										>
											<Trash2 /> Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				}
			>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onOpen}
						className="truncate text-sm font-medium hover:underline"
						title={dir.title}
					>
						{dir.title}
					</button>
					<EncryptionBadge mode={dir.encryption_mode} />
					{dir.locked && (
						<Tooltip content="Encrypted with a different key than its parent folder.">
							<Badge variant="secondary" className={cn("gap-1")}>
								<Lock className="size-3" /> nested key
							</Badge>
						</Tooltip>
					)}
					{dir.role === "editor" && <Badge variant="secondary">shared</Badge>}
					{dir.is_library && (
						<Badge variant="outline" className="gap-1">
							<Clapperboard className="size-3" />
							{dir.library_visibility === "public" ? "Public" : "Library"}
						</Badge>
					)}
				</div>
				<p className="mt-0.5 text-xs text-muted-foreground">
					{dir.file_count} files · folder
				</p>
			</ListRow>

			<PublishToLibraryDialog
				target={publishTarget}
				open={publishTarget !== null}
				onOpenChange={(o) => {
					if (!o) setPublishTarget(null);
				}}
			/>

			<FolderLinksModal
				open={linksOpen}
				onOpenChange={setLinksOpen}
				dirId={dir.id}
				dirTitle={dir.title}
				encryptionMode={dir.encryption_mode}
				accessKey={dir.access_key}
			/>

			<MoveDialog
				open={moveOpen}
				onOpenChange={setMoveOpen}
				title={`Move "${dir.title}"`}
				description="Pick a destination folder. Encryption never changes on a move."
				excludeDirId={dir.id}
				currentDirId={dir.parent_directory_id}
				confirming={update.isPending}
				onConfirm={(targetId) => {
					update.mutate(
						{ dirId: dir.id, parent_directory_id: targetId },
						{ onSuccess: () => setMoveOpen(false) },
					);
				}}
			/>

			<ShareModal
				entries={infoEntry ? [infoEntry] : []}
				open={!!infoEntry}
				onOpenChange={(o) => !o && setInfoEntry(null)}
				title="Folder info"
				description="Share links, key and download details for this folder."
			/>

			<ShareModal
				entries={encryptResult ? [encryptResult] : []}
				open={!!encryptResult}
				onOpenChange={(o) => !o && setEncryptResult(null)}
				title="Folder encrypted"
				description="Save this access key now -- it's needed to share this folder's link."
			/>
		</>
	);
}
