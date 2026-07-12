import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "./appState.ts";
import { securityHeaders } from "./middleware/securityHeaders.ts";
import { requestLogging } from "./middleware/requestLogging.ts";
import { httpsRedirect } from "./middleware/httpsRedirect.ts";
import { authRouter } from "./routes/auth.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SPA_DIST = join(REPO_ROOT, "public");

/** Mirrors app/main.py::create_app -- same middleware order, health check,
 * and same-origin static+SPA serving (no CORS, matching the FastAPI app). */
export function createApp(state: AppState): Express {
  const secure = state.settings.appEnv !== "dev";
  const app = express();

  app.use(httpsRedirect(state.settings));
  app.use(securityHeaders(secure));
  app.use(requestLogging);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter(state));

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
    const spaRoutes = ["/", "/login", "/account/change", "/files", "/admin", "/api-docs"];
    app.get(spaRoutes, (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(join(SPA_DIST, "index.html"));
    });
  }

  return app;
}
