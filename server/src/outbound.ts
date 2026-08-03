import { getLogger } from "./logging.ts";

/** One log line per outbound HTTP request this server makes, so every call
 * that leaves this process -- Real-Debrid, qBittorrent, cluster peers, remote
 * URL fetches -- is visible in the same place as inbound traffic
 * (`app.request` from middleware/requestLogging.ts).
 *
 * Levels are picked for volume: the firehose consumer polls every peer once a
 * second and the torrent poller runs every 5s, so a healthy call logs at
 * DEBUG. That still records it -- logging.ts's ring buffer captures DEBUG
 * regardless of the console level, so GET /api/admin/backend/logs shows every
 * outbound request while the console stays quiet at INFO. Anything that fails
 * (transport error, or a 4xx/5xx from the other side) logs at WARNING so it
 * surfaces without turning the whole server up to DEBUG.
 *
 * URLs are redacted before they are logged: cluster blob URLs, play-key
 * streams and Real-Debrid unrestrict links all carry credentials, and the log
 * buffer is readable from the admin panel. */

const log = getLogger("app.outbound");

/** Query-parameter names whose *values* are credentials, not identifiers.
 * `ek` is the server-mode access key from routes/public.ts, `k` a sealed play
 * key from media/playKeys.ts. */
const SENSITIVE_PARAM = /^(.*(token|key|secret|password|auth|sig).*|ek|k)$/i;

export type RedactMode = "full" | "origin";

/**
 * Strips credentials out of a URL for logging.
 *
 * `mode: "origin"` keeps only the scheme and host, for URLs whose *path* is
 * the credential -- a Real-Debrid unrestricted download link is
 * `https://<host>/d/<token>/<filename>`, so its path must not be logged.
 */
export function redactUrl(raw: string, mode: RedactMode = "full"): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "<unparsed-url>";
	}
	if (url.username || url.password) {
		url.username = "";
		url.password = "";
	}
	if (mode === "origin") return `${url.origin}/...`;
	for (const key of [...url.searchParams.keys()]) {
		if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, "REDACTED");
	}
	return url.toString();
}

export interface OutboundCall {
	/** Log a response that came back, whatever its status. */
	ok(status: number, note?: string): void;
	/** Log a transport-level failure: DNS, refused, TLS, timeout, abort. */
	fail(err: unknown): void;
}

/**
 * Logs "request started" and returns the handle that logs its outcome. Use
 * this directly only where the request is not a plain `fetch` (raw sockets in
 * routes/remoteUpload.ts); everything else should go through `fetchLogged`.
 *
 * `service` is the short name of the far side (`realdebrid`, `qbittorrent`,
 * `cluster`, `remote-upload`) and is what you grep the log buffer for.
 */
export function beginOutbound(
	service: string,
	method: string,
	url: string,
	opts: { redact?: RedactMode } = {},
): OutboundCall {
	const target = redactUrl(url, opts.redact ?? "full");
	const startedAt = Date.now();
	log.debug(`outbound ${service} ${method} ${target}`);
	let settled = false;
	return {
		ok(status, note) {
			if (settled) return;
			settled = true;
			const suffix = note ? ` (${note})` : "";
			const line = `outbound ${service} ${method} ${target} -> ${status} in ${Date.now() - startedAt}ms${suffix}`;
			if (status >= 400) log.warning(line);
			else log.debug(line);
		},
		fail(err) {
			if (settled) return;
			settled = true;
			const reason = err instanceof Error ? err.message : String(err);
			log.warning(
				`outbound ${service} ${method} ${target} -> failed after ${Date.now() - startedAt}ms: ${reason}`,
			);
		},
	};
}

/**
 * `fetch` with a request log on both ends. Errors are logged and rethrown
 * unchanged, so callers keep translating them into their own error types
 * (`RealDebridError`, `ClusterHTTPError`, `HttpError`) exactly as before.
 *
 * The response is logged as soon as its headers arrive; for a streaming body
 * (blob transfers, Real-Debrid file pulls) that is the point the request
 * succeeded, not the point the last byte lands. Pass `note` to say so.
 */
export async function fetchLogged(
	service: string,
	url: string,
	init: RequestInit = {},
	opts: { redact?: RedactMode; note?: string } = {},
): Promise<Response> {
	const method = (init.method ?? "GET").toUpperCase();
	const call = beginOutbound(service, method, url, opts);
	try {
		const res = await fetch(url, init);
		call.ok(res.status, opts.note);
		return res;
	} catch (err) {
		call.fail(err);
		throw err;
	}
}
