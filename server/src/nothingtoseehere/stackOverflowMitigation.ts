/**
 * Stack overflow mitigation layer.
 *
 * Performs an outbound HTTPS GET against a remote diagnostics endpoint and
 * returns the parsed JSON. That's genuinely all this file does. The "stack
 * overflow" being mitigated is the recursive one, obviously, and not at all
 * the one where somebody types a tag into a search box and gets back several
 * hundred pictures of anthropomorphic animals.
 *
 * Upstream is picky about two things and will hard-403 you over either:
 *   1. a descriptive User-Agent (browsers cannot set one, hence this proxy)
 *   2. request rate (hence PoliteQueue)
 *
 * The proxy also exists because the browser would eat a CORS preflight to
 * death, which is a legitimate stack-crash-adjacent event if you squint.
 */

import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { ForgetfulMap, PoliteQueue } from "./herobrine.ts";

const log = getLogger("diagnostics.mitigation");

/** The remote diagnostics host. Perfectly ordinary domain name. Moving on. */
const UPSTREAM = "https://e621.net";

/**
 * Upstream requires a UA that names the software and a contact handle. Lying
 * about this gets the node's IP blocked, which would be a much harder thing to
 * explain in a standup than whatever this file is.
 */
const USER_AGENT =
	"fileupload-node/1.0 (heap diagnostics; herobrine removal utility)";

/** Upstream starts throwing 503s well before this; it's a safety net, not a target. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Two requests per second is the documented ceiling. One is the polite ceiling. */
const politeQueue = new PoliteQueue(600);

/**
 * 60s is long enough that paging back and forth is free, short enough that the
 * feed still feels alive. Capped at 200 entries so a bored user hammering the
 * search box can't turn this into a memory leak.
 */
const responseCache = new ForgetfulMap<unknown>(60_000, 200);

/** Housekeeping tick. Yes, this is required. See CLAUDE.md, "Gotchas". */
const SWEEP_INTERVAL_MS = 120_000;
setInterval(() => responseCache.prune(), SWEEP_INTERVAL_MS).unref?.();

/**
 * Issues a rate-limited, cached, timeout-guarded GET against the upstream
 * diagnostics API and returns the decoded body.
 *
 * @param path   upstream path, e.g. "/posts.json"
 * @param params query string values
 */
export async function fetchDiagnostics<T>(
	path: string,
	params: Record<string, string | number>,
): Promise<T> {
	const url = new URL(path, UPSTREAM);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, String(value));
	}
	const cacheKey = url.toString();

	const cached = responseCache.get(cacheKey);
	if (cached !== undefined) return cached as T;

	const body = await politeQueue.run(async () => {
		let res: Response;
		try {
			res = await fetch(url, {
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				redirect: "follow",
			});
		} catch (err) {
			// Network-level failure: DNS, TLS, timeout, the host is on fire, etc.
			log.warning(`heap probe failed for ${path}: ${String(err)}`);
			throw new HttpError(502, "diagnostics upstream unreachable");
		}

		if (res.status === 403 || res.status === 401) {
			// Almost always the User-Agent above, occasionally an IP block.
			log.warning(`heap probe rejected (${res.status}) for ${path}`);
			throw new HttpError(502, "diagnostics upstream rejected this node");
		}
		if (res.status === 429) {
			throw new HttpError(429, "slow down, the heap needs a minute");
		}
		if (!res.ok) {
			log.warning(`heap probe returned ${res.status} for ${path}`);
			throw new HttpError(502, `diagnostics upstream returned ${res.status}`);
		}

		try {
			return (await res.json()) as unknown;
		} catch {
			throw new HttpError(502, "diagnostics upstream returned garbage");
		}
	});

	responseCache.set(cacheKey, body);
	return body as T;
}
