/** Fixed-window rate limiting for bearer-credentialed requests (API keys,
 * OAuth access tokens). Session-cookie browser traffic isn't limited here --
 * it's already bounded by security/lockout.ts on the login path, and a
 * signed-in tab isn't the "someone is hammering the API" case this guards.
 *
 * One process-wide in-memory map, like the other node-local registries
 * (loginChallenges, secondFactorTickets) -- swept on an interval so it can't
 * grow forever (see CLAUDE.md: "Don't add unbounded in-memory maps without a
 * sweep"). Node-local is correct here: a cluster peer's own window is its
 * own, exactly like the credentials being rate-limited (api_keys, oauth_*)
 * are node-local already.
 */

const WINDOW_MS = 60_000;
/** Used when a credential carries no override. */
export const DEFAULT_RATE_LIMIT_PER_MIN = 300;

interface Bucket {
	windowStart: number;
	count: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
	allowed: boolean;
	limit: number;
	remaining: number;
	/** Unix seconds the current window resets at. */
	resetAt: number;
}

/** Call once per request for a given identifier (`apikey:<id>`,
 * `oauth:<token id>`, ...). Mutates the shared bucket and returns the verdict. */
export function checkRateLimit(
	identifier: string,
	limitPerMin: number = DEFAULT_RATE_LIMIT_PER_MIN,
): RateLimitResult {
	const now = Date.now();
	let bucket = buckets.get(identifier);
	if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
		bucket = { windowStart: now, count: 0 };
		buckets.set(identifier, bucket);
	}
	bucket.count++;
	const resetAt = Math.ceil((bucket.windowStart + WINDOW_MS) / 1000);
	return {
		allowed: bucket.count <= limitPerMin,
		limit: limitPerMin,
		remaining: Math.max(0, limitPerMin - bucket.count),
		resetAt,
	};
}

/** Registered with jobs/scheduler.ts. A bucket older than one window is dead
 * weight -- its next request just starts a fresh one. */
export function pruneRateLimitBuckets(): void {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		if (now - bucket.windowStart >= WINDOW_MS) buckets.delete(key);
	}
}
