// @ts-expect-error type error without @types/node package
import process from "node:process";
import { defineConfig, loadEnv } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// DSNs live in the repo-root .env, one per surface; only the desktop one is
// baked into this bundle.
const rootEnv = loadEnv(
	process.env.NODE_ENV ?? "development",
	"..",
	"SENTRY_DSN_",
);

export default defineConfig(() => ({
	define: {
		__SENTRY_DSN__: JSON.stringify(
			process.env.SENTRY_DSN_DESKTOP ?? rootEnv.SENTRY_DSN_DESKTOP ?? "",
		),
	},
	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
}));
