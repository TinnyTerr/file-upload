/**
 * Serves docs/api.md -- the single source of truth for the public API
 * reference. The SPA's /api-docs page fetches and renders this same file, so
 * there is exactly one copy of the documentation to keep current.
 *
 * Auth is session-or-API-key (requireReadUser): the docs describe this
 * deployment's surface and aren't handed to anonymous crawlers.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { requireReadUser } from "../middleware/deps.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "api.md");

const log = getLogger("routes.docs");

let cached: { mtimeMs: number; text: string } | null = null;

/** Reads the doc, re-reading only when it changes on disk so editing the
 * markdown under `bun --watch` shows up without a restart. */
function loadDoc(): string {
	const mtimeMs = statSync(DOC_PATH).mtimeMs;
	if (cached && cached.mtimeMs === mtimeMs) return cached.text;
	const text = readFileSync(DOC_PATH, "utf8");
	cached = { mtimeMs, text };
	return text;
}

/** The doc ships with {{BASE_URL}} / {{WS_BASE_URL}} placeholders so its
 * examples are copy-pasteable against whatever origin this node answers on. */
function render(text: string, baseUrl: string): string {
	const wsBase = baseUrl.replace(/^http/, "ws");
	return text
		.replaceAll("{{WS_BASE_URL}}", wsBase)
		.replaceAll("{{BASE_URL}}", baseUrl);
}

export function docsRouter(state: AppState): Router {
	const router = Router();

	router.get("/docs.md", requireReadUser(state), (req, res) => {
		let doc: string;
		try {
			doc = loadDoc();
		} catch (err) {
			log.error(`api docs unavailable at ${DOC_PATH}: ${String(err)}`);
			throw new HttpError(500, "api documentation unavailable");
		}
		const baseUrl = `${req.protocol}://${req.get("host")}`;
		res.type("text/markdown; charset=utf-8");
		res.set("Cache-Control", "no-cache");
		res.send(render(doc, baseUrl));
	});

	return router;
}
