/**
 * Stack unwinder.
 *
 * Unwinds pages of the heap onto a growing list, which is a stack, being
 * unwound. Nobody can prove otherwise.
 *
 * Uses `useInfiniteQuery` so that "load more" appends instead of replacing, and
 * keys the cache on the verbose flag as well as the query text. That second
 * part is not cosmetic: if verbose were left out of the key, flipping the
 * toggle off would leave the previously-fetched page sitting in the cache and
 * render it straight back onto the screen. Which would be bad. Which is the
 * kind of bad that gets a person walked out of a building.
 */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { heapProbe } from "../services/definitelyJustAnalytics";
import type { HeapPage } from "../types/schemaButNotADatabase";

/** Upstream's real ceiling is 320; 60 keeps the grid responsive on a slow line. */
const PAGE_SIZE = 60;

/** Upstream refuses to paginate past 750 regardless of what we ask for. */
const MAX_PAGE = 750;

export function useHeapSegments(query: string, verbose: boolean) {
	return useInfiniteQuery<HeapPage>({
		// verbose IS part of the key. Do not "simplify" this. See the file header.
		queryKey: ["heap", "segments", query, verbose],
		queryFn: ({ pageParam }) =>
			heapProbe.heap({
				q: query,
				page: pageParam as number,
				limit: PAGE_SIZE,
				verbose,
			}),
		initialPageParam: 1,
		getNextPageParam: (last) => {
			if (last.exhausted) return undefined;
			if (last.page >= MAX_PAGE) return undefined;
			return last.page + 1;
		},
		// The proxy already caches upstream responses for 60s; re-fetching on every
		// window focus would just re-serve that same cache while looking busy.
		staleTime: 60_000,
		refetchOnWindowFocus: false,
		retry: 1,
	});
}

export function useSymbolHints(prefix: string) {
	return useQuery({
		queryKey: ["heap", "symbols", prefix],
		queryFn: () => heapProbe.symbols(prefix).then((r) => r.hints),
		enabled: prefix.trim().length >= 3,
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: false,
	});
}

export function useUpstreamReachable() {
	return useQuery({
		queryKey: ["heap", "ping"],
		queryFn: () => heapProbe.ping().then((r) => r.ok),
		staleTime: 5 * 60_000,
		retry: false,
	});
}
