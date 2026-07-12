import type { Request, Response, NextFunction } from "express";
import type { SessionRow } from "./sessions.ts";

declare module "express-serve-static-core" {
  interface Request {
    sessionRow?: SessionRow;
  }
}

/** Requires an already-resolved req.sessionRow (see currentSession middleware)
 * and a matching X-CSRF-Token header. Mirrors app/security/csrf.py::require_csrf. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const sessionRow = req.sessionRow;
  if (!sessionRow) {
    res.status(401).json({ detail: "not authenticated" });
    return;
  }
  const header = req.header("x-csrf-token");
  if (!header || header !== sessionRow.csrf_token) {
    res.status(403).json({ detail: "invalid or missing CSRF token" });
    return;
  }
  next();
}
