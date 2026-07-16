import { randomBytes } from "node:crypto";
import { resolve, sep, join } from "node:path";

/** Mirrors app/storage/paths.py. */

export function storageRoot(): string {
  return process.env.FILEUPLOAD_STORAGE || "./data/storage";
}

export function thumbnailRoot(): string {
  return process.env.FILEUPLOAD_THUMBNAILS || "./data/thumbnails";
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
