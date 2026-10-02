import * as Sentry from "@sentry/browser";

/** Desktop DSN (SENTRY_DSN_DESKTOP in the repo-root .env), injected by
 * vite.config.ts. Unset = Sentry off. The Rust side reports its own panics
 * under the same DSN (src-tauri/build.rs). */
declare const __SENTRY_DSN__: string;

if (__SENTRY_DSN__) {
	Sentry.init({
		dsn: __SENTRY_DSN__,
		// The webview is serving a local origin; the interesting URL is the
		// user's server, which is not ours to report.
		beforeSend(event) {
			delete event.request;
			return event;
		},
	});
}

export function captureException(error: unknown): void {
	if (__SENTRY_DSN__) Sentry.captureException(error);
}
