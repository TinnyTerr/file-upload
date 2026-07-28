import { Archive, ChevronDown, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/hooks/auth";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { useDeleteFile } from "../hooks/useFiles";
import { EncryptionBadge, iconForType } from "../lib/fileMeta";
import type { FileObject } from "../types";
import { CreateLinkDialog } from "./CreateLinkDialog";
import { LinkList } from "./LinkList";

export function FileRow({ file }: { file: FileObject }) {
	const [expanded, setExpanded] = useState(false);
	const del = useDeleteFile();
	const { confirm } = useDialogs();
	const { can } = useAuth();

	const canDelete = can("can_delete");
	const canLinks = can("can_regenerate_links");
	const Icon = iconForType(file.content_type);

	const onDelete = async () => {
		const ok = await confirm({
			title: "Delete file?",
			description: `“${file.original_filename}” and all its links will be removed.`,
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) del.mutate(file.id);
	};

	return (
		<ListRow
			leading={
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
					<Icon className="size-4 text-muted-foreground" />
				</div>
			}
			trailing={
				<>
					{canLinks && <CreateLinkDialog fileId={file.id} />}
					{canDelete && (
						<Tooltip content="Delete file">
							<Button
								variant="ghost"
								size="icon"
								className="text-destructive"
								onClick={onDelete}
								loading={del.isPending}
								aria-label={`Delete ${file.original_filename}`}
							>
								<Trash2 />
							</Button>
						</Tooltip>
					)}
					<Tooltip
						content={`${file.links.length} link${file.links.length === 1 ? "" : "s"}`}
					>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setExpanded((e) => !e)}
							className="gap-1"
							aria-label={`${expanded ? "Hide" : "Show"} ${file.links.length} share link${file.links.length === 1 ? "" : "s"} for ${file.original_filename}`}
							aria-expanded={expanded}
						>
							<Link2 className="size-4" />
							<span>
								{file.links.length}{" "}
								<span className="hidden sm:inline">links</span>
							</span>
							<ChevronDown
								className={cn(
									"size-4 transition-transform",
									expanded && "rotate-180",
								)}
							/>
						</Button>
					</Tooltip>
				</>
			}
			footer={expanded && <LinkList file={file} />}
		>
			<div className="flex items-center gap-2">
				<span
					className="truncate text-sm font-medium"
					title={file.original_filename}
				>
					{file.original_filename}
				</span>
				<EncryptionBadge mode={file.encryption_mode} />
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
	);
}
