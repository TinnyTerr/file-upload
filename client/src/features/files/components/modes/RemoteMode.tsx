import { Info, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { FolderPicker } from "@/features/drive/components/FolderPicker";
import { useRemoteUpload } from "../../hooks/useRemoteUpload";
import { fileUrl } from "../../lib/shareUrl";
import { type ShareEntry, ShareModal } from "../ShareModal";

export function RemoteMode() {
	const [url, setUrl] = useState("");
	const [filename, setFilename] = useState("");
	const [directoryId, setDirectoryId] = useState<number | null>(null);
	const remote = useRemoteUpload();
	const [shareEntry, setShareEntry] = useState<ShareEntry | null>(null);
	const [shareOpen, setShareOpen] = useState(false);

	const onFetch = async () => {
		const res = await remote.mutateAsync({ url, filename, directoryId });
		setUrl("");
		setFilename("");
		setShareEntry({
			filename:
				res.source_type === "remote"
					? filename || "remote-upload"
					: "remote-upload",
			mode: res.encryption_mode,
			baseUrl: fileUrl(res.slug),
			accessKey: res.access_key,
			clientKeyB64: null,
		});
		setShareOpen(true);
	};

	return (
		<div className="space-y-4">
			<p className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
				<Info className="mt-0.5 size-4 shrink-0" />
				The server fetches a publicly-reachable URL. Private, loopback and
				reserved addresses are blocked.
			</p>

			<div className="space-y-1.5">
				<Label htmlFor="remote-url">Remote URL</Label>
				<Input
					id="remote-url"
					type="url"
					placeholder="https://example.com/file.zip"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="remote-name" className="flex items-center gap-1.5">
					Filename (optional)
					<Tooltip content="Override the stored filename. Defaults to the name from the URL.">
						<Info className="size-3.5 text-muted-foreground" />
					</Tooltip>
				</Label>
				<Input
					id="remote-name"
					placeholder="auto"
					value={filename}
					onChange={(e) => setFilename(e.target.value)}
				/>
			</div>

			<div className="space-y-1.5">
				<Label className="flex items-center gap-1.5">
					Destination
					<Tooltip content="Where the fetched file lands. A folder's encryption applies to it, exactly as if you had uploaded it there yourself.">
						<Info className="size-3.5 text-muted-foreground" />
					</Tooltip>
				</Label>
				<FolderPicker
					rootLabel="My Drive — no folder"
					// The server refuses to fill an end-to-end folder on someone's
					// behalf (routes/files.ts::finalizeStoredFile), so offering one
					// here would only produce a request that fails later.
					veto={(d) =>
						d.encryption_mode === "client" || d.encryption_mode === "sealed"
							? "end-to-end"
							: null
					}
					className="max-h-44"
					value={directoryId}
					onChange={setDirectoryId}
				/>
			</div>

			<Button
				onClick={onFetch}
				loading={remote.isPending}
				disabled={!url.trim()}
				className="w-full"
			>
				<Upload className="mr-2" /> Fetch &amp; store
			</Button>

			<ShareModal
				entries={shareEntry ? [shareEntry] : []}
				open={shareOpen}
				onOpenChange={setShareOpen}
			/>
		</div>
	);
}
