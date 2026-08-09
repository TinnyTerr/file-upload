import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { configValue } from "../config.ts";

/** Mirrors app/storage/paths.py. */

export function storageRoot(): string {
	return configValue("FILEUPLOAD_STORAGE") || "./data/storage";
}

export function thumbnailRoot(): string {
	return configValue("FILEUPLOAD_THUMBNAILS") || "./data/thumbnails";
}

/** Staging area for Real-Debrid downloads: files land under
 * `<root>/<job tag>/` and are deleted once imported. qBittorrent jobs use
 * TORRENT_CONTENT_PATH instead -- that directory belongs to qBittorrent, this
 * one is ours. */
export function debridRoot(): string {
	return configValue("FILEUPLOAD_DEBRID") || "./data/debrid";
}

/** Random fan-out path relative to the storage root, e.g. "ab/cd/…". */
export function newInternalRelPath(): string {
	const rand = randomBytes(32).toString("hex");
	return join(rand.slice(0, 2), rand.slice(2, 4), rand.slice(4));
}

/** Join `rel` under `root`, refusing traversal outside the root. */
export function safeJoin(root: string, rel: string): string {
	const resolvedRoot = resolve(root);
	const target = resolve(root, rel);
	if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
		throw new Error(`path traversal: ${JSON.stringify(rel)}`);
	}
	return target;
}
