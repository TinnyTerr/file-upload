import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload, Download, Trash2, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/config/api";
import type {
	DebridSettingsInput,
	DebridStatus,
} from "@/features/torrents/types";
import { formatBytes } from "@/lib/bytes";
import { relativeTime } from "@/lib/time";
import { useDialogs } from "@/providers/DialogProvider";
import { adminService } from "../services/adminService";

const BUSY = new Set(["queued", "downloading", "fetching", "importing"]);
const STATUS_QUERY = ["admin", "torrent-status"] as const;

function premiumLeft(seconds: number | undefined): string | null {
	if (!seconds || seconds <= 0) return null;
	const days = Math.round(seconds / 86400);
	return days >= 1
		? `${days} day${days === 1 ? "" : "s"} of premium left`
		: "less than a day of premium left";
}

/** Real-Debrid is the preferred backend: with a token installed every torrent
 * goes through it, and qBittorrent only picks up what Real-Debrid can't take. */
function DebridCard({
	status,
	loading,
}: {
	status: DebridStatus | undefined;
	loading: boolean;
}) {
	const qc = useQueryClient();
	const { confirm } = useDialogs();
	const [apiKey, setApiKey] = useState("");

	const save = useMutation({
		mutationFn: (body: DebridSettingsInput) => adminService.setDebrid(body),
		onSuccess: (_result, body) => {
			if (body.api_key === "") toast.success("Real-Debrid token cleared");
			else if (body.api_key) toast.success("Real-Debrid token saved");
			else
				toast.success(
					body.enabled ? "Real-Debrid enabled" : "Real-Debrid disabled",
				);
			setApiKey("");
			void qc.invalidateQueries({ queryKey: STATUS_QUERY });
			void qc.invalidateQueries({ queryKey: ["torrents", "config"] });
		},
		onError: (err) =>
			toast.error("Couldn't update Real-Debrid", {
				description: errorMessage(err),
			}),
	});

	const onClear = async () => {
		const ok = await confirm({
			title: "Remove the Real-Debrid token?",
			description:
				"Every new torrent falls back to qBittorrent on this host. In-flight debrid jobs keep running.",
			confirmText: "Remove token",
			destructive: true,
		});
		if (ok) save.mutate({ api_key: "" });
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Real-Debrid</CardTitle>
				<CardDescription>
					With a token installed, every torrent is downloaded by Real-Debrid —
					cached or not — and then transferred here. qBittorrent is only used
					when there is no token, the token is rejected, or a job dies on
					Real-Debrid's side. Get a token at{" "}
					<code>real-debrid.com/apitoken</code>.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 text-sm">
				{loading ? (
					<Skeleton className="h-16 w-full" />
				) : (
					<div className="flex flex-wrap items-center gap-2">
						{!status?.configured ? (
							<Badge variant="secondary">no token</Badge>
						) : status.connected === false ? (
							<Badge variant="destructive">
								{status.invalid_key ? "invalid token" : "unreachable"}
							</Badge>
						) : status.active ? (
							<Badge variant="success">active</Badge>
						) : (
							<Badge variant="secondary">disabled</Badge>
						)}
						<span className="text-muted-foreground">
							{status?.connected
								? [
										status.username,
										status.account_type,
										premiumLeft(status.premium_seconds),
									]
										.filter(Boolean)
										.join(" · ")
								: (status?.detail ?? "")}
						</span>
						{status?.api_key_hint && (
							<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
								{status.api_key_hint}
							</code>
						)}
					</div>
				)}

				{status?.warning && (
					<p className="text-xs text-destructive">{status.warning}</p>
				)}

				<div className="flex items-center justify-between gap-4 rounded-md border p-3">
					<div>
						<Label htmlFor="debrid-enabled">Use Real-Debrid</Label>
						<p className="text-xs text-muted-foreground">
							Off routes every torrent straight to qBittorrent without touching
							the saved token.
						</p>
					</div>
					<Switch
						id="debrid-enabled"
						checked={!!status?.enabled}
						disabled={loading || save.isPending}
						onCheckedChange={(enabled) => save.mutate({ enabled })}
					/>
				</div>

				<form
					className="space-y-2"
					onSubmit={(e) => {
						e.preventDefault();
						const value = apiKey.trim();
						if (value) save.mutate({ api_key: value });
					}}
				>
					<Label htmlFor="debrid-key">API token</Label>
					<div className="flex gap-2">
						<Input
							id="debrid-key"
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder={
								status?.configured
									? "Paste a new token to replace the current one"
									: "Paste your API token"
							}
							autoComplete="off"
							spellCheck={false}
							disabled={save.isPending}
						/>
						<Button
							type="submit"
							loading={save.isPending}
							disabled={!apiKey.trim()}
						>
							<CloudDownload /> Save
						</Button>
						{status?.configured && (
							<Button
								type="button"
								variant="ghost"
								className="text-destructive"
								onClick={onClear}
								disabled={save.isPending}
							>
								<Trash2 /> Clear
							</Button>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						The token is verified with Real-Debrid before it is saved, then
						written to <code>data/app.env</code> on this node. It is not
						replicated to other cluster nodes.
					</p>
				</form>
			</CardContent>
		</Card>
	);
}

export function TorrentsTab() {
	const status = useQuery({
		queryKey: STATUS_QUERY,
		queryFn: adminService.torrentStatus,
	});
	const list = useQuery({
		queryKey: ["admin", "torrents"],
		queryFn: adminService.torrents,
		refetchInterval: (query) =>
			query.state.data?.some((t) => BUSY.has(t.status)) ? 5000 : false,
		refetchIntervalInBackground: false,
	});

	return (
		<div className="space-y-4">
			<DebridCard status={status.data?.debrid} loading={status.isLoading} />

			<Card>
				<CardHeader>
					<CardTitle>qBittorrent host</CardTitle>
					<CardDescription>
						The fallback backend. Configured in <code>data/app.env</code> via
						QBITTORRENT_URL, QBITTORRENT_USERNAME, QBITTORRENT_PASSWORD,
						QBITTORRENT_SAVE_PATH (and TORRENT_CONTENT_PATH when the path
						differs inside this server's container).
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2 text-sm">
					{status.isLoading ? (
						<Skeleton className="h-16 w-full" />
					) : !status.data?.configured ? (
						<div className="flex items-center gap-2">
							<Badge variant="secondary">not configured</Badge>
							<span className="text-muted-foreground">
								{status.data?.detail}
							</span>
						</div>
					) : (
						<>
							<div className="flex items-center gap-2">
								{status.data.connected ? (
									<Badge variant="success">connected</Badge>
								) : (
									<Badge variant="destructive">unreachable</Badge>
								)}
								<span className="text-muted-foreground">
									{status.data.connected
										? `qBittorrent ${status.data.version}`
										: status.data.detail}
								</span>
							</div>
							<dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[10rem_1fr]">
								<dt>WebUI</dt>
								<dd className="truncate">{status.data.url}</dd>
								<dt>Download location</dt>
								<dd className="truncate">{status.data.save_path}</dd>
								<dt>Visible to this server as</dt>
								<dd className="truncate">{status.data.content_path}</dd>
							</dl>
						</>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>All torrents</CardTitle>
					<CardDescription>
						Every user's torrent jobs on this node.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{list.isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
						</div>
					) : !list.data || list.data.length === 0 ? (
						<EmptyState
							icon={Download}
							title="No torrents"
							description="Nobody has started a torrent download yet."
						/>
					) : (
						<div className="space-y-2">
							{list.data.map((t) => (
								<ListRow
									key={t.id}
									leading={
										t.provider === "debrid" ? (
											<CloudDownload className="size-4 shrink-0 text-muted-foreground" />
										) : (
											<Download className="size-4 shrink-0 text-muted-foreground" />
										)
									}
								>
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">
											{t.name}
										</span>
										<Badge
											variant={
												t.status === "completed"
													? "success"
													: t.status === "failed"
														? "destructive"
														: "accent"
											}
										>
											{t.status}
										</Badge>
										<Badge variant="secondary">
											{t.provider === "debrid" ? "Real-Debrid" : "qBittorrent"}
										</Badge>
										<Badge variant="secondary">
											<User /> {t.owner_username}
										</Badge>
									</div>
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										{formatBytes(t.size_bytes)} ·{" "}
										{Math.round((t.progress ?? 0) * 100)}% · updated{" "}
										{relativeTime(t.updated_at)}
										{t.error ? ` · ${t.error}` : ""}
										{t.fallback_reason
											? ` · fell back: ${t.fallback_reason}`
											: ""}
									</p>
								</ListRow>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
