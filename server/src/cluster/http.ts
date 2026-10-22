/** Node-to-node HTTP helpers. Mirrors app/cluster/http.py.
 *
 * Uses the global `fetch` (available in Bun) so the cluster runtime adds no
 * new third-party dependency for outbound calls -- through `fetchLogged`, so
 * every peer call shows up in the log buffer like any other outbound request.
 * These calls always target operator-configured peer base URLs authenticated
 * by the shared cluster token -- they are not user-controlled URLs, so the
 * SSRF pinning that remoteUpload.ts needs does not apply here. */

import { fetchLogged } from "../outbound.ts";
import { activity } from "./activity.ts";

/** `POST /api/cluster/reserve` and the peer's host, for the live activity view. */
function traceOut(method: string, url: string) {
	try {
		const u = new URL(url);
		return activity.begin("out", `${method} ${u.pathname}`, {
			touches: ["peers"],
			peer: u.host,
		});
	} catch {
		return activity.begin("out", `${method} ${url}`, { touches: ["peers"] });
	}
}

export class ClusterHTTPError extends Error {
	status: number;
	body: string;

	constructor(status: number, body = "") {
		super(`cluster http ${status}: ${body.slice(0, 200)}`);
		this.status = status;
		this.body = body;
	}
}

async function request(
	method: string,
	url: string,
	token: string,
	opts: { payload?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
	};
	let body: string | undefined;
	if (opts.payload !== undefined) {
		body = JSON.stringify(opts.payload);
		headers["Content-Type"] = "application/json";
	}
	const end = traceOut(method, url);
	try {
		const resp = await fetchLogged("cluster", url, {
			method,
			headers,
			body,
			signal: controller.signal,
		});
		const text = await resp.text();
		if (!resp.ok) {
			throw new ClusterHTTPError(resp.status, text);
		}
		end(true, String(resp.status));
		if (!text) return null;
		return JSON.parse(text);
	} catch (err) {
		if (err instanceof ClusterHTTPError) {
			end(false, err.status ? String(err.status) : err.body.slice(0, 80));
			throw err;
		}
		const reason = err instanceof Error ? err.message : String(err);
		end(false, reason.slice(0, 80));
		throw new ClusterHTTPError(0, reason);
	} finally {
		clearTimeout(timer);
	}
}

export function getJson(
	url: string,
	token: string,
	timeoutMs = 10_000,
): Promise<unknown> {
	return request("GET", url, token, { timeoutMs });
}

export function postJson(
	url: string,
	token: string,
	payload: unknown,
	timeoutMs = 10_000,
): Promise<unknown> {
	return request("POST", url, token, { payload, timeoutMs });
}

/** Open a raw streaming GET (for node-to-node blob transfer). Returns the
 * fetch Response so the caller can stream its body. Throws ClusterHTTPError
 * on non-2xx or network failure. */
export async function openStream(
	url: string,
	token: string,
	timeoutMs = 30_000,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const end = traceOut("GET", url);
	try {
		const resp = await fetchLogged(
			"cluster",
			url,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				signal: controller.signal,
			},
			{ note: "streaming" },
		);
		if (!resp.ok) {
			throw new ClusterHTTPError(resp.status);
		}
		// Covers time-to-headers, not the body transfer the caller streams.
		end(true, String(resp.status));
		return resp;
	} catch (err) {
		if (err instanceof ClusterHTTPError) {
			end(false, String(err.status));
			throw err;
		}
		const reason = err instanceof Error ? err.message : String(err);
		end(false, reason.slice(0, 80));
		throw new ClusterHTTPError(0, reason);
	} finally {
		clearTimeout(timer);
	}
}
