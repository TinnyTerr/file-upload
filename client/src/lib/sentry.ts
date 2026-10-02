import * as Sentry from "@sentry/react";

/** No DSN (SENTRY_DSN_WEB unset at build time) = Sentry off, calls are no-ops. */
const enabled = Boolean(__SENTRY_DSN__);

/** Share links carry secrets in the query (`?ek=`, `?k=`) and fragment
 * (`#ek=`); none of it may leave the browser. */
function scrub(url: string): string {
	return url
		.replace(/#.*$/, "")
		.replace(/([?&](?:ek|k)=)[^&]*/g, "$1[redacted]");
}

export function initSentry(): void {
	if (!enabled) return;
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
}

export function captureException(
	error: unknown,
	extra?: Record<string, unknown>,
): void {
	if (enabled) Sentry.captureException(error, { extra });
}
