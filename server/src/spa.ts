import { readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { getLogger } from "./logging.ts";

/** Serving of the built React SPA: the shell, its static assets, and the
 * HTML error page shown when a request can't reach the shell at all.
 *
 * The shell is read off disk and cached against its mtime+size, so a
 * `bun run build` is still picked up without restarting the server, but a
 * hot public page no longer costs a synchronous read per request. */
const REPO_ROOT = join(import.meta.dir, "..", "..");
export const SPA_DIR = join(REPO_ROOT, "public");
const SPA_INDEX = join(SPA_DIR, "index.html");
const ASSETS_DIR = join(SPA_DIR, "assets");

const log = getLogger("app.spa");

let cached: { mtimeMs: number; size: number; html: string } | null = null;

/** The built shell, or null when the client hasn't been built. */
function shell(): string | null {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(SPA_INDEX);
	} catch {
		cached = null;
		return null;
	}
	if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
		cached = {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			html: readFileSync(SPA_INDEX, "utf-8"),
		};
	}
	return cached.html;
}

/** Whether a built client exists to serve. */
export function spaAvailable(): boolean {
	return shell() !== null;
}

/** Tags every public share page carries, independent of what it's sharing --
 * `og:site_name` so a Discord/Slack/iMessage embed names the app rather than
 * just showing a bare title, `theme-color` for the accent strip those clients
 * draw down the side of the card. Approximates `--brand-from` from
 * client/src/index.css; exact oklch->hex conversion isn't worth doing here for
 * one meta tag. */
export function siteMetaTags(): string {
	return [
		'<meta property="og:site_name" content="fileupload">',
		'<meta name="theme-color" content="#4ea37a">',
	].join("\n");
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** The shell with `meta` (already-escaped og/twitter tags) injected into
 * <head>, or the error page when there is no build to inject into. */
export function renderSpa(meta = ""): string {
	const html = shell();
	if (html === null) return renderErrorPage(NOT_BUILT);
	if (meta) return html.replace("</head>", `${meta}\n</head>`);
	return html;
}

/**
 * Sends the SPA shell for an HTML navigation. Caller-set headers (the public
 * routes set their own security headers) survive; this only fills in the
 * content type, the cache policy and the status.
 *
 * `no-cache` — not `no-store` — is deliberate: the shell must be revalidated on
 * every navigation so a deploy's new asset hashes are picked up, but a 304 is
 * still allowed to save the body.
 */
export function sendSpa(res: Response, meta = ""): void {
	const html = shell();
	if (html === null) {
		sendErrorPage(res, NOT_BUILT);
		return;
	}
	res.status(200);
	res.set({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.send(meta ? html.replace("</head>", `${meta}\n</head>`) : html);
}

// --------------------------------------------------------------------------
// Error page
// --------------------------------------------------------------------------

export interface ErrorPageSpec {
	status: number;
	/** Short line under the status code, e.g. "Page not found". */
	title: string;
	/** One or two sentences of explanation. */
	detail: string;
	/** Optional operator-facing hint, rendered in a monospace note. */
	hint?: string;
}

const NOT_BUILT: ErrorPageSpec = {
	status: 503,
	title: "The app isn't built yet",
	detail:
		"The server is running, but there is no compiled client to serve. Build it and reload this page.",
	hint: "bun run build",
};

const NOT_FOUND: ErrorPageSpec = {
	status: 404,
	title: "Page not found",
	detail: "That address doesn't match anything on this server.",
};

const SERVER_ERROR: ErrorPageSpec = {
	status: 500,
	title: "Something went wrong",
	detail:
		"The server hit an unexpected error handling this request. It has been logged.",
};

/**
 * A standalone HTML error page.
 *
 * Deliberately self-contained — inline CSS, no script, no asset requests. It is
 * shown exactly when the SPA can't be trusted to render (no build, an unknown
 * URL, a thrown 500), so it must not depend on the bundle it is standing in
 * for. The palette mirrors `client/src/index.css`'s tokens so the page doesn't
 * look like a different product, and it follows the OS theme because there is
 * no React to read the saved preference.
 */
export function renderErrorPage(spec: ErrorPageSpec): string {
	const title = escapeHtml(spec.title);
	const detail = escapeHtml(spec.detail);
	const hint = spec.hint
		? `<p class="hint"><code>${escapeHtml(spec.hint)}</code></p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${spec.status} — ${title}</title>
<style>
:root {
	--bg: oklch(0.19 0.006 205);
	--fg: oklch(0.91 0.006 110);
	--muted: oklch(0.68 0.01 110);
	--card: oklch(0.23 0.008 205);
	--border: oklch(0.34 0.008 205);
	--from: oklch(0.64 0.08 155);
	--to: oklch(0.74 0.07 82);
	color-scheme: dark;
}
@media (prefers-color-scheme: light) {
	:root {
		--bg: oklch(0.97 0.003 110);
		--fg: oklch(0.18 0.008 205);
		--muted: oklch(0.45 0.012 205);
		--card: oklch(1 0 0);
		--border: oklch(0.82 0.006 205);
		--from: oklch(0.52 0.1 155);
		--to: oklch(0.65 0.08 82);
		color-scheme: light;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	min-height: 100dvh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 1.5rem;
	background: var(--bg);
	color: var(--fg);
	font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	-webkit-font-smoothing: antialiased;
}
main {
	max-width: 32rem;
	width: 100%;
	padding: 2.5rem 2rem;
	border: 1px solid var(--border);
	border-radius: 0.75rem;
	background: var(--card);
	text-align: center;
}
.code {
	font-size: 3rem;
	font-weight: 800;
	line-height: 1;
	letter-spacing: -0.03em;
	background-image: linear-gradient(100deg, var(--from), var(--to));
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}
h1 { margin: 0.75rem 0 0; font-size: 1.125rem; font-weight: 600; }
p { margin: 0.5rem 0 0; font-size: 0.875rem; color: var(--muted); }
.hint code {
	display: inline-block;
	margin-top: 0.25rem;
	padding: 0.25rem 0.5rem;
	border-radius: 0.375rem;
	border: 1px solid var(--border);
	font-family: ui-monospace, Menlo, Consolas, monospace;
	font-size: 0.8125rem;
}
a {
	display: inline-block;
	margin-top: 1.5rem;
	padding: 0.5rem 1.25rem;
	border-radius: 0.5rem;
	background-image: linear-gradient(100deg, var(--from), var(--to));
	color: #fff;
	font-size: 0.875rem;
	font-weight: 500;
	text-decoration: none;
}
</style>
</head>
<body>
<main>
	<div class="code">${spec.status}</div>
	<h1>${title}</h1>
	<p>${detail}</p>
	${hint}
	<a href="/">Go home</a>
</main>
</body>
</html>
`;
}

/** Renders `spec` as HTML, or as the usual `{detail}` JSON for a client that
 * didn't ask for HTML (an API caller, a fetch(), curl). */
export function sendErrorPage(res: Response, spec: ErrorPageSpec): void {
	res.status(spec.status);
	if (!wantsHtml(res.req)) {
		res.json({ detail: spec.detail });
		return;
	}
	res.set({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.send(renderErrorPage(spec));
}

/** True for a browser navigation, false for fetch/XHR/curl. `Accept` is the
 * only signal available here: a browser navigation asks for `text/html`, while
 * a bare `fetch()` sends the catch-all accept header and gets JSON. */
function wantsHtml(req: Request): boolean {
	const accept = req.headers.accept ?? "";
	return accept.includes("text/html");
}

// --------------------------------------------------------------------------
// Mounting
// --------------------------------------------------------------------------

/** A last path segment carrying a file extension — `/assets/index-a1b2.js`,
 * `/favicon.ico`. No SPA route looks like this, so a request that reaches the
 * fallback with one is a *missing file*: answering it with the HTML shell
 * would hand a script tag 200 OK and a page of HTML, which surfaces as an
 * inscrutable syntax error in the console instead of a 404 in the network tab. */
const LOOKS_LIKE_A_FILE = /\/[^/]+\.[a-zA-Z0-9]{1,8}$/;

/**
 * Mounts static assets + the SPA fallback. Must be mounted after every
 * `/api/*` router, and the fallback deliberately refuses to answer `/api/*` at
 * all — an unknown API path is a 404 in JSON, never a page of HTML.
 */
export function mountSpa(app: Express): void {
	if (!spaAvailable()) {
		log.warning(
			`no built client at ${SPA_DIR} -- API routes work, page requests will 503 until \`bun run build\` runs`,
		);
	}

	app.use(
		express.static(SPA_DIR, {
			// `/` is served by the fallback below instead, so the shell goes out
			// with one consistent set of headers no matter which path asked for it.
			index: false,
			redirect: false,
			dotfiles: "ignore",
			setHeaders(res, filePath) {
				const rel = relative(ASSETS_DIR, filePath);
				const inAssets =
					rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
				// Everything under assets/ is content-hashed by Vite, so it can be
				// cached forever; anything else (the shell, favicons) must be
				// revalidated or a deploy is invisible to an existing client.
				res.setHeader(
					"Cache-Control",
					inAssets ? "public, max-age=31536000, immutable" : "no-cache",
				);
			},
		}),
	);

	app.use((req: Request, res: Response, next: NextFunction) => {
		// Unknown /api/* never renders a page. Let it fall through to the JSON
		// 404 that app.ts registers.
		if (req.path === "/api" || req.path.startsWith("/api/")) return next();
		if (req.method !== "GET" && req.method !== "HEAD") {
			sendErrorPage(res, NOT_FOUND);
			return;
		}
		if (LOOKS_LIKE_A_FILE.test(req.path)) {
			sendErrorPage(res, NOT_FOUND);
			return;
		}
		if (!wantsHtml(req)) {
			// A non-browser client asking for a client-side route by name gets an
			// honest 404 rather than a body of HTML it can't parse.
			sendErrorPage(res, NOT_FOUND);
			return;
		}
		// Anything else is a client-side route: hand over the shell and let the
		// router decide, including rendering its own 404 page.
		sendSpa(res);
	});
}

/** The error-page spec for an unhandled server error, for app.ts's handler. */
export const SERVER_ERROR_PAGE = SERVER_ERROR;
