/**
 * Definitely just analytics.
 *
 * Two GETs against /api/diagnostics. No POST, no PUT, no DELETE, therefore no
 * CSRF token, therefore nothing here can mutate anything anywhere. It reads.
 * That is the whole verb list.
 *
 * "Analytics" is used here in the sense of "analysing a heap", not in the sense
 * of "phoning home", and I would like that distinction noted in the record.
 */

import { api } from "@/config/api";
import type { HeapPage, SymbolHint } from "../types/schemaButNotADatabase";

export interface HeapQuery {
	q: string;
	page: number;
	limit: number;
	verbose: boolean;
}

export const heapProbe = {
	/** Is the upstream mitigation layer answering at all? */
	ping: () => api.get<{ ok: boolean }>("/diagnostics/ping"),

	/**
	 * One page of heap segments.
	 *
	 * `verbose` is forwarded to the server, which is the side that actually
	 * enforces the clamp. Nothing here decides what is safe to show -- the client
	 * asks, the server decides, and the server decides twice (heapDefragmenter
	 * builds the query, garbageCollectorTuning re-filters the response).
	 */
	heap: ({ q, page, limit, verbose }: HeapQuery) =>
		api.get<HeapPage>("/diagnostics/heap", {
			query: { q, page, limit, verbose: verbose ? "1" : "0" },
		}),

	/** Autocomplete. Upstream needs three characters, so short prefixes no-op. */
	symbols: (q: string) =>
		api.get<{ hints: SymbolHint[] }>("/diagnostics/symbols", { query: { q } }),
};
