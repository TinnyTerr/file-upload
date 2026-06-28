import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const BACKEND = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

// Pure API prefixes: every path under them belongs to the backend.
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
  "/dropbox",
  "/health",
];

// `/file/:slug` and `/d/:slug` are SPA page routes, but their sub-resources
// (/info, /raw, /preview, /zip, /save, /preview-manifest) are backend APIs.
// Proxy only the API sub-resources; let bare page routes fall through to the
// SPA (index.html) so React Router renders them.
const apiSubResource = /\/(info|raw|preview|preview-manifest|zip|save)(\?.*)?$/;
const dualRouteBypass: ProxyOptions = {
  target: BACKEND,
  changeOrigin: true,
  bypass: (req) => (apiSubResource.test(req.url ?? "") ? undefined : "/index.html"),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(
        API_PREFIXES.map((p) => [p, { target: BACKEND, changeOrigin: true } as ProxyOptions]),
      ),
      "/file": dualRouteBypass,
      "/d": dualRouteBypass,
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-switch",
            "@radix-ui/react-checkbox",
            "@radix-ui/react-progress",
            "@radix-ui/react-label",
            "@radix-ui/react-slot",
          ],
          vendor: ["lucide-react", "sonner", "qrcode", "class-variance-authority", "tailwind-merge", "clsx"],
        },
      },
    },
  },
});
