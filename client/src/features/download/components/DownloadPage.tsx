import { Download, FileWarning, Hash, Save, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useAuth } from "@/features/auth/hooks/auth";
import { useSaveToMyFiles } from "@/features/files/hooks/useFiles";
import { iconForType } from "@/features/files/lib/fileMeta";
import {
	deriveSealKey,
	isSupportedSealKdf,
} from "@/features/files/lib/sealKey";
import { formatBytes } from "@/lib/bytes";
import { readClientKeyFromHash, readServerKeyFromQuery } from "@/lib/download";
import { useDownload } from "../hooks/useDownload";
import { useFileInfo } from "../hooks/useFileInfo";
import { rawPath } from "../services/publicService";
import { EncryptionBanner } from "./EncryptionBanner";
import { FilePreview } from "./FilePreview";

export function DownloadPage() {
	const { slug = "" } = useParams();
	const { data: info, isLoading, isError } = useFileInfo(slug);
	const { user } = useAuth();
	const save = useSaveToMyFiles();

	const clientKey = useMemo(() => readClientKeyFromHash(), []);
	const serverKey = useMemo(() => readServerKeyFromQuery(), []);

	const { download, status, percent, error } = useDownload(
		slug,
		info?.filename ?? "download",
		info?.encryption_mode ?? "none",
		info?.size_bytes,
	);
	const [hashAlgo, setHashAlgo] = useState<string>("");
	// Seal & Forget with a password: the key is rebuilt here from the password
	// plus the salt the server publishes, and exists only in this tab.
	const [sealPassword, setSealPassword] = useState("");
	const [sealKey, setSealKey] = useState<Uint8Array | null>(null);
	const [sealError, setSealError] = useState<string | null>(null);
	const [deriving, setDeriving] = useState(false);

	if (isLoading) {
		return (
			<Card>
				<CardContent className="space-y-4 p-6">
					<Skeleton className="h-8 w-2/3" />
					<Skeleton className="h-4 w-1/3" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-40 w-full" />
				</CardContent>
			</Card>
		);
	}

	if (isError || !info) {
		return (
			<EmptyState
				icon={FileWarning}
				title="Link not found"
				description="This link may have expired, been used up, or never existed."
			/>
		);
	}

	const Icon = iconForType(info.content_type);
	// A sealed file takes either a raw key from the fragment (random seal) or a
	// password it derives one from.
	const passwordSealed =
		info.encryption_mode === "sealed" && isSupportedSealKdf(info.seal_kdf);
	const hasKey =
		info.encryption_mode === "client"
			? !!clientKey
			: info.encryption_mode === "sealed"
				? !!clientKey || !!sealKey
				: info.encryption_mode === "server"
					? !!serverKey
					: true;

	const unlockSeal = async () => {
		setSealError(null);
		if (!info.seal_salt || !info.seal_kdf) return;
		setDeriving(true);
		try {
			setSealKey(
				await deriveSealKey(sealPassword, info.seal_salt, info.seal_kdf),
			);
		} catch (err) {
			setSealError(
				err instanceof Error ? err.message : "Couldn't derive the key",
			);
		} finally {
			setDeriving(false);
		}
	};
	const remaining =
		info.max_uses != null ? Math.max(0, info.max_uses - info.use_count) : null;
	const exhausted = remaining === 0;
	const busy = status === "downloading" || status === "decrypting";

	const shareUrlFull = `${window.location.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;
	const curl = `curl -L -O "${window.location.origin}${rawPath(slug, info.encryption_mode === "server" ? serverKey : undefined)}"`;
	const hashes = info.hashes ?? {};
	const algos = Object.keys(hashes);
	const activeAlgo = hashAlgo || algos[0];

	return (
		<div className="space-y-4">
			<Card>
				<CardContent className="space-y-5 p-6">
					{/* Hero */}
					<div className="flex items-start gap-4">
						<div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-secondary/50">
							<Icon className="size-7 text-muted-foreground" />
						</div>
						<div className="min-w-0 flex-1">
							<h1 className="break-words text-xl font-bold">{info.filename}</h1>
							<div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
								<span>{formatBytes(info.size_bytes)}</span>
								{info.content_type && <span>· {info.content_type}</span>}
								{remaining != null && (
									<Badge variant={exhausted ? "destructive" : "secondary"}>
										{exhausted
											? "exhausted"
											: `${remaining} download${remaining === 1 ? "" : "s"} left`}
									</Badge>
								)}
							</div>
						</div>
					</div>

					<EncryptionBanner mode={info.encryption_mode} hasKey={hasKey} />

					{/* Deriving a key can't tell a right password from a wrong one --
					    only the decrypt can. So the prompt comes back if the download
					    failed, rather than stranding someone on a bad key. */}
					{passwordSealed && (!sealKey || !!error) && (
						<div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
							<p className="text-sm">
								This file was sealed with a password. Deriving the key takes a
								moment — it is deliberately slow, so guessing is expensive.
							</p>
							<div className="flex gap-2">
								<Input
									type="password"
									placeholder="Seal password"
									value={sealPassword}
									onChange={(e) => setSealPassword(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") unlockSeal();
									}}
								/>
								<Button
									onClick={unlockSeal}
									loading={deriving}
									disabled={!sealPassword}
								>
									Unlock
								</Button>
							</div>
							{sealError && (
								<p className="text-sm text-destructive">{sealError}</p>
							)}
						</div>
					)}

					{/* Uploader info */}
					{info.uploader && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<UserAvatar
								userId={info.uploader.user_id}
								username={info.uploader.username}
								hasAvatar={info.uploader.has_avatar}
								size="sm"
							/>
							<span>
								Uploaded by <strong>{info.uploader.username}</strong>
							</span>
						</div>
					)}

					{/* Download */}
					<div className="space-y-2">
						<Button
							size="lg"
							className="w-full"
							disabled={
								exhausted ||
								(info.encryption_mode !== "none" && !hasKey) ||
								busy
							}
							loading={busy}
							onClick={() => download({ clientKey, serverKey, sealKey })}
						>
							<Download />
							{exhausted
								? "Link exhausted"
								: status === "decrypting"
									? "Decrypting…"
									: status === "downloading"
										? "Downloading…"
										: "Download"}
						</Button>
						{busy && <Progress value={percent} />}
						{error && <p className="text-sm text-destructive">{error}</p>}
						{user && (
							<Button
								variant="secondary"
								className="w-full"
								loading={save.isPending}
								disabled={info.already_saved}
								onClick={() => save.mutate(slug)}
							>
								<Save />{" "}
								{info.already_saved ? "Already saved" : "Save to my files"}
							</Button>
						)}
					</div>

					{/* Preview */}
					<FilePreview slug={slug} info={info} />
				</CardContent>
			</Card>

			{/* Share & copy */}
			<Card>
				<CardContent className="space-y-3 p-5">
					<h2 className="text-sm font-semibold">Share &amp; copy</h2>
					<CopyRow label="Share URL" value={shareUrlFull} />
					<CopyRow
						label="Raw URL"
						value={`${window.location.origin}${rawPath(slug, info.encryption_mode === "server" ? serverKey : undefined)}`}
					/>
					<div className="space-y-1">
						<span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
							<Terminal className="size-3.5" /> curl
						</span>
						<div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
							<code className="flex-1 truncate font-mono text-xs">{curl}</code>
							<CopyButton value={curl} />
						</div>
					</div>

					{algos.length > 0 && activeAlgo && (
						<div className="space-y-1">
							<span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
								<Hash className="size-3.5" /> Checksum
							</span>
							<div className="flex items-center gap-2">
								<Select value={activeAlgo} onValueChange={setHashAlgo}>
									<SelectTrigger className="w-32 shrink-0">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{algos.map((a) => (
											<SelectItem key={a} value={a}>
												{a}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<div className="flex flex-1 items-start gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
									<code className="flex-1 break-all font-mono text-xs leading-relaxed">
										{hashes[activeAlgo]}
									</code>
									<CopyButton value={hashes[activeAlgo]} className="shrink-0" />
								</div>
							</div>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function CopyRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="space-y-1">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			<div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
				<code className="flex-1 truncate font-mono text-xs">{value}</code>
				<CopyButton value={value} />
			</div>
		</div>
	);
}
