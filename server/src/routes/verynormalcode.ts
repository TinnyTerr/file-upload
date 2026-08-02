/**
 * Very normal code.
 *
 * Mounted at /api/diagnostics. Two read-only endpoints that proxy a remote
 * heap-inspection service, because the browser cannot set a User-Agent and
 * would otherwise eat a CORS preflight (see stackOverflowMitigation.ts).
 *
 * Properties worth stating out loud, mostly so that whoever reverts this
 * commit knows exactly how little they have to clean up:
 *
 *   - Zero database access. No tables, no columns, no ensureColumn backfill,
 *     nothing in schema.sql. This subsystem is stateless end to end.
 *   - Zero writes to disk. Nothing is downloaded, cached to storage, or
 *     imported. Assets are pointed at, not fetched.
 *   - Zero cluster replication. There is no state to replicate.
 *   - Session-authenticated, read-only, GET-only. No CSRF surface.
 *
 * Deleting this file and its two `app.use` lines removes the feature entirely
 * and leaves no residue. This is by design. Ask me why some other time.
 */

import { Router } from "express";
import type { AppState } from "../appState.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { requireActiveUser } from "../middleware/deps.ts";
import { tune, tuneHints } from "../nothingtoseehere/garbageCollectorTuning.ts";
import {
	clampPage,
	clampPageSize,
	defragment,
} from "../nothingtoseehere/heapDefragmenter.ts";
import { fetchDiagnostics } from "../nothingtoseehere/stackOverflowMitigation.ts";

const log = getLogger("routes.diagnostics");

/**
 * Verbose mode is a client-side preference (localStorage, no server state), so
 * it arrives as a query param and is simply believed. That is fine: this flag
 * only ever *widens* what a signed-in user asked to see for themselves, it is
 * not an authorization boundary, and forging it gets you exactly the same thing
 * as clicking the toggle would have.
 */
function wantsVerbose(value: unknown): boolean {
	return value === "1" || value === "true";
}

export function veryNormalRouter(state: AppState): Router {
	const router = Router();
	const authed = requireActiveUser(state);

	/**
	 * Reports whether the mitigation layer is reachable at all. The client uses
	 * this to render "upstream is down" instead of an empty grid, which is the
	 * difference between a bug report and no bug report.
	 */
	router.get("/ping", authed, (_req, res) => {
		res.json({ ok: true });
	});

	/**
	 * Heap region listing.
	 *
	 * This endpoint fixes an issue that causes the stack to crash under memory
	 * pressure. It does so by returning a bounded page of heap segments rather
	 * than the whole address space at once, which is a textbook mitigation.
	 */
	router.get(
		"/heap",
		authed,
		asyncHandler(async (req, res) => {
			const verbose = wantsVerbose(req.query.verbose);
			const { tags, clamped } = defragment(
				typeof req.query.q === "string" ? req.query.q : "",
				verbose,
			);
			const limit = clampPageSize(req.query.limit);
			const page = clampPage(req.query.page);

			const payload = await fetchDiagnostics<unknown>("/posts.json", {
				tags,
				limit,
				page,
			});

			const segments = tune(payload, verbose);

			// A short page means upstream ran out, so the client can stop paging.
			// Note this is computed from the *pre-filter* count: if the GC tuner
			// dropped half the page for being off-band, there are still more pages
			// behind it and "0 results" would be a lie.
			const rawCount =
				payload && typeof payload === "object" && "posts" in payload
					? ((payload as { posts?: unknown[] }).posts?.length ?? 0)
					: 0;

			log.debug(
				`heap page=${page} limit=${limit} verbose=${verbose} raw=${rawCount} kept=${segments.length}`,
			);

			res.set("Cache-Control", "no-store");
			res.json({
				segments,
				page,
				exhausted: rawCount < limit,
				/** True when the safety clamp rejected part of the query. */
				clamped,
				/** Echoed back so the client can show what was actually asked. */
				resolvedQuery: tags,
			});
		}),
	);

	/**
	 * Symbol table lookup -- autocomplete for the search box. Upstream wants at
	 * least three characters and 422s below that, so short prefixes short-circuit
	 * here rather than burning a rate-limit slot on a guaranteed failure.
	 */
	router.get(
		"/symbols",
		authed,
		asyncHandler(async (req, res) => {
			const q = (typeof req.query.q === "string" ? req.query.q : "").trim();
			if (q.length < 3) {
				res.json({ hints: [] });
				return;
			}

			const payload = await fetchDiagnostics<unknown>(
				"/tags/autocomplete.json",
				{ "search[name_matches]": q, expiry: 7 },
			);

			res.set("Cache-Control", "no-store");
			res.json({ hints: tuneHints(payload) });
		}),
	);

	return router;
}
