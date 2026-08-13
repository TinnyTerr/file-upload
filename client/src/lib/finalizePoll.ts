import { ApiError } from "@/config/api";

/**
 * Poll a chunked upload's finalize until the server hands back a result.
 *
 * Finalizing a multi-GB upload is a minute or more of server-side hashing, and
 * no proxy in front of this app will hold a request open that long —
 * Cloudflare cuts at 100s, nginx's `proxy_read_timeout` defaults to 60s. So the
 * server doesn't try: finalize starts the work, answers `202 {status:
 * "finalizing"}`, and this re-POSTs until the outcome is known. The endpoint is
 * idempotent, so a poll either restarts nothing, is told to keep waiting, or is
 * handed the original result.
 *
 * The 202 still has to be polled through rather than trusted as an answer, and
 * a dead connection still has to be retried rather than reported as failure:
 * the work outlives the request either way, so an upload that has already
 * succeeded must never surface to the user as an error.
 */

/** Gap between finalize polls. Matches the server's advertised retry_after_ms. */
const POLL_MS = 3000;
/** Give up after this long. Generous: it bounds a hung server, not a slow one. */
const MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * Whether a failed finalize is worth re-POSTing.
 *
 * The two cases that matter are the server explicitly saying "still working"
 * and the request never reaching a verdict at all (a proxy timeout surfaces as
 * a 502/504, a dropped connection as a raw `TypeError` from fetch rather than
 * an `ApiError`). Anything else — 410 gone, 413 over quota, 403 — is a real
 * answer and re-asking would only stall the user behind a failure they already
 * have.
 *
 * Note the 409 split: this endpoint returns that status for *both* "finalize in
 * progress" and "upload incomplete, here are the missing chunks". Only the
 * former is a wait; treating the latter as one would poll forever over chunks
 * that are never going to arrive on their own.
 */
function isRetryable(err: unknown): boolean {
	if (!(err instanceof ApiError)) return true; // transport failure
	if (err.status === 502 || err.status === 503 || err.status === 504)
		return true;
	if (err.status !== 409) return false;
	const detail = err.detail;
	if (typeof detail === "string") return detail.includes("in progress");
	return (
		!!detail &&
		typeof detail === "object" &&
		(detail as { error?: string }).error === "finalize in progress"
	);
}

/**
 * A 202 body, meaning the work has been accepted and is still running.
 *
 * This arrives as a *success*, not an error — `fetch` is perfectly happy with
 * a 202 — so it has to be recognized by shape. Handing it back as an upload
 * result would give the caller a slug-less object where it expected a stored
 * file.
 */
function isPending(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { status?: string }).status === "finalizing"
	);
}

export async function pollFinalize<T>(
	finalize: () => Promise<T>,
	opts: { signal?: AbortSignal } = {},
): Promise<T> {
	const deadline = Date.now() + MAX_WAIT_MS;
	for (let attempt = 0; ; attempt++) {
		let pending = false;
		try {
			const result = await finalize();
			if (!isPending(result)) return result;
			pending = true;
		} catch (err) {
			if (opts.signal?.aborted) throw err;
			if (!isRetryable(err) || Date.now() >= deadline) throw err;
		}
		if (Date.now() >= deadline) {
			throw new Error("upload finalize timed out on the server");
		}
		// A 202 means the server is definitely working, so wait a full interval.
		// A failed request might just have been a blip on a finalize that already
		// finished, so the first of those retries goes out quickly.
		await new Promise((r) =>
			setTimeout(r, !pending && attempt === 0 ? 1000 : POLL_MS),
		);
	}
}
