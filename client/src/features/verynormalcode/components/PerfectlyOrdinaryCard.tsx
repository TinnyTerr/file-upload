/**
 * Perfectly ordinary card.
 *
 * Renders one heap region: an image, a size, a band badge, and the allocator
 * that produced it. Nothing about this component is unusual. It is a card. It
 * has rounded corners. Its most exotic feature is `loading="lazy"`.
 *
 * Two real notes hiding in the comedy:
 *
 *   1. `referrerPolicy="no-referrer"` on every asset. The app already sends
 *      Referrer-Policy: no-referrer as a global header (securityHeaders.ts) but
 *      belt and braces -- upstream should never learn which deployment is
 *      pointing at it, and neither should anything in between.
 *   2. Time-series regions render as a muted, looping <video>. Muted is not
 *      cosmetic. An unmuted autoplay in an office is a career event.
 */

import { AlertTriangle, Film, ImageOff } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/cn";
import {
	type HeapSegment,
	TIER_LABEL,
	TIMESERIES_EXTS,
} from "../types/schemaButNotADatabase";

const TIER_VARIANT: Record<HeapSegment["tier"], "success" | "warning" | "destructive"> =
	{
		s: "success",
		q: "warning",
		e: "destructive",
	};

export function PerfectlyOrdinaryCard({
	segment,
	onInspect,
}: {
	segment: HeapSegment;
	onInspect: (segment: HeapSegment) => void;
}) {
	const [broken, setBroken] = useState(false);
	const isTimeSeries = TIMESERIES_EXTS.has(segment.ext);
	const [width, height] = segment.extent;

	// Reserve the right box before the asset lands. Without an aspect ratio the
	// masonry columns reflow every time an image decodes, which looks like the
	// page is having a seizure and is the single most common complaint about
	// grids like this one.
	const ratio = width > 0 && height > 0 ? width / height : 1;

	return (
		<button
			type="button"
			onClick={() => onInspect(segment)}
			className={cn(
				"group relative mb-3 block w-full overflow-hidden rounded-xl border border-border/70 bg-secondary/30 text-left",
				"transition-all duration-150 hover:border-primary/40 hover:shadow-lg hover:shadow-black/30",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			)}
			style={{ breakInside: "avoid" }}
		>
			<div className="relative w-full" style={{ aspectRatio: ratio }}>
				{broken || !segment.ptr ? (
					<div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
						<ImageOff className="size-6" />
						<span className="text-xs">region unmapped</span>
					</div>
				) : isTimeSeries ? (
					<video
						src={segment.ptr}
						poster={segment.thumb ?? undefined}
						muted
						loop
						playsInline
						preload="none"
						// No referrerPolicy here: <video> has no such attribute. Video
						// requests fall back to the global Referrer-Policy: no-referrer
						// header from securityHeaders.ts, which covers it anyway.
						onError={() => setBroken(true)}
						onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
						onMouseLeave={(e) => {
							e.currentTarget.pause();
							e.currentTarget.currentTime = 0;
						}}
						className="size-full object-cover"
					/>
				) : (
					<img
						src={segment.ptr}
						alt={segment.symbols.slice(0, 4).join(", ") || "heap region"}
						loading="lazy"
						decoding="async"
						referrerPolicy="no-referrer"
						onError={() => setBroken(true)}
						className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
					/>
				)}

				{/* Band badge, always visible. If a card is off-band the user should
				    not have to hover to find that out. */}
				<div className="absolute left-2 top-2 flex items-center gap-1">
					<Badge variant={TIER_VARIANT[segment.tier]} className="backdrop-blur">
						{segment.tier !== "s" && <AlertTriangle className="size-3" />}
						{TIER_LABEL[segment.tier]}
					</Badge>
					{isTimeSeries && (
						<Badge variant="secondary" className="backdrop-blur">
							<Film className="size-3" />
							{segment.duration ? `${Math.round(segment.duration)}s` : "clip"}
						</Badge>
					)}
				</div>
			</div>

			{/* Footer only materializes on hover so the grid stays a grid. */}
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/85 to-transparent p-2.5",
					"transition-transform duration-150 group-hover:translate-y-0",
				)}
			>
				<p className="truncate text-xs font-medium text-white">
					{segment.allocators.join(", ") || "unattributed"}
				</p>
				<p className="truncate text-[11px] text-white/60">
					{width}×{height} · {segment.ext} · {formatBytes(segment.bytes)} ·{" "}
					{segment.score >= 0 ? "+" : ""}
					{segment.score}
				</p>
			</div>
		</button>
	);
}
