import type { Request, Response, NextFunction } from "express";

/** Mirrors app/main.py::_SecurityHeaders. */
export function securityHeaders(secure: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (secure) {
      res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
    next();
  };
}
