/**
 * The API reference, baked into the bundle at build time.
 *
 * `docs/api.md` is still the single source of truth and `GET /api/docs.md`
 * still serves it raw for LLM/tooling consumption -- but the in-app page reads
 * this copy instead of fetching that endpoint, so it renders on first paint
 * with no request and no loading state.
 *
 * The document ships with {{BASE_URL}} / {{WS_BASE_URL}} placeholders so its
 * examples are copy-pasteable against whatever origin serves it. The backend
 * substitutes them as it serves the markdown; here that job is done once at
 * module load from the page's own origin, which is the same value.
 */

import rawApiDocs from "@docs/api.md?raw";

function substituteOrigin(text: string): string {
	const baseUrl =
		typeof window === "undefined"
			? ""
			: window.location.origin.replace(/\/$/, "");
	return text
		.replaceAll("{{WS_BASE_URL}}", baseUrl.replace(/^http/, "ws"))
		.replaceAll("{{BASE_URL}}", baseUrl);
}

/** The full document, origin substituted. */
export const apiDocsMarkdown: string = substituteOrigin(rawApiDocs);

/** The body without its leading h1 -- the page header already says it. */
export const apiDocsBody: string = apiDocsMarkdown.replace(/^#\s+.*\n/, "");
