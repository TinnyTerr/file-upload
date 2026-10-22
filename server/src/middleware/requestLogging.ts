import type { NextFunction, Request, Response } from "express";
import type { AppState } from "../appState.ts";
import { getLogger } from "../logging.ts";
import { clientIp } from "./auth.ts";
import { actorOf } from "./deny.ts";

const log = getLogger("app.request");

const QUIET_PATHS = new Set([
	"/favicon.ico",
	"/health",
	"/robots.txt",
	"/apple-touch-icon.png",
	"/apple-touch-icon-precomposed.png",
]);

/** Mirrors app/main.py::_RequestLogging: logs method/path/status/duration at a
 * level proportional to how noteworthy the request is, so routine noise
 * (favicon probes, health checks, static assets) stays at DEBUG. */
export function requestLogging(state: AppState) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const start = performance.now();
		// Every refusal in the codebase ends in res.json({detail}), whether the
		// route wrote it directly or threw an HttpError, so capturing it here
		// puts the stated reason on the request line without touching ~100 sites.
		let detail = "";
		const json = res.json.bind(res);
		res.json = (body?: unknown) => {
			if (res.statusCode >= 400 && body && typeof body === "object") {
				const d = (body as { detail?: unknown }).detail;
				if (d !== undefined)
					detail = typeof d === "string" ? d : JSON.stringify(d);
			}
			return json(body);
		};
		res.on("finish", () => {
			const path = req.originalUrl.split("?")[0] ?? req.originalUrl;
			const status = res.statusCode;
			const isNoise =
				path.startsWith("/static") ||
				path.startsWith("/assets") ||
				QUIET_PATHS.has(path);
			const line = `http request method=${req.method} path=${path} status=${status} duration_ms=${(
				performance.now() - start
			).toFixed(
				1,
			)} client=${clientIp(state, req)} actor=${actorOf(req)} ${detail ? ` detail="${detail.slice(0, 300)}"` : ""} ua="${(req.header("user-agent") ?? "-").slice(0, 120)}"`;
			if (status >= 500) log.error(line);
			else if (status >= 400) (isNoise ? log.debug : log.warning)(line);
			else if (isNoise) log.debug(line);
			else log.info(line);
		});
		next();
	};
}
