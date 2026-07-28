import {
	Boxes,
	Files,
	Gauge,
	Globe,
	HardDrive,
	Inbox,
	KeyRound,
	Layers,
	Link,
	Link2,
	Scale,
	Sparkles,
	Users2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes, percent } from "@/lib/bytes";
import type { StorageDetails } from "../types";

interface Tile {
	icon: typeof Files;
	label: string;
	value: string;
	hint: string;
	accent?: boolean;
}

/** A dense grid of headline + derived metrics computed from /admin/storage. */
export function StatsGrid({ data }: { data: StorageDetails }) {
	const avgFile = data.total_files > 0 ? data.used_bytes / data.total_files : 0;
	const totalSaved =
		data.fun_stats.dedup_saved_bytes + data.fun_stats.archive_saved_bytes;
	const linksPerFile =
		data.total_files > 0 ? data.total_links / data.total_files : 0;
	const activeLinkPct =
		data.total_links > 0 ? percent(data.active_links, data.total_links) : 0;
	const diskFreePct =
		data.disk.total_bytes > 0
			? percent(data.disk.free_bytes, data.disk.total_bytes)
			: 0;
	const savedVsStored =
		data.used_bytes > 0
			? (totalSaved / (data.used_bytes + totalSaved)) * 100
			: 0;

	const tiles: Tile[] = [
		{
			icon: Files,
			label: "Total files",
			value: data.total_files.toLocaleString(),
			hint: "Files across every user.",
		},
		{
			icon: HardDrive,
			label: "Stored",
			value: formatBytes(data.used_bytes),
			hint: "Total bytes used under the cap.",
		},
		{
			icon: Scale,
			label: "Avg file size",
			value: formatBytes(avgFile),
			hint: "Mean logical file size.",
		},
		{
			icon: Link2,
			label: "Total links",
			value: data.total_links.toLocaleString(),
			hint: "Every share link ever minted.",
		},
		{
			icon: Link,
			label: "Active links",
			value: `${data.active_links} · ${activeLinkPct.toFixed(0)}%`,
			hint: "Links currently usable.",
		},
		{
			icon: Layers,
			label: "Links / file",
			value: linksPerFile.toFixed(2),
			hint: "Average links per file.",
		},
		{
			icon: KeyRound,
			label: "API keys",
			value: data.total_api_keys.toLocaleString(),
			hint: "Current API keys.",
		},
		{
			icon: Users2,
			label: "Collaborators",
			value: data.fun_stats.collaborator_count.toLocaleString(),
			hint: "Folder collaborator grants.",
		},
		{
			icon: Sparkles,
			label: "Space saved",
			value: formatBytes(totalSaved),
			hint: "Dedup + archive savings combined.",
			accent: true,
		},
		{
			icon: Boxes,
			label: "Saved ratio",
			value: `${savedVsStored.toFixed(1)}%`,
			hint: "Saved vs what it would have stored.",
			accent: true,
		},
		{
			icon: Gauge,
			label: "Disk free",
			value: `${formatBytes(data.disk.free_bytes)} · ${diskFreePct.toFixed(0)}%`,
			hint: "Free space on the storage volume.",
		},
		{
			icon: Globe,
			label: "Remote pulls",
			value: data.fun_stats.remote_upload_count.toLocaleString(),
			hint: "Files fetched from remote URLs.",
		},
		{
			icon: Inbox,
			label: "Dropbox in",
			value: data.fun_stats.dropbox_upload_count.toLocaleString(),
			hint: "Files received via receive links.",
		},
	];

	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{tiles.map((t) => (
				<Tooltip key={t.label} content={t.hint}>
					<Card className="transition-colors hover:border-primary/40">
						<CardContent className="flex items-center gap-3 p-3.5">
							<div
								className={
									"flex size-9 shrink-0 items-center justify-center rounded-lg " +
									(t.accent
										? "bg-brand-gradient text-primary-foreground"
										: "bg-secondary/50 text-primary")
								}
							>
								<t.icon className="size-[18px]" />
							</div>
							<div className="min-w-0">
								<div className="truncate text-base font-bold leading-tight">
									{t.value}
								</div>
								<div className="truncate text-[11px] text-muted-foreground">
									{t.label}
								</div>
							</div>
						</CardContent>
					</Card>
				</Tooltip>
			))}
		</div>
	);
}
