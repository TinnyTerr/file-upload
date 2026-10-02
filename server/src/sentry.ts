import { existsSync, readFileSync } from "node:fs";
import * as Sentry from "@sentry/bun";

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

const dsn = process.env.SENTRY_DSN_SERVER ?? rootEnvValue("SENTRY_DSN_SERVER");

export const sentryEnabled = Boolean(dsn);

if (dsn) {
	Sentry.init({
		dsn,
		environment: process.env.APP_ENV ?? "prod",
		// Request bodies, cookies and IPs stay out: this server handles
		// credentials and share-link secrets (?ek=).
		beforeSend(event) {
			if (event.request) {
				delete event.request.cookies;
				delete event.request.headers;
				delete event.request.data;
				if (event.request.url) {
					event.request.url = event.request.url.replace(
						/([?&](?:ek|k)=)[^&]*/g,
						"$1[redacted]",
					);
				}
				delete event.request.query_string;
			}
			return event;
		},
	});
}

export { Sentry };
