import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronDown } from "lucide-react";
import { useState } from "react";
import { api } from "@/config/api";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/time";

type Kind = "file" | "dir";

interface Stats {
	days: number;
	totals: { view: number; download: number; save: number };
	last_event_at: string | null;
	series: { day: string; view: number; download: number; save: number }[];
	countries: { country: string | null; count: number }[];
}

const DAYS = 30;

/** "XX"/"T1" are Cloudflare's own codes, not ISO ones -- spelled out. */
function countryLabel(c: string | null): string {
	if (c === null || c === "XX") return "Unknown";
	if (c === "T1") return "Tor";
	try {
		return new Intl.DisplayNames(undefined, { type: "region" }).of(c) ?? c;
	} catch {
		return c;
	}
}

/** A collapsed "Stats" row under a share link; fetches only once opened. */
export function LinkStats({ kind, linkId }: { kind: Kind; linkId: number }) {
	const [open, setOpen] = useState(false);
	const { data, isLoading, isError } = useQuery({
		queryKey: ["link-stats", kind, linkId, DAYS],
		queryFn: () => api.get<Stats>(`/link-stats/${kind}/${linkId}?days=${DAYS}`),
		enabled: open,
		staleTime: 30_000,
	});

	return (
		<div className="mt-1.5 border-t border-border/60 pt-1.5">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
			>
				<BarChart3 className="size-3" /> Stats
				<ChevronDown
					className={cn("size-3 transition-transform", open && "rotate-180")}
				/>
			</button>
			{open && (
				<div className="mt-2 space-y-2 text-xs">
					{isLoading && <p className="text-muted-foreground">Loading…</p>}
					{isError && <p className="text-destructive">Couldn’t load stats.</p>}
					{data && <StatsBody stats={data} />}
				</div>
			)}
		</div>
	);
}

function StatsBody({ stats }: { stats: Stats }) {
	const max = Math.max(1, ...stats.series.map((d) => d.view + d.download));
	const last = stats.last_event_at;
	return (
		<>
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				<span>
					<b className="tabular-nums">{stats.totals.view}</b> views
				</span>
				<span>
					<b className="tabular-nums">{stats.totals.download}</b> downloads
				</span>
				{stats.totals.save > 0 && (
					<span>
						<b className="tabular-nums">{stats.totals.save}</b> saves
					</span>
				)}
				<span className="text-muted-foreground">
					last {stats.days} days
					{last ? ` · last used ${formatDateTime(last)}` : ""}
				</span>
			</div>
			<div
				className="flex h-10 items-end gap-px"
				role="img"
				aria-label={`Views and downloads per day over the last ${stats.days} days`}
			>
				{stats.series.map((d) => {
					const total = d.view + d.download;
					return (
						<div
							key={d.day}
							title={`${d.day}: ${d.view} views, ${d.download} downloads`}
							className="flex flex-1 flex-col justify-end"
							style={{ height: "100%" }}
						>
							<div
								className="bg-primary"
								style={{ height: `${(d.download / max) * 100}%` }}
							/>
							<div
								className="bg-primary/30"
								style={{ height: `${(d.view / max) * 100}%` }}
							/>
							{total === 0 && <div className="h-px bg-border" />}
						</div>
					);
				})}
			</div>
			<p className="flex gap-3 text-[11px] text-muted-foreground">
				<span className="flex items-center gap-1">
					<i className="size-2 bg-primary" /> downloads
				</span>
				<span className="flex items-center gap-1">
					<i className="size-2 bg-primary/30" /> views
				</span>
			</p>
			{stats.countries.length > 0 && (
				<ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
					{stats.countries.map((c) => (
						<li key={c.country ?? "unknown"}>
							{countryLabel(c.country)}{" "}
							<b className="tabular-nums text-foreground">{c.count}</b>
						</li>
					))}
				</ul>
			)}
		</>
	);
}
