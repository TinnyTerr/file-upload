import type { Request, Response, NextFunction } from "express";
import type { Settings } from "../config.ts";

/** Mirrors app/main.py::_HttpsRedirect: outside dev, redirects http->https
 * with 308, honoring X-Forwarded-Proto/Host only when trust_proxy is set and
 * the host is in the allowed list. */
export function httpsRedirect(settings: Settings) {
  const allowedHosts = new Set(
    settings.allowedHosts
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    if (settings.appEnv === "dev") {
      next();
      return;
    }
    const host = req.header("host") ?? "";
    let proto = req.protocol;
    let effectiveHost = host;
    if (settings.trustProxy && allowedHosts.has(host)) {
      proto = req.header("x-forwarded-proto") || proto;
      effectiveHost = req.header("x-forwarded-host") || host;
    }
    if (proto !== "https") {
      res.redirect(308, `https://${effectiveHost}${req.originalUrl}`);
      return;
    }
    next();
  };
}
