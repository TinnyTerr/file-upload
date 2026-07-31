import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ContextMenu } from "@/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/features/auth/hooks/auth";
import { CreateFolderDialog } from "@/features/directories/components/CreateFolderDialog";
import type { Directory } from "@/features/directories/types";
import { ReceiveMode } from "@/features/files/components/modes/ReceiveMode";
import { RemoteMode } from "@/features/files/components/modes/RemoteMode";
import { ShareModal } from "@/features/files/components/ShareModal";
import { useClipboard } from "../../hooks/useClipboard";
import { useDriveChildren, useInvalidateDrive } from "../../hooks/useDrive";
import { useDriveActions } from "../../hooks/useDriveActions";
import { useDriveSelection } from "../../hooks/useDriveSelection";
import {
	DropContext,
	type DropContextValue,
	type DropZone,
	zoneDirectoryId,
} from "../../hooks/useDropTarget";
import { ExplorerContext } from "../../hooks/useExplorer";
import { useExplorerKeys } from "../../hooks/useExplorerKeys";
import { useExplorerPrefs } from "../../hooks/useExplorerPrefs";
import { useExplorerUpload } from "../../hooks/useExplorerUpload";
import { useNavHistory } from "../../hooks/useNavHistory";
import { readDroppedItems } from "../../lib/dropEntries";
import {
	type DriveItem,
	itemKey,
	itemName,
	itemsOf,
	parseDrag,
} from "../../lib/items";
import { sortItems } from "../../lib/sorting";
import { drivePath, parseLocation } from "../../types";
import { DriveItemMenu } from "../DriveItemMenu";
import { EncryptionPanel } from "../EncryptionPanel";
import { MoveToDialog } from "../MoveToDialog";
import { UnlockFolderDialog } from "../UnlockFolderDialog";
import { AddressBar } from "./AddressBar";
import { BackgroundMenuItems } from "./BackgroundMenu";
import { CommandBar } from "./CommandBar";
import { DetailsPane } from "./DetailsPane";
import { DropOverlay } from "./DropOverlay";
import { ExplorerShell } from "./ExplorerShell";
import { FileList } from "./FileList";
import { NavTree } from "./NavTree";
import { StatusBar } from "./StatusBar";
import { NewMenu, UploadMenu } from "./UploadMenu";

/**
 * The Drive, as a file explorer.
 *
 * Owns the state every pane shares — selection, focus, clipboard, preferences,
 * the search filter — and hands it down through `ExplorerContext`. The panes
 * themselves stay presentational, which is what lets the command bar, the tree,
 * the context menus and the keyboard map all act on one selection.
 */
export function ExplorerPage() {
	const { dirId } = useParams();
	const navigate = useNavigate();
	const loc = parseLocation(dirId);
	const { can } = useAuth();
	const invalidate = useInvalidateDrive();
	const { data, isLoading } = useDriveChildren(loc);
	const nav = useNavHistory();

	const { prefs, update, toggleSort, setColumnWidth, toggleColumn } =
		useExplorerPrefs();
	const [search, setSearch] = useState("");
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const [activeZone, setActiveZone] = useState<string | null>(null);
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [remoteOpen, setRemoteOpen] = useState(false);
	const [receiveOpen, setReceiveOpen] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);

	const perms = useMemo(
		() => ({
			canUpload: can("can_upload"),
			canDelete: can("can_delete"),
			canCreate: can("can_create_directories"),
			canManageLinks: can("can_regenerate_links"),
		}),
		[can],
	);

	const raw = useMemo(() => (data ? itemsOf(data) : []), [data]);
	const sorted = useMemo(
		() => sortItems(raw, prefs.sortKey, prefs.sortDir, prefs.foldersFirst),
		[raw, prefs.sortKey, prefs.sortDir, prefs.foldersFirst],
	);
	const items = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter((i) => itemName(i).toLowerCase().includes(q));
	}, [sorted, search]);

	const selection = useDriveSelection(items);
	const {
		actions,
		mutations,
		shareEntries,
		setShareEntries,
		moveTargets,
		setMoveTargets,
		encryptionKey,
		setEncryptionKey,
		renameKey,
		setRenameKey,
	} = useDriveActions();
	const clipboard = useClipboard(loc, mutations);
	const upload = useExplorerUpload();

	const currentDir = data?.directory ?? null;
	const parentId =
		data && data.breadcrumbs.length >= 2
			? data.breadcrumbs[data.breadcrumbs.length - 2]!.id
			: null;

	const commitRename = useCallback(
		(item: DriveItem, name: string) => void mutations.rename(item, name),
		[mutations],
	);

	const menuFor = useCallback(
		(item: DriveItem) => (
			<DriveItemMenu
				items={selection.isSelected(item) ? selection.selectedItems : [item]}
				actions={{
					open: actions.open,
					share: actions.share,
					download: (i: DriveItem) => actions.download([i]),
					rename: actions.rename,
					encryption: actions.encryption,
					move: actions.move,
					remove: (i: DriveItem[]) => void actions.remove(i),
				}}
				perms={{
					canDelete: perms.canDelete,
					canRename: true,
					canShare: true,
				}}
			/>
		),
		[selection, actions, perms.canDelete],
	);

	// ── drag & drop ─────────────────────────────────────────────────
	const dirFor = useCallback((zone: DropZone): Directory | null => {
		if (zone.kind === "folder") return zone.dir;
		if (zone.kind === "current") return zone.dir;
		// A `parent` zone is a bare id; it never accepts OS files, so the row
		// is only needed for the internal-move case, which doesn't use it.
		return null;
	}, []);

	const dropValue = useMemo<DropContextValue>(
		() => ({
			activeZone,
			setActiveZone,
			canUpload: perms.canUpload,
			resolveDragged: (rawPayload, zone) => {
				const destination = zoneDirectoryId(zone);
				return (
					parseDrag(rawPayload)
						.map((d) => items.find((i) => i.kind === d.kind && i.id === d.id))
						.filter((i): i is DriveItem => i !== undefined)
						// Dropping something onto itself, or back where it already is, is
						// a no-op rather than an error.
						.filter((i) => !(i.kind === "folder" && i.id === destination))
						.filter(
							(i) =>
								(i.kind === "folder"
									? i.dir.parent_directory_id
									: i.file.directory_id) !== destination,
						)
				);
			},
			onMoveInto: (dropped, zone) => {
				void mutations.move(dropped, zoneDirectoryId(zone));
			},
			onFilesInto: (files, entries, zone) => {
				const dir = dirFor(zone);
				void (async () => {
					const payload = await readDroppedItems(entries, files);
					if (!payload.files.length) return;
					await upload.upload(payload.files, dir, payload.isTree);
				})();
			},
		}),
		[activeZone, perms.canUpload, items, mutations, dirFor, upload],
	);

	// ── keyboard ────────────────────────────────────────────────────
	useExplorerKeys({
		items,
		selection,
		actions,
		focusKey,
		setFocusKey,
		setRenameKey,
		renaming: renameKey !== null,
		prefs,
		updatePrefs: update,
		canDelete: perms.canDelete,
		onUp: () => navigate(drivePath(parentId ?? "root")),
		onBack: nav.back,
		onForward: nav.forward,
		onRefresh: invalidate,
		onNewFolder: () => perms.canCreate && setNewFolderOpen(true),
		onCut: () => clipboard.cut(selection.selectedItems),
		onCopy: () => clipboard.copy(selection.selectedItems),
		onPaste: () => void clipboard.paste(),
		onCopyLink: () => {
			const one = selection.selectedItems[0];
			if (one) actions.share(one);
		},
		hasClipboard: clipboard.clipboard !== null,
		onClearClipboard: clipboard.clear,
		// Measured rather than assumed: the grid wraps, so the arrow keys have to
		// ask the DOM how many tiles actually fit on a row.
		columnsPerRow: () => {
			const nodes =
				listRef.current?.querySelectorAll<HTMLElement>("[data-item-key]");
			if (!nodes || nodes.length < 2) return 1;
			const top = nodes[0]!.getBoundingClientRect().top;
			let n = 0;
			for (const el of nodes) {
				if (Math.abs(el.getBoundingClientRect().top - top) > 2) break;
				n += 1;
			}
			return Math.max(1, n);
		},
	});

	const encryptionTarget =
		items.find((i) => itemKey(i) === encryptionKey) ??
		(currentDir && encryptionKey === `folder:${currentDir.id}`
			? ({ kind: "folder", id: currentDir.id, dir: currentDir } as DriveItem)
			: null);

	const contextValue = {
		loc,
		data,
		isLoading,
		items,
		totalCount: sorted.length,
		selection,
		actions,
		perms,
		prefs,
		updatePrefs: update,
		toggleSort,
		setColumnWidth,
		toggleColumn,
		focusKey,
		setFocusKey,
		renameKey,
		setRenameKey,
		commitRename,
		search,
		setSearch,
		isCut: clipboard.isCut,
		busy: mutations.busy,
		menuFor,
	};

	return (
		<ExplorerContext.Provider value={contextValue}>
			<DropContext.Provider value={dropValue}>
				<div className="relative">
					<ExplorerShell
						navOpen={prefs.navOpen}
						detailsOpen={prefs.detailsOpen}
						addressBar={<AddressBar />}
						commandBar={
							<CommandBar
								newMenu={
									<NewMenu
										canCreate={perms.canCreate}
										onNewFolder={() => setNewFolderOpen(true)}
										onReceiveLink={() => setReceiveOpen(true)}
									/>
								}
								uploadMenu={
									<UploadMenu
										dir={currentDir}
										form={upload.form}
										onFormChange={upload.setForm}
										disabled={!perms.canUpload}
										onFiles={(files, isTree) =>
											void upload.upload(files, currentDir, isTree)
										}
										onRemote={() => setRemoteOpen(true)}
									/>
								}
								clipboard={{
									cut: () => clipboard.cut(selection.selectedItems),
									copy: () => clipboard.copy(selection.selectedItems),
									paste: () => void clipboard.paste(),
									canPaste: clipboard.pasteReason,
								}}
							/>
						}
						nav={<NavTree />}
						main={
							<ContextMenu
								menu={
									<BackgroundMenuItems
										canCreate={perms.canCreate}
										onNewFolder={() => setNewFolderOpen(true)}
										onPaste={() => void clipboard.paste()}
										pasteReason={clipboard.pasteReason}
										onRefresh={invalidate}
									/>
								}
							>
								<div ref={listRef} className="h-full">
									<FileList />
								</div>
							</ContextMenu>
						}
						details={<DetailsPane treeProgress={upload.treeProgress} />}
						statusBar={<StatusBar />}
					/>
					{perms.canUpload && (
						<DropOverlay destination={currentDir?.title ?? "My Drive"} />
					)}
				</div>
			</DropContext.Provider>

			{/* ── dialogs ────────────────────────────────────────────── */}
			<MoveToDialog
				items={moveTargets ?? []}
				open={moveTargets !== null}
				onOpenChange={(o) => !o && setMoveTargets(null)}
				currentDirectoryId={loc === "root" ? null : loc}
				busy={mutations.busy}
				onMove={(destination) => mutations.move(moveTargets ?? [], destination)}
			/>
			<EncryptionPanel
				item={encryptionTarget}
				open={encryptionKey !== null && encryptionTarget !== null}
				onOpenChange={(o) => !o && setEncryptionKey(null)}
			/>
			<ShareModal
				entries={shareEntries}
				open={shareEntries.length > 0}
				onOpenChange={(o) => !o && setShareEntries([])}
			/>
			<ShareModal
				entries={upload.shareEntries}
				open={upload.shareEntries.length > 0}
				onOpenChange={(o) => !o && upload.setShareEntries([])}
			/>
			{upload.pending && (
				<UnlockFolderDialog
					dir={upload.pending.dir}
					open
					onOpenChange={(o) => !o && upload.setPending(null)}
					onUnlocked={() => void upload.resumePending()}
				/>
			)}
			<CreateFolderDialog
				parent={currentDir}
				open={newFolderOpen}
				onOpenChange={setNewFolderOpen}
				onCreated={(d) => navigate(drivePath(d.id))}
			/>
			<Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
				<DialogContent className="max-w-lg">
					<DialogHeader>
						<DialogTitle>Upload from a URL</DialogTitle>
						<DialogDescription>
							The server fetches the file and stores it for you. Private and
							local addresses are refused.
						</DialogDescription>
					</DialogHeader>
					<RemoteMode />
				</DialogContent>
			</Dialog>
			<Dialog open={receiveOpen} onOpenChange={setReceiveOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Receive links</DialogTitle>
						<DialogDescription>
							Hand someone a link they can upload through without an account.
						</DialogDescription>
					</DialogHeader>
					<ReceiveMode />
				</DialogContent>
			</Dialog>
		</ExplorerContext.Provider>
	);
}
