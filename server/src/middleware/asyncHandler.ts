import type { Request, Response, NextFunction, RequestHandler } from "express";

/** Express 4 does not await async handlers, so a rejected promise becomes an
 * unhandled rejection and the request hangs with no response ever sent.
 * Wrapping forwards the rejection to app.ts's error handler instead. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
