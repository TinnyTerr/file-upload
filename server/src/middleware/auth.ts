import type { Request, Response, NextFunction } from "express";
import type { AppState } from "../appState.ts";
import { COOKIE_NAME } from "../security/sessions.ts";

/** Resolves the fu_session cookie into req.sessionRow, mirrors
 * app/deps.py::current_session. 401s if missing/invalid/expired. */
export function requireSession(state: AppState) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookieValue = req.cookies?.[COOKIE_NAME] as string | undefined;
    const sessionRow = state.sessionManager.resolve(state.db, cookieValue);
    if (!sessionRow) {
      res.status(401).json({ detail: "not authenticated" });
      return;
    }
    req.sessionRow = sessionRow;
    next();
  };
}

/** Real client IP behind a trusted proxy. TRUST_PROXY=cloudflare prefers
 * CF-Connecting-IP; TRUST_PROXY=true uses leftmost X-Forwarded-For but still
 * honors CF-Connecting-IP when Cloudflare headers are present, since
 * Cloudflare sets it authoritatively while XFF is client-appendable. */
export function clientIp(state: AppState, req: Request): string {
  const mode = state.settings.trustProxyMode;
  if (mode !== "off") {
    const cfIp = req.header("cf-connecting-ip");
    if (cfIp && (mode === "cloudflare" || req.header("cf-ray"))) return cfIp.trim();
    if (mode !== "cloudflare") {
      const forwarded = req.header("x-forwarded-for");
      if (forwarded) return forwarded.split(",")[0]!.trim();
    }
  }
  return req.socket.remoteAddress || "";
}
