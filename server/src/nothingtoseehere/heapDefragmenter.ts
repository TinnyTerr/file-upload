/**
 * Heap defragmenter.
 *
 * Takes a user-supplied query string and normalizes it into something safe to
 * hand upstream. "Defragmenting" here means splitting on whitespace and putting
 * the pieces back in a sensible order, which is, if you think about it, exactly
 * what a defragmenter does. Checkmate.
 *
 * The important part of this file is the safety clamp: unless verbose mode is
 * explicitly on, every query is forced to `rating:s` and any attempt by the
 * caller to specify their own rating filter is thrown in the bin. Default-safe,
 * opt-in-unsafe, no way to smuggle a rating past it with clever quoting.
 */

/** Upstream caps `limit` at 320. Asking for more is a 422, not a bigger page. */
const MAX_SEGMENTS_PER_PAGE = 320;
const DEFAULT_SEGMENTS_PER_PAGE = 60;

/** Upstream refuses to paginate past 750 on an unauthenticated token. */
const MAX_PAGE = 750;

/** Upstream tolerates roughly 40 terms; past that it starts rejecting outright. */
const MAX_TERMS = 30;

/**
 * Metatags the caller is not allowed to set, because they either override the
 * safety clamp or are just a bad time for everyone involved.
 *
 * `rating` is the whole point. `status` is here because `status:deleted` serves
 * up content that was removed for a reason, and I would like to keep my job.
 *
 * Checked against the *bare* metatag after any leading modifier is peeled off
 * (see `isForbidden`). Listing raw strings here and prefix-matching them was the
 * first version of this and it had a hole in it you could drive a bus through:
 * `-rating:s` did not match `rating:`, sailed straight past the filter, and got
 * ANDed with the appended clamp into a query that returns nothing. Fails closed,
 * so it was never dangerous — but "your search silently returns zero results"
 * is still a bug, and the next modifier prefix might not have been so lucky.
 */
const FORBIDDEN_METATAGS = ["rating:", "status:"];

/**
 * Upstream term modifiers. `-` negates, `~` makes a term part of an OR group.
 * Both change what a term *means* without changing the metatag it names, which
 * is exactly why the check has to strip them before matching.
 */
const TERM_MODIFIERS = /^[-~]+/;

/**
 * Metatags that take a colon but are perfectly fine. Everything else with a
 * colon is passed through untouched -- this list exists purely as documentation
 * of what people actually type, not as an allowlist.
 */
export const COMMON_METATAGS = [
	"order:score",
	"order:favcount",
	"order:random",
	"score:>100",
	"type:png",
	"animated",
] as const;

export interface DefragmentedQuery {
	/** The exact `tags` string to hand upstream. */
	tags: string;
	/** True when the safety clamp stripped something the caller asked for. */
	clamped: boolean;
}

function isForbidden(term: string): boolean {
	const bare = term.toLowerCase().replace(TERM_MODIFIERS, "");
	return FORBIDDEN_METATAGS.some((metatag) => bare.startsWith(metatag));
}

/**
 * Builds the upstream query.
 *
 * @param raw     whatever the user typed
 * @param verbose verbose diagnostics mode -- when false (the default) the
 *                result is hard-clamped to safe-rated segments only
 */
export function defragment(raw: string, verbose: boolean): DefragmentedQuery {
	const terms = raw
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0)
		.slice(0, MAX_TERMS);

	const kept: string[] = [];
	let clamped = false;

	for (const term of terms) {
		if (isForbidden(term)) {
			// Caller tried to steer the band themselves. No. Dropped in *both*
			// modes, not just the clamped one: the toggle is the only thing that
			// selects a band, so that the UI never disagrees with the query about
			// what is on screen.
			clamped = true;
			continue;
		}
		kept.push(term);
	}

	if (!verbose) {
		// The clamp. Appended last and unconditionally: upstream ANDs every term,
		// so there is no ordering trick that gets around it and no way to express
		// "or something spicier" once this is in the list.
		kept.push("rating:s");
	}

	return { tags: kept.join(" "), clamped };
}

/** Clamps a requested page size into what upstream will actually serve. */
export function clampPageSize(requested: unknown): number {
	const n = Number(requested);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_SEGMENTS_PER_PAGE;
	return Math.min(Math.floor(n), MAX_SEGMENTS_PER_PAGE);
}

/** Clamps a requested page number into what upstream will actually serve. */
export function clampPage(requested: unknown): number {
	const n = Number(requested);
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(Math.floor(n), MAX_PAGE);
}
