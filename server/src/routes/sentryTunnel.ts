import express, { type Request, type Response, Router } from "express";
import { sentryWebEnvelopeUrl } from "../sentry.ts";

/** Browser Sentry events relayed through this origin (`tunnel` option on the
 * client), so the page CSP needs no extra `connect-src` and ad blockers that
 * match ingest hosts don't drop them. The upstream is fixed by
 * `SENTRY_DSN_WEB`; the envelope's own `dsn` header is checked against it so
 * this can't be used to relay to anywhere else. */
const MAX_ENVELOPE_BYTES = 1024 * 1024;

export function sentryTunnelRouter(): Router {
	const router = Router();
	router.post(
		"/",
		express.raw({ type: () => true, limit: MAX_ENVELOPE_BYTES }),
		async (req: Request, res: Response) => {
			const upstream = sentryWebEnvelopeUrl();
			if (!upstream || !Buffer.isBuffer(req.body)) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			try {
				const header = JSON.parse(
					req.body.toString("utf-8").split("\n", 1)[0] ?? "",
				);
				const dsn = new URL(header.dsn);
				if (dsn.origin + dsn.pathname !== upstream.dsnKey) {
					res.status(400).json({ detail: "unknown dsn" });
					return;
				}
			} catch {
				res.status(400).json({ detail: "invalid envelope" });
				return;
			}
			try {
				const r = await fetch(upstream.url, {
					method: "POST",
					headers: { "Content-Type": "application/x-sentry-envelope" },
					body: req.body,
					signal: AbortSignal.timeout(10_000),
				});
				res.status(r.ok ? 200 : 502).end();
			} catch {
				res.status(502).end();
			}
		},
	);
	return router;
}
