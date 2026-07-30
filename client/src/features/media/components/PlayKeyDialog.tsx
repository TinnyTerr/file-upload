import { KeyRound, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
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
import { Switch } from "@/components/ui/switch";
import { usePlayKeys } from "../hooks/useMedia";
import type { MintedPlayKey } from "../types";

const TTL_OPTIONS = [
	{ value: "3600", label: "1 hour" },
	{ value: "43200", label: "12 hours" },
	{ value: "86400", label: "24 hours" },
	{ value: "604800", label: "7 days" },
	{ value: "2592000", label: "30 days" },
];

export interface PlayKeyTarget {
	/** Exactly one of these. A collection key plays every entry via the m3u. */
	fileId?: number;
	directoryId?: number;
	title: string;
}

/** Mints a play key and shows the resulting mpv command exactly once — the
 * token is not recoverable afterwards, only revocable. */
export function PlayKeyDialog({
	target,
	open,
	onOpenChange,
}: {
	target: PlayKeyTarget | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { mint } = usePlayKeys();
	const [ttl, setTtl] = useState("43200");
	const [label, setLabel] = useState("");
	const [bindIp, setBindIp] = useState(false);
	const [minted, setMinted] = useState<MintedPlayKey | null>(null);

	const close = (next: boolean) => {
		onOpenChange(next);
		if (!next) {
			// Drop the token from memory as soon as the dialog closes.
			setMinted(null);
			setLabel("");
		}
	};

	const onMint = async () => {
		if (!target) return;
		const key = await mint.mutateAsync({
			...(target.fileId !== undefined
				? { file_id: target.fileId }
				: { directory_id: target.directoryId }),
			ttl_seconds: Number(ttl),
			label: label.trim() || undefined,
			bind_ip: bindIp,
		});
		setMinted(key);
	};

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<KeyRound className="size-4" />
						{minted ? "Your play key" : "Create a play key"}
					</DialogTitle>
					<DialogDescription>
						{minted
							? "Copy it now — this is the only time it's shown."
							: `A URL that plays "${target?.title ?? ""}" in mpv or any player that takes a URL.`}
					</DialogDescription>
				</DialogHeader>

				{minted ? (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label>mpv command</Label>
							<div className="flex items-start gap-2">
								<code className="block max-h-32 flex-1 overflow-auto break-all rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs">
									{minted.mpv_command}
								</code>
								<CopyButton value={minted.mpv_command} tooltip="Copy command" />
							</div>
						</div>
						<div className="space-y-2">
							<Label>Stream URL</Label>
							<div className="flex items-start gap-2">
								<code className="block max-h-32 flex-1 overflow-auto break-all rounded-md border border-border bg-secondary/40 p-3 font-mono text-xs">
									{minted.url}
								</code>
								<CopyButton value={minted.url} tooltip="Copy URL" />
							</div>
						</div>
						<p className="flex items-start gap-2 text-xs text-muted-foreground">
							<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
							<span>
								Anyone holding this URL can play the title until it expires (
								{new Date(minted.expires_at).toLocaleString()}) or you revoke
								it.
								{minted.bound_ip
									? ` It only works from ${minted.bound_ip}.`
									: ""}
							</span>
						</p>
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="playkey-ttl">Expires after</Label>
							<Select value={ttl} onValueChange={setTtl}>
								<SelectTrigger id="playkey-ttl">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TTL_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="playkey-label">Label (optional)</Label>
							<Input
								id="playkey-label"
								value={label}
								onChange={(e) => setLabel(e.target.value)}
								placeholder="Living room TV"
							/>
						</div>
						<div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
							<div className="space-y-0.5">
								<Label htmlFor="playkey-bind">Lock to this address</Label>
								<p className="text-xs text-muted-foreground">
									The key only streams from the IP you're on right now.
								</p>
							</div>
							<Switch
								id="playkey-bind"
								checked={bindIp}
								onCheckedChange={setBindIp}
							/>
						</div>
					</div>
				)}

				<DialogFooter>
					{minted ? (
						<Button onClick={() => close(false)}>Done</Button>
					) : (
						<>
							<Button variant="ghost" onClick={() => close(false)}>
								Cancel
							</Button>
							<Button onClick={onMint} disabled={mint.isPending}>
								{mint.isPending ? "Creating…" : "Create key"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
