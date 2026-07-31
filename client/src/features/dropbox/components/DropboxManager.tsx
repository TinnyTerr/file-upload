import { Clock, ExternalLink, Inbox, Info, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QRCode } from "@/components/ui/qr-code";
import { Tooltip } from "@/components/ui/tooltip";
import { FolderPicker } from "@/features/drive/components/FolderPicker";
import { formatDateTime, parseDuration, relativeTime } from "@/lib/time";
import { useDropboxManager } from "../hooks/useDropboxManager";
import { receiveUrl } from "../services/dropboxService";

/** Single-slot receive-link manager shown in the Files page "Receive" tab. */
export function DropboxManager() {
	const { active, creating, create, cancel } = useDropboxManager();
	const [expiry, setExpiry] = useState("1h");
	const [directoryId, setDirectoryId] = useState<number | null>(null);

	if (active) {
		const url = receiveUrl(active.token);
		return (
			<div className="space-y-4">
				<p className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
					<Info className="mt-0.5 size-4 shrink-0" />
					Send this link to someone so they can upload one file to you. It's
					disabled after the first upload. You can only have one active receive
					link at a time.
				</p>

				<div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
					<div className="flex justify-center">
						<QRCode value={url} size={150} />
					</div>
					<div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
						<code className="flex-1 truncate font-mono text-xs">{url}</code>
						<CopyButton value={url} />
					</div>
					<p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
						<Clock className="size-3.5" />
						<Tooltip content={formatDateTime(active.expires_at)}>
							<span>Expires {relativeTime(active.expires_at)}</span>
						</Tooltip>
					</p>
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button variant="secondary" size="sm" asChild>
							<a href={url} target="_blank" rel="noreferrer">
								<ExternalLink /> Open upload page
							</a>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="text-destructive"
							onClick={cancel}
						>
							<X /> Cancel link
						</Button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<p className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
				<Info className="mt-0.5 size-4 shrink-0" />
				Create a one-time inbound link so someone can send you a file. It's
				disabled after the first upload.
			</p>

			<div className="space-y-1.5">
				<Label htmlFor="dropbox-expiry" className="flex items-center gap-1.5">
					Expires in
					<Tooltip content="Duration like 1h, 24h, 7d. Min 60s, max 30 days.">
						<Info className="size-3.5 text-muted-foreground" />
					</Tooltip>
				</Label>
				<Input
					id="dropbox-expiry"
					placeholder="1h"
					value={expiry}
					onChange={(e) => setExpiry(e.target.value)}
				/>
			</div>

			<div className="space-y-1.5">
				<Label className="flex items-center gap-1.5">
					Destination
					<Tooltip content="Where their file lands. End-to-end folders are greyed out — whoever uploads has no key for them.">
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
				className="w-full"
				loading={creating}
				onClick={() =>
					create(Math.max(60, parseDuration(expiry) ?? 3600), directoryId)
				}
			>
				<Inbox /> Create receive link
			</Button>
		</div>
	);
}
