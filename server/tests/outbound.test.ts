/**
 * Outbound request logging (src/outbound.ts).
 *
 * Two things are worth pinning down: that a call really does leave a record in
 * the buffer behind `GET /api/admin/backend/logs` even at the default console
 * level, and that the record does not contain the credential the request was
 * carrying — the log buffer is readable from the admin panel, while a
 * Real-Debrid unrestrict link or a cluster blob URL is not meant to be.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { queryBackendLogs } from "../src/logging.ts";
import { beginOutbound, fetchLogged, redactUrl } from "../src/outbound.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Every outbound line logged since this call, newest first. */
function outboundLines(marker: string): string[] {
	return queryBackendLogs({ q: marker, limit: 100 }).entries.map(
		(e) => e.message,
	);
}

describe("redactUrl", () => {
	test("masks credential-bearing query parameters", () => {
		const line = redactUrl(
			"https://peer.example/api/cluster/blobs/abc?transform=raw&token=s3cr3t",
		);
		expect(line).toContain("transform=raw");
		expect(line).not.toContain("s3cr3t");
	});

	test("masks the public-download access key and play key", () => {
		expect(redactUrl("https://h/file/slug?ek=deadbeef")).not.toContain(
			"deadbeef",
		);
		expect(redactUrl("https://h/api/media/1/stream?k=sealed")).not.toContain(
			"sealed",
		);
	});

	test("strips basic-auth userinfo", () => {
		expect(
			redactUrl("http://admin:hunter2@127.0.0.1:8080/api/v2"),
		).not.toContain("hunter2");
	});

	test("origin mode drops the path, which can itself be the credential", () => {
		// The shape of a Real-Debrid unrestricted download link.
		const line = redactUrl(
			"https://x.download.rd.com/d/TOKEN123/movie.mkv",
			"origin",
		);
		expect(line).toBe("https://x.download.rd.com/...");
		expect(line).not.toContain("TOKEN123");
	});

	test("an unparseable URL never lands in the log verbatim", () => {
		expect(redactUrl("not a url at all")).toBe("<unparsed-url>");
	});
});

describe("fetchLogged", () => {
	test("records the response status and duration", async () => {
		globalThis.fetch = (async () =>
			new Response("{}", { status: 200 })) as typeof fetch;

		await fetchLogged("testsvc", "https://example.test/probe-ok");

		const lines = outboundLines("probe-ok");
		expect(lines.some((l) => l.includes("outbound testsvc GET"))).toBe(true);
		expect(lines.some((l) => /-> 200 in \d+ms/.test(l))).toBe(true);
	});

	test("logs a transport failure and rethrows it unchanged", async () => {
		const boom = new Error("connection refused");
		globalThis.fetch = (async () => {
			throw boom;
		}) as typeof fetch;

		await expect(
			fetchLogged("testsvc", "https://example.test/probe-down"),
		).rejects.toThrow("connection refused");

		const lines = outboundLines("probe-down");
		expect(
			lines.some(
				(l) => l.includes("failed") && l.includes("connection refused"),
			),
		).toBe(true);
	});

	test("a 4xx is logged as a warning so it surfaces at the default level", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 403 })) as typeof fetch;

		await fetchLogged("testsvc", "https://example.test/probe-denied");

		const entries = queryBackendLogs({
			q: "probe-denied",
			limit: 100,
		}).entries.filter((e) => e.message.includes("-> 403"));
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0]!.level).toBe("WARNING");
	});
});

describe("beginOutbound", () => {
	test("only the first outcome is recorded", () => {
		const call = beginOutbound("testsvc", "GET", "https://example.test/once");
		call.ok(200);
		call.fail(new Error("late"));

		const lines = outboundLines("once");
		expect(lines.filter((l) => l.includes("-> 200")).length).toBe(1);
		expect(lines.some((l) => l.includes("late"))).toBe(false);
	});
});
