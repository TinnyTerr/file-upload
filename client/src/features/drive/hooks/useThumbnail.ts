import type { FileObject } from "@/features/files/types";
import type { DriveItem } from "../lib/items";

/**
 * Whether `GET /file/:slug/thumbnail` will actually answer for this file.
 *
 * Every condition the public route enforces is visible on the row, so this is
 * checked here rather than firing a request per file and collecting 403s:
 *
 * - the link must be active and **unlimited** — a limited link's thumbnail is
 *   refused on purpose, so a preview can't spend a use;
 * - the file must be plaintext (`none`), because the thumbnailer needs to read
 *   the bytes;
 * - it must not be compressed or archived, for the same reason.
 *
 * Files uploaded into a folder always pass the link test: the finalize path
 * mints their link with `max_uses = null`.
 */
function thumbnailSlug(file: FileObject): string | null {
	if (file.encryption_mode !== "none") return null;
	if (file.compressed || file.archived) return null;
	const ct = (file.content_type ?? "").toLowerCase();
	// The server only renders images and (with ffmpeg) video frames; asking for
	// anything else is a guaranteed round trip to a 415.
	if (!ct.startsWith("image/") && !ct.startsWith("video/")) return null;
	const link = file.links.find((l) => l.active && l.max_uses === null);
	return link ? link.slug : null;
}

export function useThumbnail(item: DriveItem): string | null {
	if (item.kind === "folder") return null;
	const slug = thumbnailSlug(item.file);
	return slug ? `/api/file/${slug}/thumbnail` : null;
}
