import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { sentryTunnelRouter } from "../src/routes/sentryTunnel.ts";

const DSN = "https://abc123@o1.ingest.example.io/42";
let server: Server;
let base: string;
let prev: string | undefined;

beforeAll(async () => {
	prev = process.env.SENTRY_DSN_WEB;
	process.env.SENTRY_DSN_WEB = DSN;
	const app = express();
	app.use("/t", sentryTunnelRouter());
	await new Promise<void>((r) => {
		server = app.listen(0, r);
	});
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}/t`;
});
afterAll(() => {
	server.close();
	if (prev === undefined) delete process.env.SENTRY_DSN_WEB;
	else process.env.SENTRY_DSN_WEB = prev;
});

const post = (body: string) =>
	fetch(base, {
		method: "POST",
		headers: { "Content-Type": "text/plain" },
		body,
	});

describe("sentry tunnel", () => {
	test("rejects an envelope for a different dsn", async () => {
		const res = await post(
			`${JSON.stringify({ dsn: "https://k@evil.example/1" })}\n{}`,
		);
		expect(res.status).toBe(400);
	});
	test("rejects garbage", async () => {
		expect((await post("not json")).status).toBe(400);
	});
	test("404s when web reporting is off", async () => {
		delete process.env.SENTRY_DSN_WEB;
		try {
			expect((await post(`${JSON.stringify({ dsn: DSN })}\n{}`)).status).toBe(
				404,
			);
		} finally {
			process.env.SENTRY_DSN_WEB = DSN;
		}
	});
});
