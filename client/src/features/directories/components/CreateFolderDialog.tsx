import { FolderPlus, Info } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/config/api";
import { useAuth } from "@/features/auth/hooks/auth";
import { useRevealedKeys } from "@/features/drive/hooks/useRevealedKeys";
import {
	type ShareEntry,
	ShareModal,
} from "@/features/files/components/ShareModal";
import { folderUrl } from "@/features/files/lib/shareUrl";
import type { EncryptionMode } from "@/features/files/types";
import { useCreateDirectory } from "../hooks/useDirectories";
import { createFolderKeyMaterial } from "../lib/folderKey";
import type { Directory } from "../types";

/** Create an empty folder.
 *
 * `parent` decides what the dialog even asks for. A root-level folder picks
 * its own encryption; a nested one always inherits from the chain above it
 * (the backend rejects an explicit mode on a child), so there is nothing to
 * choose and we say so rather than showing a disabled control. */
export function CreateFolderDialog({
	parent = null,
	trigger,
	onCreated,
	open: openProp,
	onOpenChange,
}: {
	parent?: Directory | null;
	/** Omit together with `open` to get the built-in "New folder" button. */
	trigger?: React.ReactNode;
	onCreated?: (dir: { id: number }) => void;
	/** Controlled mode, for callers that open this from a toolbar or a
	 * keyboard shortcut and have no trigger element to hang it off. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const { can } = useAuth();
	const create = useCreateDirectory();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const controlled = openProp !== undefined;
	const open = controlled ? openProp : uncontrolledOpen;
	const setOpen = (next: boolean) => {
		if (!controlled) setUncontrolledOpen(next);
		onOpenChange?.(next);
	};
	const [title, setTitle] = useState("");
	const [mode, setMode] = useState<EncryptionMode>("none");
	const [error, setError] = useState<string | null>(null);
	const [creatingKey, setCreatingKey] = useState(false);
	const { remember } = useRevealedKeys();
	const [shareEntry, setShareEntry] = useState<ShareEntry | null>(null);
	const [shareOpen, setShareOpen] = useState(false);

	const nested = parent !== null;

	const onCreate = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setCreatingKey(true);
		try {
			const finalTitle = title.trim() || "Untitled folder";
			const keyMaterial =
				!nested && mode === "client" ? await createFolderKeyMaterial() : null;
			const created = await create.mutateAsync(
				nested
					? { title: finalTitle, parent_directory_id: parent.id }
					: {
							title: finalTitle,
							encryption_mode: mode,
							key_check_blob: keyMaterial?.keyCheckBlob ?? null,
						},
			);
			setOpen(false);
			setTitle("");
			setMode("none");
			onCreated?.(created);
			// A nested folder has no key of its own to hand over, and its share
			// link is one click away inside the folder -- only surface the
			// save-this-now modal when there is actually a key to save.
			if (!nested) {
				// The browser just minted this key and the server never saw it, so
				// hand it to the app-level key map: uploading into this folder later
				// in the same tab shouldn't have to ask for a key it already has.
				if (keyMaterial?.clientKeyB64) {
					remember("folder", created.id, keyMaterial.clientKeyB64);
				}
				setShareEntry({
					filename: finalTitle,
					mode,
					baseUrl: folderUrl(created.slug),
					accessKey: created.access_key,
					clientKeyB64: keyMaterial?.clientKeyB64 ?? null,
				});
				setShareOpen(true);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setCreatingKey(false);
		}
	};

	return (
		<>
			<Dialog open={open} onOpenChange={setOpen}>
				{!controlled && (
					<DialogTrigger asChild>
						{trigger ?? (
							<Button size="sm" variant="outline">
								<FolderPlus /> New folder
							</Button>
						)}
					</DialogTrigger>
				)}
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>New folder</DialogTitle>
						<DialogDescription>
							{parent
								? `Creates a folder inside “${parent.title}”.`
								: "Create an empty folder, then add files to it later."}
						</DialogDescription>
					</DialogHeader>
					<form
						id="create-folder-form"
						onSubmit={onCreate}
						className="space-y-3"
					>
						<div className="space-y-1.5">
							<Label htmlFor="new-folder-title">Title</Label>
							<Input
								id="new-folder-title"
								autoFocus
								placeholder="My folder"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
						</div>
						{parent ? (
							<p className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
								Inherits{" "}
								{parent.encryption_mode === "none"
									? "no encryption"
									: `${parent.encryption_mode} encryption`}{" "}
								from “{parent.title}”. You can give it a key of its own
								afterwards.
							</p>
						) : (
							<div className="space-y-1.5">
								<Label className="flex items-center gap-1.5">
									Encryption
									<Tooltip content="Everything created inside this folder inherits this, unless you give it its own key later.">
										<Info className="size-3.5 text-muted-foreground" />
									</Tooltip>
								</Label>
								<Select
									value={mode}
									onValueChange={(v) => setMode(v as EncryptionMode)}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">None</SelectItem>
										<SelectItem value="server">Server-side (?ek=)</SelectItem>
										<SelectItem
											value="client"
											disabled={!can("can_upload_client_encrypted")}
										>
											End-to-end (#ek=)
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						)}
					</form>
					{error && (
						<div className="text-sm font-medium text-destructive">{error}</div>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							form="create-folder-form"
							loading={create.isPending || creatingKey}
						>
							Create folder
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<ShareModal
				entries={shareEntry ? [shareEntry] : []}
				open={shareOpen}
				onOpenChange={setShareOpen}
				title="Folder created"
				description="Copy the folder link and save any encryption key now."
			/>
		</>
	);
}
