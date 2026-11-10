import { isPrivateRoute, isSecretRoute, scrubUrl } from "./scrubUrl";

type SentryModule = typeof import("@sentry/react");

/** No DSN (SENTRY_DSN_WEB unset at build time) = Sentry off, calls are no-ops. */
const enabled = Boolean(__SENTRY_DSN__);

let sentry: SentryModule | null = null;
/** Errors raised before the SDK finishes loading; flushed once it has. */
const pending: [unknown, Record<string, unknown> | undefined][] = [];
let pendingUser: { id: string } | null = null;

/** Loads the SDK off the critical path: it is ~450 kB that nothing needs
 * before first paint. Errors thrown in the meantime are queued, not lost. */
export function initSentry(): void {
	if (!enabled) return;
	const load = () =>
		import("@sentry/react").then((Sentry) => {
			Sentry.init({
				dsn: __SENTRY_DSN__,
				// Relayed by the server: same-origin for the CSP, and not a
				// recognisable ingest host for ad blockers.
				tunnel: "/api/sentry-tunnel",
				// Same string the server reports (server/src/version.ts), so one
				// release holds both surfaces and the commits behind them.
				release: __SENTRY_RELEASE__,
				environment: import.meta.env.MODE,

				// Traces. Propagated to this origin only: the sentry-trace header must
				// not leak to anything else, and CORS would reject it anyway.
				tracesSampleRate: __SENTRY_TRACES_RATE__,
				tracePropagationTargets: [window.location.origin, /^\//],
				integrations: [
					Sentry.browserTracingIntegration({
						// Covers pageload and navigation: the span is named from the URL,
						// which for a share page would be the credential.
						beforeStartSpan: (ctx) => ({ ...ctx, name: scrubUrl(ctx.name) }),
					}),
					// Replay policy. Only admins can open Sentry, and they can already see
					// every filename in the admin Files tab, so text (filenames, labels,
					// errors) is recorded as-is. Hidden:
					//  - every input value (passwords, codes, search boxes, key fields)
					//  - all media: file contents, thumbnails, avatars
					//  - anything tagged `data-sentry-mask`: usernames, IPs, the admin
					//    users tab, permission/key dialogs, API keys, E2E keys
					//  - whole pages: login, account/MFA, OAuth consent (isPrivateRoute),
					//    and share/receive links whose URL is the credential
					Sentry.replayIntegration({
						maskAllText: false,
						maskAllInputs: true,
						blockAllMedia: true,
						mask: ["[data-sentry-mask]"],
						beforeAddRecordingEvent: (event) =>
							isSecretRoute(location.pathname, location.search) ||
							isPrivateRoute(location.pathname)
								? null
								: event,
					}),
					// No floating button: opened from the user menu (openFeedback). The sync
					// variant bundles the modal and screenshot code; the lazy one fetches it
					// from browser.sentry-cdn.com, which the page CSP blocks.
					Sentry.feedbackSyncIntegration({
						autoInject: false,
						colorScheme: "system",
						isNameRequired: false,
						isEmailRequired: false,
						enableScreenshot: true,
					}),
				],
				// Thrown from `<anonymous code>`: a browser extension or userscript
				// redefining Symbol.hasInstance, never our bundle.
				ignoreErrors: [/non-configurable property Symbol\.hasInstance/],
				replaysSessionSampleRate: __SENTRY_REPLAY_RATE__,
				replaysOnErrorSampleRate: 1,

				beforeSend(event) {
					if (event.request?.url)
						event.request.url = scrubUrl(event.request.url);
					return event;
				},
				beforeSendSpan(span) {
					span.name = scrubUrl(span.name);
					const attrs = span.attributes as Record<string, unknown>;
					for (const key of ["url.full", "http.url", "url.path"]) {
						const a = attrs[key];
						if (typeof a === "string") attrs[key] = scrubUrl(a);
						else if (a && typeof (a as { value?: unknown }).value === "string")
							(a as { value: string }).value = scrubUrl(
								(a as { value: string }).value,
							);
					}
					return span;
				},
				beforeBreadcrumb(crumb) {
					for (const key of ["url", "to", "from"] as const) {
						const v = crumb.data?.[key];
						if (typeof v === "string" && crumb.data)
							crumb.data[key] = scrubUrl(v);
					}
					return crumb;
				},
			});
			sentry = Sentry;
			if (pendingUser) Sentry.setUser(pendingUser);
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

/** Ties events, replays and feedback to an account by id only -- no name,
 * email or IP. `null` on sign-out. */
export function setSentryUser(id: number | null): void {
	if (!enabled) return;
	pendingUser = id === null ? null : { id: String(id) };
	sentry?.setUser(pendingUser);
}

/** Whether the "Send feedback" entry should be offered at all. */
export const feedbackAvailable = enabled;

/** Opens Sentry's feedback form (with a screenshot option). */
export async function openFeedback(): Promise<void> {
	if (!enabled) return;
	const Sentry = sentry ?? (await import("@sentry/react"));
	const form = await Sentry.getFeedback()?.createForm();
	form?.appendToDom();
	form?.open();
}

/** Whether the manual "upload replay" action can do anything. */
export const replayAvailable = enabled;

/**
 * Forces the buffered session replay (the last ~60s, masked like every other
 * replay) to upload now instead of waiting for an error. Resolves to the
 * replay id, or null if Sentry/replay isn't running.
 */
export async function uploadReplay(): Promise<string | null> {
	if (!enabled) return null;
	const Sentry = sentry ?? (await import("@sentry/react"));
	const replay = Sentry.getReplay();
	if (!replay) return null;
	// In buffer mode flush() switches to session mode and sends what's held.
	await replay.flush();
	const id = replay.getReplayId() ?? null;
	if (id) {
		Sentry.captureMessage("Manual replay upload", {
			level: "info",
			tags: { manual_replay: "1" },
		});
	}
	return id;
}
