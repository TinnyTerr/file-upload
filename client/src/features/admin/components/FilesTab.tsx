import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	FileQuestion,
	Link2,
	Search,
	Trash2,
	User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { LinkList } from "@/features/files/components/LinkList";
import { useDeleteFile } from "@/features/files/hooks/useFiles";
import { EncryptionBadge, iconForType } from "@/features/files/lib/fileMeta";
import type { FileObject } from "@/features/files/types";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { useAdminFiles } from "../hooks/useAdminData";
import { useBulk } from "../hooks/useBulk";
import { useSelection } from "../hooks/useSelection";
import { BulkBar } from "./BulkBar";
import { BulkConfirmDialog } from "./BulkConfirmDialog";

function AdminFileRow({
	file,
	selected,
	onToggle,
}: {
	file: FileObject;
	selected: boolean;
	onToggle: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const { archive, unarchive } = useAdminFiles();
	const del = useDeleteFile();
	const { confirm } = useDialogs();
	const Icon = iconForType(file.content_type);

	const onDelete = async () => {
		const ok = await confirm({
			title: "Delete file?",
			description: file.original_filename,
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) del.mutate(file.id);
	};

	return (
		<Card className={cn(selected && "ring-1 ring-primary/50")}>
			<CardContent className="p-3">
				<div className="flex items-center gap-3">
					<Checkbox
						checked={selected}
						onCheckedChange={onToggle}
						aria-label="Select file"
					/>
					<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/50">
						<Icon className="size-4 text-muted-foreground" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span
								className="truncate text-sm font-medium"
								title={file.original_filename}
							>
								{file.original_filename}
							</span>
							<EncryptionBadge mode={file.encryption_mode} />
							{file.compressed && <Badge variant="secondary">zst</Badge>}
							{file.archived && <Badge variant="secondary">archived</Badge>}
						</div>
						<p className="text-xs text-muted-foreground">
							{formatBytes(file.size_bytes)} · {formatDate(file.created_at)}
						</p>
					</div>
					<div className="flex items-center gap-1">
						{file.archived ? (
							<Tooltip content="Unarchive">
								<Button
									variant="ghost"
									size="icon"
									loading={unarchive.isPending}
									onClick={() => unarchive.mutate(file.id)}
								>
									<ArchiveRestore />
								</Button>
							</Tooltip>
						) : (
							<Tooltip content="Archive">
								<Button
									variant="ghost"
									size="icon"
									loading={archive.isPending}
									onClick={() => archive.mutate(file.id)}
								>
									<Archive />
								</Button>
							</Tooltip>
						)}
						<Tooltip content="Delete">
							<Button
								variant="ghost"
								size="icon"
								className="text-destructive"
								loading={del.isPending}
								onClick={onDelete}
							>
								<Trash2 />
							</Button>
						</Tooltip>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setExpanded((e) => !e)}
							className="gap-1"
						>
							<Link2 className="size-4" />
							{file.links.length}
							<ChevronDown
								className={cn(
									"size-4 transition-transform",
									expanded && "rotate-180",
								)}
							/>
						</Button>
					</div>
				</div>
				{expanded && (
					<div className="mt-2 border-t border-border pt-2">
						<LinkList file={file} />
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function UserSection({
	username,
	files,
	selection,
}: {
	username: string;
	files: FileObject[];
	selection: ReturnType<typeof useSelection>;
}) {
	const [collapsed, setCollapsed] = useState(true);
	const allSelected = files.every((f) => selection.has(f.id));

	return (
		<div className="space-y-2">
			<div
				className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 hover:bg-secondary/50"
				onClick={() => setCollapsed((c) => !c)}
			>
				<Checkbox
					checked={allSelected}
					onCheckedChange={(v) =>
						selection.set(
							files.map((f) => f.id),
							!!v,
						)
					}
					onClick={(e) => e.stopPropagation()}
				/>
				<User className="size-4 shrink-0 text-muted-foreground" />
				<span className="flex-1 text-sm font-semibold">{username}</span>
				<span className="text-xs text-muted-foreground">
					{files.length} file{files.length !== 1 ? "s" : ""}
				</span>
				<ChevronDown
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						collapsed && "rotate-180",
					)}
				/>
			</div>
			{!collapsed && (
				<div className="space-y-2 pl-2">
					{files.map((f) => (
						<AdminFileRow
							key={f.id}
							file={f}
							selected={selection.has(f.id)}
							onToggle={() => selection.toggle(f.id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function FilesTab() {
	const { list } = useAdminFiles();
	const [filter, setFilter] = useState("");
	const selection = useSelection();
	const bulk = useBulk(selection.clear);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return list.data ?? [];
		return (list.data ?? []).filter(
			(f) =>
				f.original_filename.toLowerCase().includes(q) ||
				(f.content_type ?? "").toLowerCase().includes(q) ||
				(f.owner_username ?? "").toLowerCase().includes(q) ||
				String(f.owner_id) === q ||
				String(f.id) === q,
		);
	}, [list.data, filter]);

	const groupedByUser = useMemo(() => {
		const map = new Map<string, FileObject[]>();
		for (const f of filtered) {
			const name = f.owner_username ?? `user:${f.owner_id}`;
			if (!map.has(name)) map.set(name, []);
			map.get(name)!.push(f);
		}
		return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
	}, [filtered]);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-3">
				<div className="relative flex-1">
					<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						className="pl-8"
						placeholder="Filter by filename, type, owner or id…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				</div>
			</div>

			{list.isLoading ? (
				<div className="space-y-2">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : filtered.length === 0 ? (
				<EmptyState icon={FileQuestion} title="No files" />
			) : (
				<div className="space-y-4 pb-16">
					{groupedByUser.map(([username, files]) => (
						<UserSection
							key={username}
							username={username}
							files={files}
							selection={selection}
						/>
					))}
				</div>
			)}

			<BulkBar count={selection.count} onClear={selection.clear}>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => bulk.startPreview("archive_files", selection.list)}
				>
					<Archive /> Archive
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => bulk.startPreview("unarchive_files", selection.list)}
				>
					<ArchiveRestore /> Unarchive
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="text-destructive"
					onClick={() => bulk.startPreview("delete_files", selection.list)}
				>
					<Trash2 /> Delete
				</Button>
			</BulkBar>
			<BulkConfirmDialog bulk={bulk} />
		</div>
	);
}
