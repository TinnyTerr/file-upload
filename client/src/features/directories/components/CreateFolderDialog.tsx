import { FolderPlus, Info } from "lucide-react";
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
import { useAuth } from "@/features/auth/hooks/auth";
import {
	type ShareEntry,
	ShareModal,
} from "@/features/files/components/ShareModal";
import { folderUrl } from "@/features/files/lib/shareUrl";
import type { EncryptionMode } from "@/features/files/types";
import { useCreateDirectory } from "../hooks/useDirectories";
import { createFolderKeyMaterial } from "../lib/folderKey";

/** Create an empty folder (no upload required). */
export function CreateFolderDialog({ trigger }: { trigger?: React.ReactNode }) {
	const { can } = useAuth();
	const create = useCreateDirectory();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [mode, setMode] = useState<EncryptionMode>("none");
	const [error, setError] = useState<string | null>(null);
	const [creatingKey, setCreatingKey] = useState(false);
	const [shareEntry, setShareEntry] = useState<ShareEntry | null>(null);
	const [shareOpen, setShareOpen] = useState(false);

	const onCreate = async () => {
		setError(null);
		setCreatingKey(true);
		try {
			const finalTitle = title.trim() || "Untitled folder";
			const keyMaterial =
				mode === "client" ? await createFolderKeyMaterial() : null;
			const created = await create.mutateAsync({
				title: finalTitle,
				encryption_mode: mode,
				key_check_blob: keyMaterial?.keyCheckBlob ?? null,
			});
			setOpen(false);
			setTitle("");
			setMode("none");
			setShareEntry({
				filename: finalTitle,
				mode,
				baseUrl: folderUrl(created.slug),
				accessKey: created.access_key,
				clientKeyB64: keyMaterial?.clientKeyB64 ?? null,
			});
			setShareOpen(true);
		} catch (err: any) {
			setError(err.message || "Failed to create folder");
		} finally {
			setCreatingKey(false);
		}
	};

	return (
		<>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					{trigger ?? (
						<Button size="sm" variant="outline">
							<FolderPlus /> New folder
						</Button>
					)}
				</DialogTrigger>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>New folder</DialogTitle>
						<DialogDescription>
							Create an empty folder, then add files to it later.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
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
						<div className="space-y-1.5">
							<Label className="flex items-center gap-1.5">
								Encryption
								<Tooltip content="Files added later inherit this mode. Client mode uses one key for the whole folder.">
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
					</div>
					{error && (
						<div className="text-sm font-medium text-destructive">{error}</div>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							onClick={onCreate}
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
