import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "./appState.ts";
import { securityHeaders } from "./middleware/securityHeaders.ts";
import { requestLogging } from "./middleware/requestLogging.ts";
import { httpsRedirect } from "./middleware/httpsRedirect.ts";
import { authRouter } from "./routes/auth.ts";
import { accountRouter } from "./routes/account.ts";
import { keysRouter, adminKeysRouter } from "./routes/keys.ts";
import { usersRouter } from "./routes/users.ts";
import { auditRouter } from "./routes/audit.ts";
import { filesRouter, adminFilesRouter, linksRouter } from "./routes/files.ts";
import { publicRouter } from "./routes/public.ts";
import { remoteUploadRouter } from "./routes/remoteUpload.ts";
import { directoriesRouter, adminDirectoriesRouter, publicDirectoriesRouter } from "./routes/directories.ts";
import { dropboxRouter } from "./routes/dropbox.ts";
import { adminRouter } from "./routes/admin.ts";
import { clusterRouter, adminClusterRouter } from "./routes/cluster.ts";
import { HttpError } from "./httpError.ts";
import { getLogger } from "./logging.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SPA_DIST = join(REPO_ROOT, "public");

/** Mirrors app/main.py::create_app -- same middleware order, health check,
 * and same-origin static+SPA serving (no CORS, matching the FastAPI app). */
export function createApp(state: AppState): Express {
  const secure = state.settings.appEnv !== "dev";
  const app = express();

  app.use(httpsRedirect(state.settings));
  app.use(securityHeaders(secure));
  app.use(requestLogging(state));
  app.use(express.json());
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Every JSON/data-returning endpoint lives under /api/* so it can never
  // collide with an SPA client-side route (e.g. /files, /admin, /cluster are
  // both page routes and route prefixes here) -- see spaRoutes below.
  app.use("/api/auth", authRouter(state));
  app.use("/api/account", accountRouter(state));
  app.use("/api/keys", keysRouter(state));
  app.use("/api/admin/keys", adminKeysRouter(state));
  app.use("/api/users", usersRouter(state));
  app.use("/api/audit", auditRouter(state));
  app.use("/api/files", filesRouter(state));
  app.use("/api/files", remoteUploadRouter(state));
  app.use("/api/admin/files", adminFilesRouter(state));
  app.use("/api/links", linksRouter(state));
  app.use("/api/admin/directories", adminDirectoriesRouter(state));
  app.use("/api", directoriesRouter(state));
  app.use("/api", dropboxRouter(state));
  app.use("/api/admin", adminRouter(state));
  app.use("/api/cluster", clusterRouter(state));
  app.use("/api/admin/cluster", adminClusterRouter(state));
  app.use("/api", publicRouter(state));
  app.use("/api", publicDirectoriesRouter(state));

  if (existsSync(SPA_DIST)) {
    app.use(
      express.static(SPA_DIST, {
        setHeaders(res, filePath) {
          if (filePath.includes(`${join(SPA_DIST, "assets")}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
    const spaRoutes = ["/", "/login", "/account/change", "/files", "/admin", "/api-docs", "/api-keys", "/cluster"];
    app.get(spaRoutes, (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(join(SPA_DIST, "index.html"));
    });
  }

  // Converts thrown HttpError into FastAPI-style {detail} JSON; anything else
  // is logged with its stack and returned as an opaque 500.
  const errorLog = getLogger("app.error");
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ detail: err.detail });
      return;
    }
    errorLog.error(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (!res.headersSent) {
      res.status(500).json({ detail: "internal server error" });
    }
  });

  return app;
}
