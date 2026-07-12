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

export function clientIp(state: AppState, req: Request): string {
  if (state.settings.trustProxy) {
    const forwarded = req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress || "";
}
