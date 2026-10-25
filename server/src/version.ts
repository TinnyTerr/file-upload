import { execFileSync } from "node:child_process";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

/** `<package version>+<short git sha>`, e.g. `0.1.0+8dfd1dd`. Resolved once at
 * boot; the sha is omitted when git or the checkout isn't there (a container
 * image, say) and `BUILD_SHA` can supply it instead. */
function resolveSha(): string {
	const env = process.env.BUILD_SHA?.trim();
	if (env) return env.slice(0, 12);
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: join(import.meta.dir, "..", ".."),
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		})
			.toString()
			.trim();
	} catch {
		return "";
	}
}

const sha = resolveSha();
export const BUILD_VERSION = sha ? `${pkg.version}+${sha}` : pkg.version;

/** The Sentry release, shared by server events and the client bundle (which
 * computes the same string in client/vite.config.ts), so one release holds
 * both surfaces and its commits. */
export const SENTRY_RELEASE = `fileupload@${BUILD_VERSION}`;
