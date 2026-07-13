import type { Request, Response, NextFunction } from "express";
import type { AppState } from "../appState.ts";
import { getLogger } from "../logging.ts";
import { clientIp } from "./auth.ts";

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
    res.on("finish", () => {
      const path = req.path;
      const status = res.statusCode;
      const isNoise = path.startsWith("/static") || path.startsWith("/assets") || QUIET_PATHS.has(path);
      const line = `http request method=${req.method} path=${path} status=${status} duration_ms=${(
        performance.now() - start
      ).toFixed(1)} client=${clientIp(state, req)}`;
      if (status >= 500) log.error(line);
      else if (status >= 400) (isNoise ? log.debug : log.warning)(line);
      else if (isNoise) log.debug(line);
      else log.info(line);
    });
    next();
  };
}
