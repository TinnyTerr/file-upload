import type { DriveItem } from "./items";

/** Specific enough to be worth a column. Anything unlisted falls back to the
 * subtype ("x-tar" → "TAR file") or the extension. */
const NAMED: Record<string, string> = {
	"application/pdf": "PDF document",
	"application/json": "JSON file",
	"application/zip": "ZIP archive",
	"application/x-tar": "TAR archive",
	"application/gzip": "GZIP archive",
	"application/x-7z-compressed": "7z archive",
	"application/vnd.rar": "RAR archive",
	"application/octet-stream": "File",
	"text/plain": "Text document",
	"text/markdown": "Markdown document",
	"text/csv": "CSV file",
	"text/html": "HTML document",
	"image/jpeg": "JPEG image",
	"image/png": "PNG image",
	"image/gif": "GIF image",
	"image/webp": "WebP image",
	"image/svg+xml": "SVG image",
	"image/avif": "AVIF image",
	"video/mp4": "MP4 video",
	"video/webm": "WebM video",
	"video/x-matroska": "Matroska video",
	"video/quicktime": "QuickTime video",
	"audio/mpeg": "MP3 audio",
	"audio/flac": "FLAC audio",
	"audio/ogg": "Ogg audio",
	"audio/wav": "WAV audio",
};

function fromExtension(filename: string): string | null {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0 || dot === filename.length - 1) return null;
	return `${filename.slice(dot + 1).toUpperCase()} file`;
}

/** What the "Type" column shows. */
export function typeLabel(item: DriveItem): string {
	if (item.kind === "folder") return "Folder";

	const ct = (item.file.content_type ?? "").toLowerCase().split(";")[0]!.trim();
	const named = NAMED[ct];
	// `application/octet-stream` is what the server stores for anything it
	// wouldn't serve inline, so the filename is more informative than the type.
	if (named && ct !== "application/octet-stream") return named;

	const byExt = fromExtension(item.file.original_filename);
	if (byExt) return byExt;
	if (named) return named;

	const [top, sub] = ct.split("/");
	if (sub) return `${sub.replace(/^x-|\+.*$/g, "").toUpperCase()} file`;
	if (top) return `${top} file`;
	return "File";
}
