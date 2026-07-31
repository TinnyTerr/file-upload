import type { Directory } from "@/features/directories/types";
import type { FileObject } from "@/features/files/types";
import type { DriveChildren } from "../types";

/** One row in the explorer. Folders and files are selected, moved and deleted
 * through the same code paths, so they share one shape everywhere except where
 * the underlying endpoint genuinely differs. */
export type DriveItem =
	| { kind: "folder"; id: number; dir: Directory }
	| { kind: "file"; id: number; file: FileObject };

/** Stable across renders and unique across the two id spaces. */
export function itemKey(item: DriveItem): string {
	return `${item.kind}:${item.id}`;
}

export function itemName(item: DriveItem): string {
	return item.kind === "folder" ? item.dir.title : item.file.original_filename;
}

/** Display order, which is also the order shift-click ranges run in. */
export function itemsOf(data: DriveChildren | undefined): DriveItem[] {
	if (!data) return [];
	return [
		...data.directories.map(
			(dir): DriveItem => ({ kind: "folder", id: dir.id, dir }),
		),
		...data.files.map(
			(file): DriveItem => ({ kind: "file", id: file.id, file }),
		),
	];
}

/** MIME type for the internal drag payload. Using a custom type (rather than
 * text/plain) is what lets a folder tile tell "an item from this page" apart
 * from "files dragged in from the desktop". */
export const DRIVE_DRAG_TYPE = "application/x-fileupload-drive-items";

export function serializeDrag(items: DriveItem[]): string {
	return JSON.stringify(items.map((i) => ({ kind: i.kind, id: i.id })));
}

export function parseDrag(
	raw: string,
): { kind: "folder" | "file"; id: number }[] {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(p): p is { kind: "folder" | "file"; id: number } =>
				(p?.kind === "folder" || p?.kind === "file") && Number.isInteger(p?.id),
		);
	} catch {
		return [];
	}
}
