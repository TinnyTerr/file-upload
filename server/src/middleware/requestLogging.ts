import type { Request, Response, NextFunction } from "express";

const QUIET_PATHS = [/^\/favicon\.ico$/, /^\/health$/, /^\/robots\.txt$/, /^\/apple-touch-icon.*\.png$/, /^\/static\//];

/** Mirrors app/main.py::_RequestLogging: logs method/path/status/duration,
 * quieting routine noise paths. */
export function requestLogging(_req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  res.on("finish", () => {
    const quiet = QUIET_PATHS.some((re) => re.test(_req.path));
    if (quiet && res.statusCode < 400) return;
    const durationMs = (performance.now() - start).toFixed(1);
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    console[level](
      `${_req.method} ${_req.path} ${res.statusCode} ${durationMs}ms ip=${_req.socket.remoteAddress ?? "-"}`,
    );
  });
  next();
}
