import { Info, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useRemoteUpload } from "../../hooks/useRemoteUpload";
import { fileUrl } from "../../lib/shareUrl";
import { type ShareEntry, ShareModal } from "../ShareModal";

export function RemoteMode() {
	const [url, setUrl] = useState("");
	const [filename, setFilename] = useState("");
	const remote = useRemoteUpload();
	const [shareEntry, setShareEntry] = useState<ShareEntry | null>(null);
	const [shareOpen, setShareOpen] = useState(false);

	const onFetch = async () => {
		const res = await remote.mutateAsync({ url, filename });
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
