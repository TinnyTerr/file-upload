import {
	ChevronDown,
	FileUp,
	FolderUp,
	Globe,
	Inbox,
	Settings2,
	Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { Directory } from "@/features/directories/types";
import {
	type UploadFormState,
	UploadOptionsForm,
} from "@/features/files/components/UploadOptionsForm";

/** What files uploaded here will be encrypted with, in words. */
function inheritedNotice(dir: Directory): string {
	switch (dir.encryption_mode) {
		case "server":
			return `Server-side — inherited from “${dir.title}”`;
		case "client":
			return `End-to-end — uses “${dir.title}”'s key`;
		case "sealed":
			return "Sealed — the server holds no key for this folder";
		default:
			return `No encryption — inherited from “${dir.title}”`;
	}
}

/**
 * The "Upload ▾" split button.
 *
 * Replaces the always-visible upload card: the drop target is now the whole
 * explorer, so the toolbar only has to cover the cases a drag can't express —
 * picking from the file dialog, and fetching from a URL.
 */
export function UploadMenu({
	dir,
	form,
	onFormChange,
	onFiles,
	onRemote,
	disabled,
}: {
	dir: Directory | null;
	form: UploadFormState;
	onFormChange: (next: UploadFormState) => void;
	onFiles: (files: File[], isTree: boolean) => void;
	onRemote: () => void;
	disabled?: boolean;
}) {
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const [optionsOpen, setOptionsOpen] = useState(false);
	// Set synchronously by the menu item so `onCloseAutoFocus` can tell "the menu
	// closed because options are opening" from an ordinary dismissal. Reading
	// `optionsOpen` there would race the re-render.
	const openingOptions = useRef(false);

	return (
		<div className="flex items-center">
			<Tooltip content={`Upload into ${dir ? `“${dir.title}”` : "My Drive"}`}>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-1.5 rounded-r-none pr-2 text-xs"
					disabled={disabled}
					onClick={() => fileInput.current?.click()}
				>
					<Upload className="size-3.5" /> Upload
				</Button>
			</Tooltip>
			{/* The options popover and the menu share the chevron as their anchor,
			    so the form opens from the button rather than from wherever a
			    zero-size placeholder happened to sit. */}
			<Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<PopoverAnchor asChild>
							<Button
								variant="ghost"
								size="icon"
								className="size-8 rounded-l-none border-l border-border/60"
								disabled={disabled}
								aria-label="More upload options"
							>
								<ChevronDown className="size-3.5" />
							</Button>
						</PopoverAnchor>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						onCloseAutoFocus={(e) => {
							// Otherwise the menu yanks focus back to the chevron just as
							// the popover is trying to take it.
							if (openingOptions.current) {
								openingOptions.current = false;
								e.preventDefault();
							}
						}}
					>
						<DropdownMenuItem onSelect={() => fileInput.current?.click()}>
							<FileUp /> Files…
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => folderInput.current?.click()}>
							<FolderUp /> Folder…
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={onRemote}>
							<Globe /> From a URL…
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => {
								openingOptions.current = true;
								setOptionsOpen(true);
							}}
						>
							<Settings2 /> Upload options…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<PopoverContent
					align="end"
					className="max-h-[70vh] w-80 overflow-y-auto"
				>
					{/* Inside a folder the server forces compression, permanence,
					    temp-days and randomised names off (prepareUpload), so offering
					    them here would be showing controls that do nothing. */}
					<UploadOptionsForm
						value={form}
						onChange={onFormChange}
						hideDirectoryPicker
						encryptionLockedTo={dir ? inheritedNotice(dir) : null}
					/>
				</PopoverContent>
			</Popover>

			<input
				ref={fileInput}
				type="file"
				hidden
				multiple
				onChange={(e) => {
					onFiles(Array.from(e.target.files ?? []), false);
					e.target.value = "";
				}}
			/>
			<input
				ref={folderInput}
				type="file"
				hidden
				multiple
				// Non-standard, but the only way to read a whole tree from a picker;
				// `webkitRelativePath` is what carries the structure.
				{...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
				onChange={(e) => {
					onFiles(Array.from(e.target.files ?? []), true);
					e.target.value = "";
				}}
			/>
		</div>
	);
}

/** The "New ▾" button: folders and receive links. */
export function NewMenu({
	onNewFolder,
	onReceiveLink,
	canCreate,
}: {
	onNewFolder: () => void;
	onReceiveLink: () => void;
	canCreate: boolean;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs">
					<Inbox className="size-3.5" /> New
					<ChevronDown className="size-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuItem disabled={!canCreate} onSelect={onNewFolder}>
					<FolderUp /> Folder
					<span className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground">
						Ctrl+Shift+N
					</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onReceiveLink}>
					<Inbox /> Receive link…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
