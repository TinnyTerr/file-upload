import { existsSync, readFileSync } from "node:fs";
import * as Sentry from "@sentry/bun";
import { SENTRY_RELEASE } from "./version.ts";

/**
 * Sentry for the server. Imported first in `index.ts` so uncaught exceptions
 * and unhandled rejections are hooked before anything else loads.
 *
 * The DSN is `SENTRY_DSN_SERVER` from the repo-root `.env` (web and desktop
 * have their own keys in the same file). Bun only auto-loads a `.env` from its
 * cwd and the server runs from `server/`, so the root file is read here. The
 * process environment wins over the file, like everywhere else.
 *
 * No DSN = Sentry is off and every call below is a no-op. This deliberately
 * does not go through `configValue()`: it is not a node setting and must never
 * be written to or replicated from `app.env`.
 */
function rootEnvValue(key: string): string | undefined {
	for (const path of ["../.env", ".env"]) {
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
			if (m?.[1] === key) return m[2]?.replace(/^(['"])(.*)\1$/, "$2");
		}
	}
	return undefined;
}

const envValue = (key: string) => process.env[key] ?? rootEnvValue(key);

const dsn = envValue("SENTRY_DSN_SERVER");

export const sentryEnabled = Boolean(dsn);

/** The browser DSN's origin, for the page CSP's `connect-src` -- without it
 * the browser blocks every event the client tries to send. Empty = web
 * reporting is off. */
export function sentryWebConnectOrigin(): string {
	const web = envValue("SENTRY_DSN_WEB");
	if (!web) return "";
	try {
		return new URL(web).origin;
	} catch {
		return "";
	}
}

/** Where the browser tunnel forwards: the ingest envelope endpoint for
 * `SENTRY_DSN_WEB`, plus the DSN sans key/query to compare envelopes against. */
export function sentryWebEnvelopeUrl(): { url: string; dsnKey: string } | null {
	const web = envValue("SENTRY_DSN_WEB");
	if (!web) return null;
	try {
		const u = new URL(web);
		const project = u.pathname.replace(/^\/+/, "");
		return {
			url: `${u.origin}/api/${project}/envelope/?sentry_key=${u.username}`,
			dsnKey: u.origin + u.pathname,
		};
	} catch {
		return null;
	}
}

/** Share links carry their secret in the path (`/file/<slug>`, `/d/<slug>`,
 * dropbox tokens) and query (`?ek=`, `?k=`, `?receive=`). A trace or event
 * must show the route, not the credential. */
export function scrubPath(url: string): string {
	return url
		.replace(/#.*$/, "")
		.replace(/\/(api\/)?(file|d)\/[^/?#]+/g, "/$1$2/:slug")
		.replace(/\/(api\/)?dropbox\/[^/?#]+/g, "/$1dropbox/:token")
		.replace(/([?&](?:ek|k|receive)=)[^&]*/g, "$1[redacted]");
}

/** Paths that would drown the quota in transactions nobody will read: the 1 s
 * cluster firehose poll, health probes, websockets and static assets. */
const UNTRACED =
	/^\/(assets\/|api\/health|api\/ws\/|api\/admin\/cluster\/(firehose|events)|api\/cluster\/(heartbeat|events))/;

export function isTraced(path: string): boolean {
	return !UNTRACED.test(path);
}

const num = (key: string, fallback: number): number => {
	const n = Number(envValue(key));
	return envValue(key) !== undefined && Number.isFinite(n) ? n : fallback;
};

const tracesRate = num("SENTRY_TRACES_SAMPLE_RATE", 0.1);

if (dsn) {
	Sentry.init({
		dsn,
		release: SENTRY_RELEASE,
		environment: process.env.APP_ENV ?? "prod",
		// The SDK opens the root http.server span itself (and continues the
		// browser's sentry-trace); this only decides which requests are worth it.
		tracesSampler: ({ attributes, parentSampled }) => {
			const path = String(attributes?.["url.path"] ?? "");
			if (path && !isTraced(path)) return 0;
			return parentSampled ?? tracesRate;
		},
		// Structured logs are on by default in v11 (forwarded from logging.ts at
		// WARNING). They only carry the log message, which is already redacted.
		// Request bodies, cookies and IPs stay out: this server handles
		// credentials and share-link secrets (?ek=).
		beforeSend(event) {
			if (event.request) {
				delete event.request.cookies;
				delete event.request.headers;
				delete event.request.data;
				if (event.request.url) event.request.url = scrubPath(event.request.url);
				delete event.request.query_string;
			}
			return event;
		},
		// Spans are streamed (v11 default), so this -- not beforeSendTransaction --
		// is where the raw request URL the SDK records gets redacted.
		beforeSendSpan(span) {
			span.name = scrubPath(span.name);
			// Attributes arrive raw (`"x"`) or typed (`{ value: "x" }`).
			const attrs = span.attributes as Record<string, unknown>;
			const rewrite = (key: string, fn: (v: string) => string) => {
				const a = attrs[key];
				if (typeof a === "string") attrs[key] = fn(a);
				else if (a && typeof (a as { value?: unknown }).value === "string") {
					(a as { value: string }).value = fn((a as { value: string }).value);
				}
			};
			for (const key of ["url.full", "url.path", "http.url", "http.target"]) {
				rewrite(key, scrubPath);
			}
			rewrite("url.query", () => "[redacted]");
			return span;
		},
		beforeSendLog(log) {
			log.message = scrubPath(String(log.message));
			return log;
		},
		beforeBreadcrumb(crumb) {
			if (typeof crumb.data?.url === "string")
				crumb.data.url = scrubPath(crumb.data.url);
			return crumb;
		},
	});
}

/** Runs `fn` inside a `db.query` span when a trace is active; otherwise it is
 * a plain call. The statement text (never its parameters) is the span name. */
export function dbSpan<T>(sql: string, fn: () => T): T {
	if (!dsn || !Sentry.getActiveSpan()) return fn();
	return Sentry.startSpan(
		{
			name: sql.replace(/\s+/g, " ").trim().slice(0, 200),
			op: "db.query",
			attributes: { "db.system": "sqlite" },
		},
		fn,
	);
}

export { Sentry };
