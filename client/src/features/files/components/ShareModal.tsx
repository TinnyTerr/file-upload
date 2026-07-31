import {
	Code2,
	ExternalLink,
	FileText,
	KeyRound,
	Link2,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { QRCode } from "@/components/ui/qr-code";
import { Tooltip } from "@/components/ui/tooltip";
import { asHtml, asMarkdown } from "@/lib/copy";
import { shareUrl } from "../lib/shareUrl";
import type { EncryptionMode } from "../types";

export interface ShareEntry {
	filename: string;
	mode: EncryptionMode;
	/** Base URL with no key, e.g. https://host/file/<slug> or /d/<slug>. */
	baseUrl: string;
	accessKey?: string | null;
	clientKeyB64?: string | null;
}

function EncryptionNote({ mode }: { mode: EncryptionMode }) {
	const keyClass =
		"whitespace-nowrap rounded bg-background/50 px-1 py-0.5 font-mono text-[11px]";

	if (mode === "client") {
		return (
			<p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
				<ShieldAlert className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 leading-relaxed">
					End-to-end encrypted. The key <code className={keyClass}>#ek=</code>{" "}
					lives only in this URL. Save the full URL because it cannot be
					recovered from the server.
				</span>
			</p>
		);
	}
	if (mode === "sealed") {
		return (
			<p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
				<ShieldAlert className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 leading-relaxed">
					Sealed. This server threw the key away, so the URL below opens nothing
					on its own — the recipient needs the key you saved when you sealed it,
					appended as <code className={keyClass}>#ek=</code>, or the password it
					was derived from.
				</span>
			</p>
		);
	}
	if (mode === "server") {
		return (
			<p className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">
				<ShieldCheck className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 leading-relaxed">
					Server-side encrypted. Downloads require the access key{" "}
					<code className={keyClass}>?ek=</code>. Share the full URL.
				</span>
			</p>
		);
	}
	return null;
}

function UrlRow({
	label,
	value,
	icon,
}: {
	label: string;
	value: string;
	icon: React.ReactNode;
}) {
	return (
		<div className="space-y-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
				<span className="text-muted-foreground">{icon}</span>
				<code className="flex-1 truncate font-mono text-xs">{value}</code>
				<CopyButton value={value} className="shrink-0" />
			</div>
		</div>
	);
}

function EntryCard({ entry }: { entry: ShareEntry }) {
	const fullUrl = useMemo(
		() =>
			shareUrl(entry.baseUrl, entry.mode, {
				accessKey: entry.accessKey,
				clientKeyB64: entry.clientKeyB64,
			}),
		[entry],
	);
	const key = entry.mode === "client" ? entry.clientKeyB64 : entry.accessKey;
	const hasKey = entry.mode !== "none" && !!key;

	return (
		<div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-4">
			<div className="flex items-center justify-between gap-2">
				<span className="truncate font-medium" title={entry.filename}>
					{entry.filename}
				</span>
				<Badge
					variant={
						entry.mode === "client"
							? "warning"
							: entry.mode === "server"
								? "accent"
								: "secondary"
					}
				>
					{entry.mode === "none"
						? "public"
						: entry.mode === "client"
							? "end-to-end"
							: "server-encrypted"}
				</Badge>
			</div>

			<EncryptionNote mode={entry.mode} />

			<UrlRow
				label="Share URL"
				value={fullUrl}
				icon={<Link2 className="size-3.5" />}
			/>
			{hasKey && (
				<UrlRow
					label="URL without key"
					value={entry.baseUrl}
					icon={<Link2 className="size-3.5" />}
				/>
			)}
			{hasKey && key && (
				<UrlRow
					label="Key only"
					value={key}
					icon={<KeyRound className="size-3.5" />}
				/>
			)}

			<div className="flex flex-wrap items-center gap-2 pt-1">
				<CopyButton
					value={asMarkdown(entry.filename, fullUrl)}
					variant="secondary"
					size="sm"
					tooltip="Copy as Markdown"
				>
					<FileText /> Markdown
				</CopyButton>
				<CopyButton
					value={asHtml(entry.filename, fullUrl)}
					variant="secondary"
					size="sm"
					tooltip="Copy as HTML"
				>
					<Code2 /> HTML
				</CopyButton>
				<Tooltip content="Open in a new tab">
					<Button variant="secondary" size="sm" asChild>
						<a href={fullUrl} target="_blank" rel="noreferrer">
							<ExternalLink /> Open
						</a>
					</Button>
				</Tooltip>
			</div>
		</div>
	);
}

export function ShareModal({
	entries,
	open,
	onOpenChange,
	title,
	description,
}: {
	entries: ShareEntry[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title?: string;
	description?: string;
}) {
	const single = entries.length === 1 ? entries[0] : null;
	const singleUrl = single
		? shareUrl(single.baseUrl, single.mode, {
				accessKey: single.accessKey,
				clientKeyB64: single.clientKeyB64,
			})
		: null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] w-[min(calc(100vw-2rem),48rem)] max-w-none overflow-hidden">
				<DialogHeader>
					<DialogTitle>
						{title ??
							`Share ${entries.length > 1 ? `${entries.length} files` : "your file"}`}
					</DialogTitle>
					<DialogDescription>
						{description ?? "Copy a link or scan the code to share."}
					</DialogDescription>
				</DialogHeader>

				{single && singleUrl && singleUrl.length <= 1200 && (
					<div className="flex justify-center pb-1">
						<QRCode value={singleUrl} size={168} />
					</div>
				)}

				<div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
					{entries.map((entry) => (
						<EntryCard key={entry.baseUrl} entry={entry} />
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
