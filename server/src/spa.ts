import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Mirrors app/spa.py -- reads the built SPA shell fresh on each request (no
 * caching) so a `bun run build` is picked up without restarting the server. */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SPA_DIR = join(REPO_ROOT, "public");
const SPA_INDEX = join(SPA_DIR, "index.html");

export function renderSpa(meta = ""): string {
	const html = readFileSync(SPA_INDEX, "utf-8");
	if (meta) return html.replace("</head>", `${meta}\n</head>`);
	return html;
}
