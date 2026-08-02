import {
	Archive,
	Eye,
	FolderClosed,
	Link2,
	Lock,
	MoreHorizontal,
	Pencil,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import type { BrowseFile } from "@/features/directories/types";
import { isPreviewableType, PreviewMedia } from "@/features/download/components/FilePreview";
import { previewPath } from "@/features/download/services/publicService";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { useDeleteFile, useUpdateFile } from "../hooks/useFiles";
import { EncryptionBadge, iconForType } from "../lib/fileMeta";
import { CreateLinkDialog } from "./CreateLinkDialog";
import { LinkList } from "./LinkList";

export function BrowserFileRow({
	file,
	currentDirId,
}: {
	file: BrowseFile;
	currentDirId: number | null;
}) {
	const [linksOpen, setLinksOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const del = useDeleteFile();
	const update = useUpdateFile();
	const { confirm, prompt } = useDialogs();
	const { can } = useAuth();

	const canDelete = can("can_delete");
	const canLinks = can("can_regenerate_links");
	const Icon = iconForType(file.content_type);
	const previewLink = file.links.find((l) => l.active) ?? file.links[0];
	const canPreview =
		!!previewLink &&
		file.encryption_mode === "none" &&
		isPreviewableType(file.content_type);

	const onDelete = async () => {
		const ok = await confirm({
			title: "Delete file?",
			description: `"${file.original_filename}" and all its links will be removed.`,
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) del.mutate(file.id);
	};

	const onRename = async () => {
		const next = await prompt({
			title: "Rename file",
			label: "Filename",
			defaultValue: file.original_filename,
			confirmText: "Rename",
		});
		if (next?.trim() && next.trim() !== file.original_filename) {
			update.mutate({ fileId: file.id, original_filename: next.trim() });
		}
	};

	return (
		<>
			<ListRow
				leading={
					<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
						<Icon className="size-4 text-muted-foreground" />
					</div>
				}
				trailing={
					<>
						{canPreview && (
							<Tooltip content="Preview">
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setPreviewOpen(true)}
								>
									<Eye />
								</Button>
							</Tooltip>
						)}
						{canLinks && <CreateLinkDialog fileId={file.id} />}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon">
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{canLinks && (
									<DropdownMenuItem onClick={() => setLinksOpen(true)}>
										<Link2 /> {file.links.length} link
										{file.links.length === 1 ? "" : "s"}
									</DropdownMenuItem>
								)}
								<DropdownMenuItem onClick={onRename}>
									<Pencil /> Rename
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setMoveOpen(true)}>
									<FolderClosed /> Move
								</DropdownMenuItem>
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
					<span
						className="truncate text-sm font-medium"
						title={file.original_filename}
					>
						{file.original_filename}
					</span>
					<EncryptionBadge mode={file.encryption_mode} />
					{file.locked && (
						<Tooltip content="Encrypted with a different key than this folder.">
							<Badge variant="secondary" className={cn("gap-1")}>
								<Lock className="size-3" /> nested key
							</Badge>
						</Tooltip>
					)}
					{file.compressed && (
						<Tooltip content="zstd-compressed">
							<Badge variant="secondary">zst</Badge>
						</Tooltip>
					)}
					{file.archived && (
						<Badge variant="secondary">
							<Archive /> archived
						</Badge>
					)}
				</div>
				<p className="mt-0.5 text-xs text-muted-foreground">
					{formatBytes(file.size_bytes)} · {formatDate(file.created_at)}
				</p>
			</ListRow>

			{linksOpen && (
				<Dialog open={linksOpen} onOpenChange={setLinksOpen}>
					<DialogContent className="max-w-lg">
						<DialogHeader>
							<DialogTitle className="truncate">
								Links for {file.original_filename}
							</DialogTitle>
						</DialogHeader>
						<LinkList file={file} />
					</DialogContent>
				</Dialog>
			)}

			<MoveDialog
				open={moveOpen}
				onOpenChange={setMoveOpen}
				title={`Move "${file.original_filename}"`}
				description="Pick a destination folder. Encryption never changes on a move."
				currentDirId={currentDirId}
				confirming={update.isPending}
				onConfirm={(targetId) => {
					update.mutate(
						{ fileId: file.id, directory_id: targetId },
						{ onSuccess: () => setMoveOpen(false) },
					);
				}}
			/>

			<Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle className="truncate">
							{file.original_filename}
						</DialogTitle>
					</DialogHeader>
					{previewOpen && previewLink && (
						<PreviewMedia
							src={previewPath(previewLink.slug)}
							contentType={file.content_type}
							filename={file.original_filename}
						/>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
