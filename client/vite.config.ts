import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const BACKEND = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

// DSNs live in the repo-root .env, one per surface. Only the web one is baked
// into this bundle; the server and desktop keys never reach the browser.
const rootEnv = loadEnv(process.env.NODE_ENV ?? "development", "..", "SENTRY_DSN_");

/** Writes `.br` and `.gz` siblings of every compressible file in assets/, so
 * the server (`spa.ts`) can hand out the smallest variant without compressing
 * per request. Skipped when the compressed copy isn't smaller. */
function precompress(): Plugin {
	let outDir = "";
	return {
		name: "precompress-assets",
		apply: "build",
		configResolved(c) {
			outDir = join(c.root, c.build.outDir, "assets");
		},
		closeBundle() {
			for (const f of readdirSync(outDir)) {
				if (!/\.(js|css|svg|json|wasm)$/.test(f)) continue;
				const buf = readFileSync(join(outDir, f));
				if (buf.length < 1024) continue;
				const br = brotliCompressSync(buf, {
					params: {
						[constants.BROTLI_PARAM_QUALITY]: 11,
						[constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
					},
				});
				if (br.length < buf.length) writeFileSync(join(outDir, `${f}.br`), br);
				const gz = gzipSync(buf, { level: 9 });
				if (gz.length < buf.length) writeFileSync(join(outDir, `${f}.gz`), gz);
			}
		},
	};
}

export default defineConfig({
	define: {
		__SENTRY_DSN__: JSON.stringify(
			process.env.SENTRY_DSN_WEB ?? rootEnv.SENTRY_DSN_WEB ?? "",
		),
	},
	plugins: [react(), tailwindcss(), precompress()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// The API reference is authored in the repo's docs/ directory and
			// imported (as `@docs/api.md?raw`) straight into the bundle, so the
			// /api-docs page renders without a runtime fetch. TypeScript resolves
			// that specifier through vite/client's `*?raw` module declaration.
			"@docs": fileURLToPath(new URL("../docs", import.meta.url)),
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
					// `qrcode` is deliberately absent: it is only used by the MFA setup
					// page and share modal, and naming it here would pull it into the
					// chunk every page loads.
					vendor: [
						"lucide-react",
						"sonner",
						"class-variance-authority",
						"tailwind-merge",
						"clsx",
					],
				},
			},
		},
	},
});
