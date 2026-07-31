import {
	ChevronDown,
	FileIcon,
	FolderUp,
	KeyRound,
	Trash2,
	Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { Directory } from "@/features/directories/types";
import { Dropzone } from "@/features/files/components/Dropzone";
import {
	type ShareEntry,
	ShareModal,
} from "@/features/files/components/ShareModal";
import {
	defaultFormState,
	toUploadOptions,
	type UploadFormState,
	UploadOptionsForm,
} from "@/features/files/components/UploadOptionsForm";
import { UploadQueue } from "@/features/files/components/UploadQueue";
import { useUpload } from "@/features/files/hooks/useUpload";
import { outcomeToShareEntry } from "@/features/files/lib/shareMapping";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import { useDriveTreeUpload } from "../hooks/useDriveUpload";
import { UnlockFolderDialog } from "./UnlockFolderDialog";

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
 * Uploads into whichever folder the explorer currently has open. The
 * destination folder decides the encryption (the backend derives it from the
 * folder), so inside a folder the mode is shown rather than chosen.
 */
export function DriveUploadCard({ dir }: { dir: Directory | null }) {
	const [files, setFiles] = useState<File[]>([]);
	const [form, setForm] = useState<UploadFormState>(defaultFormState);
	const [showOptions, setShowOptions] = useState(false);
	const { items, busy, start, cancel, clearFinished } = useUpload();
	const tree = useDriveTreeUpload();
	const [shareEntries, setShareEntries] = useState<ShareEntry[]>([]);
	const [shareOpen, setShareOpen] = useState(false);
	const [folderKey, setFolderKey] = useState<Uint8Array | null>(null);
	const [unlockOpen, setUnlockOpen] = useState(false);
	/** Set while a pick is waiting on the folder key. */
	const [pendingTree, setPendingTree] = useState<File[] | null>(null);

	// Navigating between folders keeps this component mounted (`/files` and
	// `/files/:dirId` are the same page at different depths), so everything that
	// belongs to the folder you *were* in has to be dropped explicitly. A stale
	// `folderKey` is the dangerous one: it would suppress the unlock prompt in
	// the next end-to-end folder and encrypt those uploads under the previous
	// folder's key, which nothing there can ever decrypt.
	const openedDirId = dir?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the open folder; resetting on anything else would discard a key mid-upload.
	useEffect(() => {
		setFolderKey(null);
		setPendingTree(null);
		setUnlockOpen(false);
		setFiles([]);
	}, [openedDirId]);

	// An end-to-end folder's key never reached the server, so nothing can be
	// encrypted into it until the browser is handed that key.
	const needsKey = dir?.encryption_mode === "client" && !folderKey;
	const mode = dir ? dir.encryption_mode : form.encryption_mode;

	const uploadOptions = () => ({
		...toUploadOptions(form),
		encryption_mode: mode,
		directory_id: dir?.id ?? null,
	});

	const onUpload = async () => {
		if (needsKey) {
			setUnlockOpen(true);
			return;
		}
		const results = await start(files, uploadOptions(), folderKey ?? undefined);
		setFiles([]);
		if (results.length) {
			setShareEntries(
				results
					.map((r) => outcomeToShareEntry(r.filename, r.outcome))
					.filter((e): e is ShareEntry => e !== null),
			);
			setShareOpen(true);
		}
	};

	const onPickTree = async (picked: File[]) => {
		if (!picked.length) return;
		if (needsKey) {
			setPendingTree(picked);
			setUnlockOpen(true);
			return;
		}
		await tree.uploadTree({
			files: picked,
			parent: dir,
			rootMode: form.encryption_mode,
			presetKey: folderKey ?? undefined,
			options: toUploadOptions(form),
		});
	};

	const onUnlocked = (key: Uint8Array) => {
		setFolderKey(key);
		const queued = pendingTree;
		setPendingTree(null);
		if (queued) {
			tree.uploadTree({
				files: queued,
				parent: dir,
				rootMode: form.encryption_mode,
				presetKey: key,
				options: toUploadOptions(form),
			});
		}
	};

	const totalBytes = files.reduce((n, f) => n + f.size, 0);

	return (
		<Card>
			<CardContent className="space-y-4 pt-6">
				<Dropzone
					onFiles={(f) => setFiles((prev) => [...prev, ...f])}
					hint={
						dir
							? `Files land in “${dir.title}”`
							: "Files land at the top level of your drive"
					}
				/>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
						<FolderUp className="size-3.5" />
						Upload a folder
						<input
							type="file"
							hidden
							multiple
							// Non-standard, but the only way to read a whole tree from a
							// picker; `webkitRelativePath` is what carries the structure.
							{...({ webkitdirectory: "", directory: "" } as Record<
								string,
								string
							>)}
							onChange={(e) => {
								onPickTree(Array.from(e.target.files ?? []));
								e.target.value = "";
							}}
						/>
					</label>
					<button
						type="button"
						onClick={() => setShowOptions((s) => !s)}
						className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						Upload options
						<ChevronDown
							className={cn(
								"size-3.5 transition-transform",
								showOptions && "rotate-180",
							)}
						/>
					</button>
				</div>

				{needsKey && (
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
						<span>
							“{dir?.title}” is end-to-end encrypted — unlock it to upload.
						</span>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setUnlockOpen(true)}
						>
							<KeyRound className="size-3.5" /> Unlock
						</Button>
					</div>
				)}

				{showOptions && (
					<UploadOptionsForm
						value={form}
						onChange={setForm}
						hideDirectoryPicker
						encryptionLockedTo={dir ? inheritedNotice(dir) : null}
					/>
				)}

				{files.length > 0 && (
					<>
						<ul className="space-y-1.5">
							{files.map((f, i) => (
								<li
									key={`${f.name}-${f.size}-${f.lastModified}`}
									className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-sm"
								>
									<span className="flex min-w-0 items-center gap-2">
										<FileIcon className="size-4 shrink-0 text-muted-foreground" />
										<span className="truncate">{f.name}</span>
									</span>
									<span className="flex items-center gap-2 text-xs text-muted-foreground">
										{formatBytes(f.size)}
										<Button
											variant="ghost"
											size="icon"
											className="size-6"
											onClick={() =>
												setFiles((prev) => prev.filter((_, idx) => idx !== i))
											}
											aria-label={`Remove ${f.name}`}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</span>
								</li>
							))}
						</ul>
						<Button onClick={onUpload} loading={busy} className="w-full">
							<Upload className="mr-2" /> Upload {files.length} file
							{files.length > 1 ? "s" : ""} · {formatBytes(totalBytes)}
						</Button>
					</>
				)}

				{tree.busy && tree.progress && (
					<div className="space-y-1.5">
						<Progress
							value={Math.round(
								((tree.progress.completed + tree.progress.percent / 100) /
									tree.progress.total) *
									100,
							)}
						/>
						<p className="text-xs text-muted-foreground">
							Uploading {tree.progress.completed + 1} of {tree.progress.total}
							{tree.progress.current ? ` · ${tree.progress.current}` : ""}
						</p>
					</div>
				)}

				{items.length > 0 && (
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Transfers</span>
							{!busy && (
								<Button variant="ghost" size="sm" onClick={clearFinished}>
									Clear finished
								</Button>
							)}
						</div>
						<UploadQueue items={items} onCancel={cancel} />
					</div>
				)}
			</CardContent>

			{dir && (
				<UnlockFolderDialog
					dir={dir}
					open={unlockOpen}
					onOpenChange={(o) => {
						setUnlockOpen(o);
						if (!o) setPendingTree(null);
					}}
					onUnlocked={onUnlocked}
				/>
			)}
			<ShareModal
				entries={shareEntries}
				open={shareOpen}
				onOpenChange={setShareOpen}
			/>
		</Card>
	);
}
