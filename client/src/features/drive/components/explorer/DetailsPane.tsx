import { Folder } from "lucide-react";
import { UsageMeter } from "@/features/files/components/UsageMeter";
import { iconForType } from "@/features/files/lib/fileMeta";
import { formatBytes } from "@/lib/bytes";
import type { TreeProgress } from "../../hooks/useDriveUpload";
import { useExplorer } from "../../hooks/useExplorer";
import { itemName } from "../../lib/items";
import { typeLabel } from "../../lib/typeLabel";
import { ItemThumb } from "./ItemThumb";
import { Row, Section } from "./panes/DetailRow";
import { FileDetails } from "./panes/FileDetails";
import { FolderDetails } from "./panes/FolderDetails";
import { TransfersSection } from "./panes/TransfersSection";

/**
 * The right-hand pane. Switches on what is selected:
 *   nothing → the open folder, plus quota;
 *   one item → everything about it;
 *   several → a summary and the actions that make sense in bulk.
 *
 * This is where `CurrentFolderBar`'s seven unlabelled icon buttons went. They
 * were only reachable while inside a folder and each one was a guess.
 */
export function DetailsPane({
	treeProgress,
}: {
	treeProgress: TreeProgress | null;
}) {
	const { selection, data } = useExplorer();
	const selected = selection.selectedItems;

	const header = (() => {
		if (selected.length === 1) {
			const item = selected[0]!;
			return (
				<div className="flex items-center gap-3 border-b border-border px-3 py-3">
					<ItemThumb item={item} size="lg" />
					<div className="min-w-0">
						<p className="truncate text-sm font-medium" title={itemName(item)}>
							{itemName(item)}
						</p>
						<p className="text-xs text-muted-foreground">{typeLabel(item)}</p>
					</div>
				</div>
			);
		}
		if (selected.length > 1) {
			const bytes = selected.reduce(
				(n, i) =>
					n + (i.kind === "folder" ? i.dir.total_bytes : i.file.size_bytes),
				0,
			);
			return (
				<div className="border-b border-border px-3 py-3">
					<p className="text-sm font-medium">
						{selected.length} items selected
					</p>
					<p className="text-xs text-muted-foreground">{formatBytes(bytes)}</p>
				</div>
			);
		}
		const Icon = data?.directory ? Folder : iconForType(null);
		return (
			<div className="flex items-center gap-3 border-b border-border px-3 py-3">
				<Icon className="size-8 shrink-0 text-primary/80" />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">
						{data?.directory?.title ?? "My Drive"}
					</p>
					<p className="text-xs text-muted-foreground">Folder</p>
				</div>
			</div>
		);
	})();

	const body = () => {
		if (selected.length === 1) {
			const item = selected[0]!;
			return item.kind === "folder" ? (
				<FolderDetails dir={item.dir} />
			) : (
				<FileDetails file={item.file} />
			);
		}
		if (selected.length > 1) {
			const folders = selected.filter((i) => i.kind === "folder").length;
			return (
				<Section title="Selection">
					<Row label="Folders">{folders}</Row>
					<Row label="Files">{selected.length - folders}</Row>
					<p className="pt-1 text-xs text-muted-foreground">
						Use the toolbar to move, download or delete them together.
					</p>
				</Section>
			);
		}
		if (data?.directory) return <FolderDetails dir={data.directory} />;
		return (
			<Section title="Storage">
				<UsageMeter />
			</Section>
		);
	};

	return (
		<aside
			aria-label="Details"
			className="flex h-full flex-col overflow-y-auto border-l border-border bg-card"
		>
			{header}
			{body()}
			<TransfersSection treeProgress={treeProgress} />
		</aside>
	);
}
