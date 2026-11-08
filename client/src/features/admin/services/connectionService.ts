import { api, apiPath } from "@/config/api";

/** Transport for the admin "Connection" debug tab. Nothing here is stored. */
export const connectionService = {
	/** Round trip of one small request, in milliseconds. */
	async ping(signal?: AbortSignal): Promise<number> {
		const started = performance.now();
		const res = await fetch(apiPath("/health"), {
			cache: "no-store",
			credentials: "same-origin",
			signal,
		});
		if (!res.ok) throw new Error(`ping failed: HTTP ${res.status}`);
		await res.text();
		return performance.now() - started;
	},

	/** Streams `bytes` of random data from the server and times it. */
	async download(bytes: number, signal?: AbortSignal) {
		const started = performance.now();
		const res = await fetch(
			apiPath(`/admin/connection-test/download?bytes=${bytes}`),
			{ cache: "no-store", credentials: "same-origin", signal },
		);
		if (!res.ok || !res.body) {
			throw new Error(`download failed: HTTP ${res.status}`);
		}
		const reader = res.body.getReader();
		let received = 0;
		let firstByteMs: number | null = null;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (firstByteMs === null) firstByteMs = performance.now() - started;
			received += value.byteLength;
		}
		return {
			bytes: received,
			seconds: (performance.now() - started) / 1000,
			firstByteMs: firstByteMs ?? 0,
		};
	},

	/** One upload chunk, discarded by the server. `length` is what it checks
	 * against the body, so a truncated body can't pass for a measured chunk. */
	uploadChunk: (length: number, body: Blob, signal?: AbortSignal) =>
		api.post<{ received: number }>("/admin/connection-test/chunk", {
			query: { length },
			body,
			headers: { "Content-Type": "application/octet-stream" },
			signal,
		}),
};
