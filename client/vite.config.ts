import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { ProxyOptions } from "vite";

// The SPA builds to ../public so the FastAPI app can serve it later (a separate
// phase will wire the catch-all route + deep-link fallback). app/static is left
// untouched for now.
//
// In dev, proxy every backend path to the locally-running FastAPI server so the
// React app can run against real data without touching server code. Anything not
// matched here is served by Vite as part of the SPA.
const BACKEND = process.env.BACKEND_ORIGIN || "http://localhost:8000";

// Plain API prefixes — always proxied to the backend.
const API_PREFIXES = [
  "/auth",
  "/account",
  "/files",
  "/directories",
  "/links",
  "/keys",
  "/users",
  "/admin",
  "/audit",
  "/dropbox-links",
  "/health",
];

// `/d/:slug` and `/file/:slug` are SPA *pages* (served by Vite), but their
// deeper sub-paths (`/d/:slug/info`, `/file/:slug/raw`, …) are backend APIs.
// Bypass the proxy for the bare single-segment page route so the SPA loads.
const pageBypass =
  (re: RegExp): ProxyOptions => ({
    target: BACKEND,
    changeOrigin: true,
    bypass: (req) => {
      const url = (req.url || "").split("?")[0];
      if (re.test(url)) return "/index.html"; // serve SPA
      return undefined; // proxy to backend
    },
  });

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      ...Object.fromEntries(
        API_PREFIXES.map((p) => [p, { target: BACKEND, changeOrigin: true }]),
      ),
      "/d": pageBypass(/^\/d\/[^/]+\/?$/),
      "/file": pageBypass(/^\/file\/[^/]+\/?$/),
    },
  },
});
