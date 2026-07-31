import { MoreVertical } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/features/auth/hooks/auth";
import type { Directory } from "@/features/directories/types";
import { FileRow } from "@/features/files/components/FileRow";
import {
	type ShareEntry,
	ShareModal,
} from "@/features/files/components/ShareModal";
import { useUpload } from "@/features/files/hooks/useUpload";
import {
	fileUrl,
	folderUrl,
	rawUrl,
	shareUrl,
} from "@/features/files/lib/shareUrl";
import { useDialogs } from "@/providers/DialogProvider";
import { useDriveMutations } from "../hooks/useDriveMutations";
import { useDriveSelection } from "../hooks/useDriveSelection";
import {
	DRIVE_DRAG_TYPE,
	type DriveItem,
	itemKey,
	itemName,
	itemsOf,
	parseDrag,
	serializeDrag,
} from "../lib/items";
import type { DriveChildren } from "../types";
import { drivePath } from "../types";
import { type DriveActions, DriveItemMenu } from "./DriveItemMenu";
import { EncryptionPanel } from "./EncryptionPanel";
import { FolderTile } from "./FolderTile";
import { MoveToDialog } from "./MoveToDialog";
import { RenameDialog } from "./RenameDialog";
import { SelectionBar } from "./SelectionBar";

/** Folders and files in one selectable, draggable, right-clickable list. */
export function DriveListing({ data }: { data: DriveChildren }) {
	const navigate = useNavigate();
	const { can } = useAuth();
	const { confirm } = useDialogs();
	const { start } = useUpload();
	const mutations = useDriveMutations();

	const items = useMemo(() => itemsOf(data), [data]);
	const selection = useDriveSelection(items);
	const [dropTarget, setDropTarget] = useState<number | null>(null);
	const [moveTargets, setMoveTargets] = useState<DriveItem[] | null>(null);
	const [renameTarget, setRenameTarget] = useState<DriveItem | null>(null);
	const [shareEntry, setShareEntry] = useState<ShareEntry | null>(null);
	// Only the *identity* is held: the panel mutates the very thing it displays
	// (seal, re-key, adopt), and a snapshot taken when the menu opened would go
	// on showing the pre-mutation state — offering buttons that now 409 — until
	// the sheet was closed and reopened. Re-deriving from `items` means the
	// refetch that follows a mutation reaches the panel.
	const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
	const encryptionTarget =
		items.find((it) => itemKey(it) === encryptionKey) ?? null;
	const setEncryptionTarget = (it: DriveItem | null) =>
		setEncryptionKey(it ? itemKey(it) : null);

	const canDelete = can("can_delete");
	const canUpload = can("can_upload");
	const currentId = data.directory?.id ?? null;
	const perms = {
		canDelete,
		canRename: true,
		canShare: true,
	};

	const askDelete = async (targets: DriveItem[]) => {
		const folders = targets.filter((t) => t.kind === "folder").length;
		const ok = await confirm({
			title:
				targets.length === 1
					? "Delete this item?"
					: `Delete ${targets.length} items?`,
			description:
				targets.length === 1
					? `“${itemName(targets[0])}”${folders ? ", everything inside it," : ""} and all its links will be removed.`
					: `The selected items${folders ? ", everything inside the folders," : ""} and all their links will be removed.`,
			confirmText: "Delete",
			destructive: true,
		});
		if (ok) await mutations.remove(targets);
	};

	const actions: DriveActions = {
		open: (item) => item.kind === "folder" && navigate(drivePath(item.id)),
		share: (item) => {
			if (item.kind === "folder") {
				setShareEntry({
					filename: item.dir.title,
					mode: item.dir.encryption_mode,
					baseUrl: folderUrl(item.dir.slug),
					accessKey: item.dir.access_key,
					// An end-to-end folder's key never reached the server, so we
					// genuinely don't have it to put in the link.
					clientKeyB64: null,
				});
				return;
			}
			const link = item.file.links[0];
			if (!link) return;
			setShareEntry({
				filename: item.file.original_filename,
				mode: item.file.encryption_mode,
				baseUrl: fileUrl(link.slug),
				accessKey: item.file.access_key,
				clientKeyB64: null,
			});
		},
		download: (item) => {
			if (item.kind !== "file") return;
			const link = item.file.links[0];
			if (!link) return;
			window.open(
				shareUrl(rawUrl(link.slug), item.file.encryption_mode, {
					accessKey: item.file.access_key,
				}),
				"_blank",
				"noopener",
			);
		},
		rename: setRenameTarget,
		encryption: setEncryptionTarget,
		move: setMoveTargets,
		remove: askDelete,
	};

	/** Drag source wiring shared by tiles and rows. */
	const dragProps = (item: DriveItem) => ({
		draggable: true,
		onDragStart: (e: React.DragEvent) => {
			const dragged = selection.ensureSelected(item);
			e.dataTransfer.setData(DRIVE_DRAG_TYPE, serializeDrag(dragged));
			e.dataTransfer.effectAllowed = "move";
		},
	});

	/** Drop wiring for a folder tile: internal items move in, OS files upload in. */
	const dropProps = (dir: Directory) => ({
		onDragOver: (e: React.DragEvent) => {
			const internal = e.dataTransfer.types.includes(DRIVE_DRAG_TYPE);
			const external = e.dataTransfer.types.includes("Files");
			if (!internal && !(external && canUpload)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = internal ? "move" : "copy";
			setDropTarget(dir.id);
		},
		onDragLeave: () => setDropTarget((t) => (t === dir.id ? null : t)),
		onDrop: async (e: React.DragEvent) => {
			e.preventDefault();
			setDropTarget(null);
			const raw = e.dataTransfer.getData(DRIVE_DRAG_TYPE);
			if (raw) {
				const dropped = parseDrag(raw)
					.map((d) => items.find((i) => i.kind === d.kind && i.id === d.id))
					.filter((i): i is DriveItem => i !== undefined)
					// Dropping a folder on itself is a no-op, not an error.
					.filter((i) => !(i.kind === "folder" && i.id === dir.id));
				if (dropped.length) await mutations.move(dropped, dir.id);
				return;
			}
			const files = Array.from(e.dataTransfer.files ?? []);
			if (!files.length || !canUpload) return;
			if (dir.encryption_mode === "client") {
				// Encrypting into it needs that folder's key, which lives only in
				// whoever's browser holds it -- open the folder and unlock it there.
				toast.error("Open the folder first", {
					description: `“${dir.title}” is end-to-end encrypted; it has to be unlocked before files can be added.`,
				});
				return;
			}
			await start(files, {
				encryption_mode: dir.encryption_mode,
				directory_id: dir.id,
			});
		},
	});

	const menuFor = (item: DriveItem) => {
		const targets = selection.isSelected(item)
			? selection.selectedItems
			: [item];
		return <DriveItemMenu items={targets} actions={actions} perms={perms} />;
	};

	const kebab = (item: DriveItem) => (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label={`Actions for ${itemName(item)}`}
					onClick={(e) => e.stopPropagation()}
				>
					<MoreVertical />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">{menuFor(item)}</DropdownMenuContent>
		</DropdownMenu>
	);

	return (
		<div className="space-y-4">
			<SelectionBar
				items={selection.selectedItems}
				canDelete={canDelete}
				busy={mutations.busy}
				onMove={() => setMoveTargets(selection.selectedItems)}
				onDelete={() => askDelete(selection.selectedItems)}
				onClear={selection.clear}
			/>

			{data.directories.length > 0 && (
				<div className="grid gap-2 sm:grid-cols-2">
					{data.directories.map((dir) => {
						const item: DriveItem = { kind: "folder", id: dir.id, dir };
						return (
							<ContextMenu key={itemKey(item)} menu={menuFor(item)}>
								<FolderTile
									dir={dir}
									menu={kebab(item)}
									selected={selection.isSelected(item)}
									dropActive={dropTarget === dir.id}
									onSelectClick={(e) => selection.onItemClick(item, e)}
									containerProps={{
										...dragProps(item),
										...dropProps(dir),
									}}
								/>
							</ContextMenu>
						);
					})}
				</div>
			)}

			{data.files.length > 0 && (
				<div className="space-y-2">
					{data.files.map((file) => {
						const item: DriveItem = { kind: "file", id: file.id, file };
						return (
							<ContextMenu key={itemKey(item)} menu={menuFor(item)}>
								<FileRow
									file={file}
									menu={kebab(item)}
									selected={selection.isSelected(item)}
									onSelectClick={(e) => selection.onItemClick(item, e)}
									containerProps={dragProps(item)}
								/>
							</ContextMenu>
						);
					})}
				</div>
			)}

			<MoveToDialog
				items={moveTargets ?? []}
				open={moveTargets !== null}
				onOpenChange={(o) => !o && setMoveTargets(null)}
				currentDirectoryId={currentId}
				busy={mutations.busy}
				onMove={(destination) => mutations.move(moveTargets ?? [], destination)}
			/>
			<RenameDialog
				item={renameTarget}
				open={renameTarget !== null}
				onOpenChange={(o) => !o && setRenameTarget(null)}
				busy={mutations.busy}
				onRename={(name) =>
					renameTarget
						? mutations.rename(renameTarget, name)
						: Promise.resolve(false)
				}
			/>
			<EncryptionPanel
				item={encryptionTarget}
				open={encryptionKey !== null && encryptionTarget !== null}
				onOpenChange={(o) => !o && setEncryptionKey(null)}
			/>
			<ShareModal
				entries={shareEntry ? [shareEntry] : []}
				open={shareEntry !== null}
				onOpenChange={(o) => !o && setShareEntry(null)}
			/>
		</div>
	);
}
