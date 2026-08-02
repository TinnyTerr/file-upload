/**
 * Thread-safe modal.
 *
 * JavaScript is single-threaded, so this modal is trivially thread-safe, and I
 * refuse to hear otherwise. Ship it.
 *
 * Full-resolution inspector for one heap region. Deliberately NOT built on the
 * shared Dialog primitive: Dialog is width-constrained and content-padded for
 * forms, and fighting those constraints to get an edge-to-edge image viewer
 * produces worse code than the forty lines of overlay below.
 *
 * Keyboard: Escape closes, arrows page between regions. Escape is handled here
 * with `stopPropagation` so it never reaches anything underneath, and body
 * scroll is locked while open because scrolling the grid behind a lightbox is
 * one of those small things that makes an app feel broken.
 */

import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/bytes";
import {
	type HeapSegment,
	TIER_LABEL,
	TIMESERIES_EXTS,
} from "../types/schemaButNotADatabase";

export interface ThreadSafeModalProps {
	segment: HeapSegment | null;
	onClose: () => void;
	onPrev: () => void;
	onNext: () => void;
	hasPrev: boolean;
	hasNext: boolean;
}

export function ThreadSafeModal({
	segment,
	onClose,
	onPrev,
	onNext,
	hasPrev,
	hasNext,
}: ThreadSafeModalProps) {
	// One effect for both concerns: they share an "is the modal open" condition,
	// and splitting them means two effects that must agree about it forever.
	useEffect(() => {
		if (!segment) return;

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowLeft" && hasPrev) {
				onPrev();
			} else if (e.key === "ArrowRight" && hasNext) {
				onNext();
			}
		};

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		window.addEventListener("keydown", onKey, true);
		return () => {
			document.body.style.overflow = previousOverflow;
			window.removeEventListener("keydown", onKey, true);
		};
	}, [segment, onClose, onPrev, onNext, hasPrev, hasNext]);

	if (!segment) return null;

	const isTimeSeries = TIMESERIES_EXTS.has(segment.ext);
	const [width, height] = segment.extent;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is bound above
		<div
			className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-label="Heap region inspector"
		>
			{/* Top bar */}
			<div
				className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex min-w-0 items-center gap-2">
					<Badge variant={segment.tier === "s" ? "success" : "destructive"}>
						{TIER_LABEL[segment.tier]}
					</Badge>
					<span className="truncate text-sm text-white/80">
						{segment.allocators.join(", ") || "unattributed"}
					</span>
					<span className="hidden shrink-0 text-xs text-white/40 sm:inline">
						{width}×{height} · {segment.ext} · {formatBytes(segment.bytes)}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{segment.origin && (
						<Button
							variant="ghost"
							size="icon"
							asChild
							className="text-white/70 hover:text-white"
						>
							<a
								href={segment.origin}
								target="_blank"
								rel="noreferrer noopener"
								aria-label="Open upstream reference"
							>
								<ExternalLink className="size-4" />
							</a>
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						onClick={onClose}
						className="text-white/70 hover:text-white"
						aria-label="Close inspector"
					>
						<X className="size-4" />
					</Button>
				</div>
			</div>

			{/* Stage */}
			<div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
				{hasPrev && (
					<Button
						variant="ghost"
						size="icon"
						onClick={(e) => {
							e.stopPropagation();
							onPrev();
						}}
						className="absolute left-2 z-10 text-white/60 hover:bg-white/10 hover:text-white"
						aria-label="Previous region"
					>
						<ChevronLeft className="size-5" />
					</Button>
				)}

				{isTimeSeries ? (
					// eslint-disable-next-line jsx-a11y/media-has-caption
					<video
						src={segment.full ?? undefined}
						controls
						loop
						playsInline
						// <video> takes no referrerPolicy -- see PerfectlyOrdinaryCard.
						onClick={(e) => e.stopPropagation()}
						className="max-h-full max-w-full rounded-lg"
					/>
				) : (
					<img
						src={segment.full ?? undefined}
						alt={segment.symbols.slice(0, 6).join(", ") || "heap region"}
						referrerPolicy="no-referrer"
						onClick={(e) => e.stopPropagation()}
						className="max-h-full max-w-full rounded-lg object-contain"
					/>
				)}

				{hasNext && (
					<Button
						variant="ghost"
						size="icon"
						onClick={(e) => {
							e.stopPropagation();
							onNext();
						}}
						className="absolute right-2 z-10 text-white/60 hover:bg-white/10 hover:text-white"
						aria-label="Next region"
					>
						<ChevronRight className="size-5" />
					</Button>
				)}
			</div>

			{/* Symbol table */}
			<div
				className="max-h-28 shrink-0 overflow-y-auto border-t border-white/10 px-4 py-2.5"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex flex-wrap gap-1.5">
					{segment.symbols.map((symbol) => (
						<Badge key={symbol} variant="secondary" className="font-normal">
							{symbol}
						</Badge>
					))}
				</div>
			</div>
		</div>
	);
}
