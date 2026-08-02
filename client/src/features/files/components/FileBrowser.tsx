import {
	ChevronRight,
	FolderOpen,
	FolderPlus,
	Home,
	KeyRound,
	Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/hooks/auth";
import { CreateFolderDialog } from "@/features/directories/components/CreateFolderDialog";
import { useAddFiles } from "@/features/directories/hooks/useAddFiles";
import { useBrowse } from "@/features/directories/hooks/useDirectories";
import { verifyFolderKey } from "@/features/directories/lib/folderKey";
import { BrowserFileRow } from "./BrowserFileRow";
import { BrowserFolderRow } from "./BrowserFolderRow";
import { EncryptionBadge } from "../lib/fileMeta";

function extractClientKey(value: string): string {
	const trimmed = value.trim();
	const marker = "#ek=";
	const idx = trimmed.indexOf(marker);
	if (idx === -1) return trimmed;
	return trimmed.slice(idx + marker.length).split(/[?&#]/)[0];
}

/** Mega.nz-style unified file/folder browser: one navigable tree instead of
 * a flat "Folders" card plus a flat "Files" card. Current location lives in
 * the `?folder=` search param so it's shareable/back-button-friendly. */
export function FileBrowser() {
	const [params, setParams] = useSearchParams();
	const raw = params.get("folder");
	const folderId = raw ? Number(raw) : null;
	const { data, isLoading, isError } = useBrowse(folderId);
	const { can } = useAuth();
	const canUpload = can("can_upload");
	const canCreate = can("can_create_directories");

	const clientKey = useRef<Uint8Array | null>(null);
	const [clientKeyForFolder, setClientKeyForFolder] = useState<number | null>(
		null,
	);
	const [unlockOpen, setUnlockOpen] = useState(false);
	const [keyInput, setKeyInput] = useState("");
	const [keyError, setKeyError] = useState<string | null>(null);
	const [unlocking, setUnlocking] = useState(false);
	const pendingFiles = useRef<File[] | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const folderMode = data?.folder?.encryption_mode ?? "none";
	const { addFiles, busy } = useAddFiles(folderId, folderMode);

	const navigateTo = (id: number | null) => {
		setParams((prev) => {
			const next = new URLSearchParams(prev);
			if (id === null) next.delete("folder");
			else next.set("folder", String(id));
			return next;
		});
	};

	const needsUnlock =
		folderMode === "client" &&
		(clientKeyForFolder !== folderId || !clientKey.current);

	const openAddFiles = () => {
		if (needsUnlock) {
			pendingFiles.current = null;
			setUnlockOpen(true);
			return;
		}
		fileInputRef.current?.click();
	};

	const onFilesSelected = (files: File[]) => {
		if (!files.length) return;
		if (needsUnlock) {
			pendingFiles.current = files;
			setUnlockOpen(true);
			return;
		}
		addFiles(files, clientKey.current ?? undefined);
	};

	const unlockFolder = async () => {
		if (!data?.folder?.key_check_blob) {
			setKeyError(
				"This folder was created before key checks existed. Recreate it to add encrypted files later.",
			);
			return;
		}
		setKeyError(null);
		setUnlocking(true);
		try {
			const normalized = extractClientKey(keyInput);
			const key = await verifyFolderKey(normalized, data.folder.key_check_blob);
			clientKey.current = key;
			setClientKeyForFolder(folderId);
			setKeyInput("");
			setUnlockOpen(false);
			const queued = pendingFiles.current;
			if (queued?.length) {
				pendingFiles.current = null;
				addFiles(queued, key);
			}
		} catch (err) {
			setKeyError(err instanceof Error ? err.message : "Invalid folder key.");
		} finally {
			setUnlocking(false);
		}
	};

	const empty =
		!isLoading && (data?.folders.length ?? 0) === 0 && (data?.files.length ?? 0) === 0;

	return (
		<Card>
			<CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
				<CardTitle className="flex min-w-0 flex-wrap items-center gap-1 text-base font-semibold">
					<button
						type="button"
						onClick={() => navigateTo(null)}
						className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-secondary/50"
					>
						<Home className="size-4" /> Files
					</button>
					{data?.breadcrumb.map((c) => (
						<span key={c.id} className="flex items-center gap-1">
							<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							<button
								type="button"
								onClick={() => navigateTo(c.id)}
								className="truncate rounded px-1.5 py-1 hover:bg-secondary/50"
							>
								{c.title}
							</button>
						</span>
					))}
					{data?.folder && <EncryptionBadge mode={data.folder.encryption_mode} />}
				</CardTitle>
				<div className="flex items-center gap-2">
					{canCreate && <CreateFolderDialog parentId={folderId} />}
					{canUpload && (
						<>
							<Button
								size="sm"
								variant="outline"
								loading={busy}
								onClick={openAddFiles}
							>
								<Upload /> Add files
							</Button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								hidden
								onChange={(e) => {
									if (e.target.files?.length)
										onFilesSelected(Array.from(e.target.files));
									e.target.value = "";
								}}
							/>
						</>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-16 w-full" />
					</div>
				) : isError ? (
					<EmptyState
						icon={FolderOpen}
						title="Couldn't load this folder"
						description="Try refreshing the page."
					/>
				) : empty ? (
					<EmptyState
						icon={FolderOpen}
						title={folderId === null ? "No files yet" : "This folder is empty"}
						description={
							folderId === null
								? "Upload a file or create a folder above to get started."
								: "Add files or subfolders using the buttons above."
						}
						action={
							canCreate ? (
								<CreateFolderDialog
									parentId={folderId}
									trigger={
										<Button size="sm" variant="outline">
											<FolderPlus /> New folder
										</Button>
									}
								/>
							) : undefined
						}
					/>
				) : (
					<div className="space-y-2">
						{data!.folders.map((f) => (
							<BrowserFolderRow key={`d${f.id}`} dir={f} onOpen={() => navigateTo(f.id)} />
						))}
						{data!.files.map((f) => (
							<BrowserFileRow key={`f${f.id}`} file={f} currentDirId={folderId} />
						))}
					</div>
				)}
			</CardContent>

			<Dialog
				open={unlockOpen}
				onOpenChange={(o) => {
					setUnlockOpen(o);
					if (!o) {
						pendingFiles.current = null;
						setKeyError(null);
					}
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<KeyRound className="size-4 text-primary" /> Unlock folder
						</DialogTitle>
						<DialogDescription>
							Paste this folder's key or full #ek= URL before adding
							end-to-end encrypted files.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="folder-key-input">Folder key</Label>
						<Input
							id="folder-key-input"
							value={keyInput}
							onChange={(e) => setKeyInput(e.target.value)}
							placeholder="Paste key or full folder URL"
						/>
						{keyError && (
							<p className="text-sm font-medium text-destructive">{keyError}</p>
						)}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setUnlockOpen(false)}>
							Cancel
						</Button>
						<Button onClick={unlockFolder} loading={unlocking}>
							Unlock
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
