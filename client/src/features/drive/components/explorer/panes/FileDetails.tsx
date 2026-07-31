import { Download, Lock, Share2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreateLinkDialog } from "@/features/files/components/CreateLinkDialog";
import { LinkList } from "@/features/files/components/LinkList";
import { EncryptionBadge } from "@/features/files/lib/fileMeta";
import { type FileObject, isKeyHeldByUser } from "@/features/files/types";
import { formatBytes } from "@/lib/bytes";
import { formatDate } from "@/lib/time";
import { useExplorer } from "../../../hooks/useExplorer";
import type { DriveItem } from "../../../lib/items";
import { typeLabel } from "../../../lib/typeLabel";
import { Row, Section } from "./DetailRow";

export function FileDetails({ file }: { file: FileObject }) {
	const { actions, perms } = useExplorer();
	const item: DriveItem = { kind: "file", id: file.id, file };
	const e2e = isKeyHeldByUser(file.encryption_mode);

	return (
		<>
			<Section title="Details">
				<Row label="Type">{typeLabel(item)}</Row>
				<Row label="Size">{formatBytes(file.size_bytes)}</Row>
				{file.stored_size_bytes !== file.size_bytes && (
					<Row label="On disk">{formatBytes(file.stored_size_bytes)}</Row>
				)}
				<Row label="Added">{formatDate(file.created_at)}</Row>
				{file.last_downloaded_at && (
					<Row label="Last download">{formatDate(file.last_downloaded_at)}</Row>
				)}
				{file.source_type !== "upload" && (
					<Row label="Source">
						{file.source_type === "saved"
							? "Saved from a shared link"
							: file.source_type}
					</Row>
				)}
				{(file.compressed || file.archived) && (
					<div className="flex gap-1.5">
						{file.compressed && <Badge variant="secondary">zstd</Badge>}
						{file.archived && <Badge variant="secondary">archived</Badge>}
					</div>
				)}
			</Section>

			<Section title="Encryption">
				<div className="flex items-center gap-2">
					<EncryptionBadge
						mode={file.encryption_mode}
						inherited={!file.encryption_overridden}
					/>
					<span className="text-xs text-muted-foreground">
						{file.encryption_overridden
							? "Holds its own key"
							: "Inherited from its folder"}
					</span>
				</div>
				{e2e && (
					<p className="text-xs text-muted-foreground">
						The server can't read this file. Downloading it here gives you
						ciphertext — use the share link, which carries the key.
					</p>
				)}
				<Button
					variant="outline"
					size="sm"
					className="w-full"
					onClick={() => actions.encryption(item)}
				>
					<Lock className="size-3.5" /> Change encryption
				</Button>
			</Section>

			<Section title="Links">
				<LinkList file={file} />
				<CreateLinkDialog fileId={file.id} />
			</Section>

			<Section title="Actions">
				<div className="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						disabled={!file.links.length}
						onClick={() => actions.share(item)}
					>
						<Share2 className="size-3.5" /> Share
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						disabled={!file.links.length || e2e}
						onClick={() => actions.download([item])}
					>
						<Download className="size-3.5" /> Download
					</Button>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="w-full text-destructive hover:bg-destructive/10"
					disabled={!perms.canDelete}
					onClick={() => actions.remove([item])}
				>
					<Trash2 className="size-3.5" /> Delete
				</Button>
			</Section>
		</>
	);
}
