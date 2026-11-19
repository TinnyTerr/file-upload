/** Registers `/sw.js` (client/public/sw.js): an offline / server-unreachable
 * fallback for page navigations. Production only, so Vite's dev server and HMR
 * never sit behind a worker. Failure (plain http on a non-localhost origin, a
 * webview without service workers) just leaves the browser's own error page. */
export function registerServiceWorker(): void {
	if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {});
	});
}
