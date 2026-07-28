import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BACKEND = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

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
			// Every backend endpoint lives under /api/*; everything else falls
			// through to the SPA (index.html) so React Router renders it, with no
			// regex-based sub-resource guessing needed. ws:true also proxies the
			// /api/ws/events and /api/admin/cluster/firehose websocket upgrades.
			"/api": { target: BACKEND, changeOrigin: true, ws: true },
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
					vendor: [
						"lucide-react",
						"sonner",
						"qrcode",
						"class-variance-authority",
						"tailwind-merge",
						"clsx",
					],
				},
			},
		},
	},
});
