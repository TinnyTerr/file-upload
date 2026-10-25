type SentryModule = typeof import("@sentry/react");

/** No DSN (SENTRY_DSN_WEB unset at build time) = Sentry off, calls are no-ops. */
const enabled = Boolean(__SENTRY_DSN__);

/** Share links carry secrets in the query (`?ek=`, `?k=`) and fragment
 * (`#ek=`); none of it may leave the browser. */
function scrub(url: string): string {
	return url
		.replace(/#.*$/, "")
		.replace(/([?&](?:ek|k)=)[^&]*/g, "$1[redacted]");
}

let sentry: SentryModule | null = null;
/** Errors raised before the SDK finishes loading; flushed once it has. */
const pending: [unknown, Record<string, unknown> | undefined][] = [];

/** Loads the SDK off the critical path: it is ~200 kB that nothing needs
 * before first paint. Errors thrown in the meantime are queued, not lost. */
export function initSentry(): void {
	if (!enabled) return;
	const load = () =>
		import("@sentry/react").then((Sentry) => {
			Sentry.init({
				dsn: __SENTRY_DSN__,
				environment: import.meta.env.MODE,
				beforeSend(event) {
					if (event.request?.url) event.request.url = scrub(event.request.url);
					return event;
				},
				beforeBreadcrumb(crumb) {
					if (typeof crumb.data?.url === "string")
						crumb.data.url = scrub(crumb.data.url);
					if (typeof crumb.data?.to === "string")
						crumb.data.to = scrub(crumb.data.to);
					if (typeof crumb.data?.from === "string")
						crumb.data.from = scrub(crumb.data.from);
					return crumb;
				},
			});
			sentry = Sentry;
			for (const [e, extra] of pending.splice(0))
				Sentry.captureException(e, { extra });
		});
	if (document.readyState === "complete") void load();
	else window.addEventListener("load", () => void load(), { once: true });
}

export function captureException(
	error: unknown,
	extra?: Record<string, unknown>,
): void {
	if (!enabled) return;
	if (sentry) sentry.captureException(error, { extra });
	else if (pending.length < 50) pending.push([error, extra]);
}
