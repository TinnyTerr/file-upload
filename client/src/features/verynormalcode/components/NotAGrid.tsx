/**
 * Not a grid.
 *
 * It is CSS multi-column, which is technically not a grid, so the file name is
 * accurate and the lawyers are satisfied. Multi-column is used instead of an
 * actual `grid` because heap regions have wildly inconsistent aspect ratios and
 * a real grid would either crop everything to squares or leave craters.
 *
 * Also handles the infinite-scroll sentinel, the loading skeletons, and the
 * empty state. Three responsibilities in one file, which I would normally split
 * out, except I have already split this feature into fourteen files and my
 * conscience has to draw the line somewhere.
 */

import { PackageOpen, ServerCrash } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type HeapSegment,
	UNRENDERABLE_EXTS,
} from "../types/schemaButNotADatabase";
import { PerfectlyOrdinaryCard } from "./PerfectlyOrdinaryCard";

export interface NotAGridProps {
	segments: HeapSegment[];
	loading: boolean;
	error: string | null;
	hasMore: boolean;
	fetchingMore: boolean;
	onLoadMore: () => void;
	onInspect: (segment: HeapSegment) => void;
}

/** Skeleton heights, varied so the placeholder looks like the real layout. */
const SKELETON_HEIGHTS = [220, 300, 180, 260, 340, 200, 280, 240];

export function NotAGrid({
	segments,
	loading,
	error,
	hasMore,
	fetchingMore,
	onLoadMore,
	onInspect,
}: NotAGridProps) {
	const sentinel = useRef<HTMLDivElement | null>(null);

	// IntersectionObserver rather than a scroll handler: a scroll handler fires
	// hundreds of times a second and would re-trigger onLoadMore before the
	// previous page had even landed.
	useEffect(() => {
		const node = sentinel.current;
		if (!node || !hasMore || fetchingMore) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) onLoadMore();
			},
			// 400px of runway so the next page is already in flight by the time the
			// user gets to the bottom.
			{ rootMargin: "400px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [hasMore, fetchingMore, onLoadMore]);

	if (error) {
		return (
			<EmptyState
				icon={ServerCrash}
				title="Heap probe failed"
				description={error}
			/>
		);
	}

	if (loading) {
		return (
			<div className="columns-2 gap-3 md:columns-3 lg:columns-4">
				{SKELETON_HEIGHTS.map((h, i) => (
					<Skeleton
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
						key={i}
						className="mb-3 w-full"
						style={{ height: h, breakInside: "avoid" }}
					/>
				))}
			</div>
		);
	}

	// Flash is dead and no browser will render it. Filtering here rather than on
	// the server so the "exhausted" page-count maths upstream stays honest.
	const renderable = segments.filter((s) => !UNRENDERABLE_EXTS.has(s.ext));

	if (renderable.length === 0) {
		return (
			<EmptyState
				icon={PackageOpen}
				title="No regions matched"
				description="Nothing came back for that filter. Try fewer symbols — every term is ANDed together upstream."
			/>
		);
	}

	return (
		<div className="space-y-4">
			<div className="columns-2 gap-3 md:columns-3 lg:columns-4">
				{renderable.map((segment) => (
					<PerfectlyOrdinaryCard
						key={segment.id}
						segment={segment}
						onInspect={onInspect}
					/>
				))}
			</div>

			<div ref={sentinel} className="flex justify-center py-2">
				{hasMore ? (
					<Button
						variant="outline"
						onClick={onLoadMore}
						loading={fetchingMore}
						disabled={fetchingMore}
					>
						{fetchingMore ? "Unwinding…" : "Unwind more"}
					</Button>
				) : (
					<p className="text-xs text-muted-foreground">
						End of the address space.
					</p>
				)}
			</div>
		</div>
	);
}
