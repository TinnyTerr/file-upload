import {
	ArrowDownUp,
	Check,
	Clipboard,
	Copy,
	Download,
	FolderPlus,
	Info,
	Lock,
	type LucideIcon,
	Pencil,
	Scissors,
	Share2,
	Trash2,
	Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { isKeyHeldByUser } from "@/features/files/types";
import { cn } from "@/lib/cn";
import { BATCH_ZIP_LIMIT } from "../../hooks/useDriveActions";
import { useExplorer } from "../../hooks/useExplorer";
import type { SortKey } from "../../hooks/useExplorerPrefs";

/** A toolbar button that always explains itself — including *why* it is
 * disabled, which is the difference between a greyed-out icon that teaches
 * something and one that just looks broken. */
function Action({
	icon: Icon,
	label,
	shortcut,
	reason,
	onClick,
	destructive,
}: {
	icon: LucideIcon;
	label: string;
	shortcut?: string;
	/** Non-null disables the button and becomes the tooltip. */
	reason?: string | null;
	onClick: () => void;
	destructive?: boolean;
}) {
	return (
		<Tooltip content={reason ?? `${label}${shortcut ? ` (${shortcut})` : ""}`}>
			<Button
				variant="ghost"
				size="icon"
				className={cn("size-8", destructive && "hover:text-destructive")}
				disabled={!!reason}
				onClick={onClick}
				aria-label={label}
			>
				<Icon />
			</Button>
		</Tooltip>
	);
}

const SORTS: { key: SortKey; label: string }[] = [
	{ key: "name", label: "Name" },
	{ key: "date", label: "Date added" },
	{ key: "size", label: "Size" },
	{ key: "type", label: "Type" },
];

export function CommandBar({
	newMenu,
	uploadMenu,
	clipboard,
}: {
	/** The "New ▾" split button, which owns folder creation and receive links. */
	newMenu: ReactNode;
	/** The "Upload ▾" split button. */
	uploadMenu: ReactNode;
	clipboard: {
		cut: () => void;
		copy: () => void;
		paste: () => void;
		canPaste: string | null;
	};
}) {
	const { selection, actions, perms, prefs, updatePrefs, toggleSort } =
		useExplorer();
	const selected = selection.selectedItems;
	const one = selected.length === 1 ? selected[0] : null;
	const none = selected.length === 0;

	const files = selected.filter((i) => i.kind === "file");
	const downloadable = files.filter(
		(f) => f.kind === "file" && f.file.links.length > 0,
	);
	const downloadReason = !files.length
		? "Select a file to download."
		: !downloadable.length
			? "These files have no active link to download from."
			: files.length > BATCH_ZIP_LIMIT
				? `A single download is capped at ${BATCH_ZIP_LIMIT} files.`
				: null;

	const shareReason = !one
		? none
			? "Select something to share."
			: "Sharing works on one item at a time."
		: one.kind === "file" && one.file.links.length === 0
			? "This file has no link yet — create one in the details pane."
			: !perms.canManageLinks && one.kind === "folder"
				? "You don't have permission to manage this folder's links."
				: null;

	const encryptionOf = one
		? one.kind === "folder"
			? one.dir.encryption_mode
			: one.file.encryption_mode
		: null;

	return (
		<div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
			{newMenu}
			{uploadMenu}

			<span className="mx-1 h-5 w-px bg-border" />

			<Action
				icon={Scissors}
				label="Cut"
				shortcut="Ctrl+X"
				reason={none ? "Select something to cut." : null}
				onClick={clipboard.cut}
			/>
			<Action
				icon={Copy}
				label="Copy"
				shortcut="Ctrl+C"
				reason={none ? "Select something to copy." : null}
				onClick={clipboard.copy}
			/>
			<Action
				icon={Clipboard}
				label="Paste"
				shortcut="Ctrl+V"
				reason={clipboard.canPaste}
				onClick={clipboard.paste}
			/>

			<span className="mx-1 h-5 w-px bg-border" />

			<Action
				icon={Pencil}
				label="Rename"
				shortcut="F2"
				reason={
					!one
						? none
							? "Select something to rename."
							: "Rename works on one item at a time."
						: null
				}
				onClick={() => one && actions.rename(one)}
			/>
			<Action
				icon={Download}
				label="Download"
				shortcut="Ctrl+D"
				reason={downloadReason}
				onClick={() => actions.download(selected)}
			/>
			<Action
				icon={Share2}
				label="Share"
				reason={shareReason}
				onClick={() => one && actions.share(one)}
			/>
			<Action
				icon={Lock}
				label={
					encryptionOf && isKeyHeldByUser(encryptionOf)
						? "Encryption (end-to-end)"
						: "Encryption"
				}
				reason={
					!one
						? none
							? "Select something first."
							: "Encryption is changed one item at a time."
						: null
				}
				onClick={() => one && actions.encryption(one)}
			/>
			<Action
				icon={Trash2}
				label="Delete"
				shortcut="Del"
				destructive
				reason={
					none
						? "Select something to delete."
						: perms.canDelete
							? null
							: "You don't have permission to delete."
				}
				onClick={() => actions.remove(selected)}
			/>

			<span className="flex-1" />

			{/* ── sort ─────────────────────────────────────────────────── */}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs">
						<ArrowDownUp className="size-3.5" /> Sort
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuLabel>Sort by</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={prefs.sortKey}
						onValueChange={(v) => toggleSort(v as SortKey)}
					>
						{SORTS.map((s) => (
							<DropdownMenuRadioItem key={s.key} value={s.key}>
								{s.label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuRadioGroup
						value={prefs.sortDir}
						onValueChange={(v) => updatePrefs({ sortDir: v as "asc" | "desc" })}
					>
						<DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="desc">
							Descending
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => updatePrefs({ foldersFirst: !prefs.foldersFirst })}
					>
						{prefs.foldersFirst && <Check className="size-4" />}
						Folders first
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Tooltip content="Show or hide the details pane (Alt+Enter)">
				<Button
					variant="ghost"
					size="icon"
					className={cn("size-8", prefs.detailsOpen && "bg-secondary")}
					aria-pressed={prefs.detailsOpen}
					onClick={() => updatePrefs({ detailsOpen: !prefs.detailsOpen })}
					aria-label="Details pane"
				>
					<Info />
				</Button>
			</Tooltip>
		</div>
	);
}

/** Exported so the "New" menu can reuse the same folder icon in one place. */
export { FolderPlus, Upload };
