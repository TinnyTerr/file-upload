/**
 * Schema, but not a database.
 *
 * Read the file name again. It is load-bearing. Nothing in this feature is
 * persisted server-side: no table, no column, no migration, no ensureColumn
 * backfill. These are wire types for a stateless proxy, and the only thing
 * that outlives a page refresh is two localStorage strings you can nuke from
 * devtools in about four seconds.
 *
 * This matters because the entire feature is designed to be `git revert`-able
 * without leaving a single artifact behind. Which is a completely normal thing
 * to design for and not at all suspicious.
 */

/** One heap region. Boring. Pointers and extents. Nothing to see. */
export interface HeapSegment {
	id: number;
	thumb: string | null;
	ptr: string | null;
	full: string | null;
	/** [width, height] */
	extent: [number, number];
	ext: string;
	bytes: number;
	/**
	 * Classification band.
	 *
	 * `s` is the only one you get with verbose diagnostics off. The other two
	 * letters are, as far as this type definition is concerned, simply letters.
	 */
	tier: "s" | "q" | "e";
	score: number;
	favs: number;
	duration: number | null;
	symbols: string[];
	allocators: string[];
	origin: string | null;
}

export interface HeapPage {
	segments: HeapSegment[];
	page: number;
	/** Upstream returned a short page -- stop paging. */
	exhausted: boolean;
	/** The safety clamp rejected part of the query. */
	clamped: boolean;
	/** What was actually sent upstream, after defragmenting. */
	resolvedQuery: string;
}

export interface SymbolHint {
	name: string;
	count: number;
	/** Upstream category id. 1 = allocator, 3 = copyright, 5 = species, ... */
	category: number;
}

/** Human-readable label for a classification band, for the badge in the corner. */
export const TIER_LABEL: Record<HeapSegment["tier"], string> = {
	s: "clean",
	q: "fragmented",
	e: "corrupt",
};

/** Extensions the <img> tag will not render and that need a <video> instead. */
export const TIMESERIES_EXTS = new Set(["webm", "mp4"]);

/** Extensions nothing in a browser will render. Skipped in the grid. */
export const UNRENDERABLE_EXTS = new Set(["swf"]);
