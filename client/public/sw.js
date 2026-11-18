/* Offline / unreachable-server fallback for page navigations.
 *
 * Only top-level navigations outside /api are touched. Everything else
 * (API calls, chunked uploads, ranged downloads, media streams, websockets)
 * never reaches respondWith, so the browser handles it exactly as without a
 * worker. /api/* navigations are skipped too: /api/file/:slug/raw is a direct
 * download and must not be piped through the worker.
 *
 * Nothing is cached. The fallback page is built here, so it cannot go stale
 * relative to the worker and needs no Cache Storage housekeeping. Served
 * no-cache from the repo-root public/, so the browser picks up a new version
 * on the next navigation.
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			if (self.registration.navigationPreload) {
				await self.registration.navigationPreload.enable();
			}
			await self.clients.claim();
		})(),
	);
});

/** Gateway statuses a reverse proxy answers with when the app is down. The
 * app's own 503 (client not built) is HTML and is passed through. */
function isProxyFailure(res) {
	if (res.status === 502 || res.status === 504) return true;
	if (res.status !== 503) return false;
	return !(res.headers.get("content-type") ?? "").includes("text/html");
}

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.mode !== "navigate" || req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

	event.respondWith(
		(async () => {
			try {
				const res = (await event.preloadResponse) ?? (await fetch(req));
				if (isProxyFailure(res)) return fallback(res.status);
				return res;
			} catch {
				return fallback(0);
			}
		})(),
	);
});

/** status 0 = the network request itself failed. */
function fallback(status) {
	const offline = status === 0 || !self.navigator.onLine;
	const code = offline ? "Offline" : String(status);
	const title = offline ? "No connection" : "Server unreachable";
	const detail = offline
		? "This device can't reach the network. The page reloads when the connection returns."
		: "The server isn't responding. Retrying automatically.";
	return new Response(page(code, title, detail, offline), {
		status: 503,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

/* Palette mirrors client/src/index.css and server/src/spa.ts renderErrorPage. */
function page(code, title, detail, offline) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${title}</title>
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
button {
	margin-top: 1.5rem;
	padding: 0.5rem 1.25rem;
	border: 0;
	border-radius: 0.5rem;
	background-image: linear-gradient(100deg, var(--from), var(--to));
	color: #fff;
	font: inherit;
	font-size: 0.875rem;
	font-weight: 500;
	cursor: pointer;
}
</style>
</head>
<body>
<main>
	<div class="code">${code}</div>
	<h1>${title}</h1>
	<p>${detail}</p>
	<button type="button" onclick="location.reload()">Retry</button>
</main>
<script>
${offline ? 'addEventListener("online", () => location.reload());' : "setTimeout(() => location.reload(), 10000);"}
</script>
</body>
</html>
`;
}
