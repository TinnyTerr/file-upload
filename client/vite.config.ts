import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const BACKEND = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

// DSNs live in the repo-root .env, one per surface. Only the web one is baked
// into this bundle; the server and desktop keys never reach the browser.
const rootEnv = loadEnv(process.env.NODE_ENV ?? "development", "..", "SENTRY_");
const sentryEnv = (key: string): string | undefined =>
	process.env[key] ?? rootEnv[key] ?? undefined;

/** `fileupload@<version>+<short sha>` -- must equal server/src/version.ts's
 * SENTRY_RELEASE so server events and this bundle land in one release. */
function sentryRelease(): string {
	const version = JSON.parse(
		readFileSync(
			fileURLToPath(new URL("../package.json", import.meta.url)),
			"utf-8",
		),
	).version as string;
	let sha = process.env.BUILD_SHA?.trim().slice(0, 12) ?? "";
	if (!sha) {
		try {
			sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim();
		} catch {
			/* no checkout: release is the bare version */
		}
	}
	return `fileupload@${sha ? `${version}+${sha}` : version}`;
}
const release = sentryRelease();
const rate = (key: string, fallback: number): number => {
	const n = Number(sentryEnv(key));
	return sentryEnv(key) !== undefined && Number.isFinite(n) ? n : fallback;
};

/** Source maps + release + commits are only uploaded when an auth token is
 * present (CI / a deploy build); a plain `bun run build` stays offline. */
const uploadSourcemaps = Boolean(
	sentryEnv("SENTRY_AUTH_TOKEN") &&
		sentryEnv("SENTRY_ORG") &&
		sentryEnv("SENTRY_PROJECT_WEB"),
);

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
		__SENTRY_DSN__: JSON.stringify(sentryEnv("SENTRY_DSN_WEB") ?? ""),
		__SENTRY_RELEASE__: JSON.stringify(release),
		__SENTRY_TRACES_RATE__: rate("SENTRY_TRACES_SAMPLE_RATE", 0.1),
		__SENTRY_REPLAY_RATE__: rate("SENTRY_REPLAY_SAMPLE_RATE", 0.05),
	},
	plugins: [
		react(),
		tailwindcss(),
		// Last of the Sentry steps: upload, then delete the maps so they are never
		// served. Must run before precompress() copies anything.
		...(uploadSourcemaps
			? [
					sentryVitePlugin({
						org: sentryEnv("SENTRY_ORG"),
						project: sentryEnv("SENTRY_PROJECT_WEB"),
						authToken: sentryEnv("SENTRY_AUTH_TOKEN"),
						url: sentryEnv("SENTRY_URL"),
						release: {
							name: release,
							// Links the release to the repo's commits (needs the repo
							// connected under Sentry -> Settings -> Integrations).
							setCommits: { auto: true, ignoreMissing: true },
							deploy: { env: process.env.NODE_ENV ?? "production" },
						},
						sourcemaps: { filesToDeleteAfterUpload: ["../public/**/*.map"] },
						telemetry: false,
					}),
				]
			: []),
		precompress(),
	],
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
		// "hidden": maps are written for the upload above but not referenced from
		// the bundles. Off entirely when nothing will upload them.
		sourcemap: uploadSourcemaps ? "hidden" : false,
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
