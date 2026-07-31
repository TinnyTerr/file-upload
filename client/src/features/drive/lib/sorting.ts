import type { SortDir, SortKey } from "../hooks/useExplorerPrefs";
import type { DriveItem } from "./items";

/** `numeric` is what makes `file10` sort after `file9` instead of after `file1`,
 * which is the single most noticeable difference between a file manager that
 * feels right and one that doesn't. */
const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

function name(item: DriveItem): string {
	return item.kind === "folder" ? item.dir.title : item.file.original_filename;
}

function createdAt(item: DriveItem): string {
	return item.kind === "folder" ? item.dir.created_at : item.file.created_at;
}

/** A folder's "size" is what it contains; sorting by it is more useful than
 * treating every folder as zero. */
function size(item: DriveItem): number {
	return item.kind === "folder" ? item.dir.total_bytes : item.file.size_bytes;
}

function typeLabelFor(item: DriveItem): string {
	return item.kind === "folder" ? "" : (item.file.content_type ?? "");
}

function compare(a: DriveItem, b: DriveItem, key: SortKey): number {
	switch (key) {
		case "name":
			return collator.compare(name(a), name(b));
		case "date":
			// ISO8601 UTC strings throughout, so lexicographic is chronological.
			return createdAt(a).localeCompare(createdAt(b));
		case "size":
			return size(a) - size(b);
		case "type":
			return (
				collator.compare(typeLabelFor(a), typeLabelFor(b)) ||
				collator.compare(name(a), name(b))
			);
	}
}

/**
 * Sorts a level for display. Pure and client-side: the backend returns one
 * level at a time with no sort parameters, and a level is bounded by what a
 * person put in a folder, so sorting it here costs nothing and avoids the
 * pagination contract that server-side sorting would drag in.
 */
export function sortItems(
	items: DriveItem[],
	key: SortKey,
	dir: SortDir,
	foldersFirst: boolean,
): DriveItem[] {
	const sign = dir === "asc" ? 1 : -1;
	return [...items].sort((a, b) => {
		if (foldersFirst && a.kind !== b.kind) {
			return a.kind === "folder" ? -1 : 1;
		}
		const result = compare(a, b, key);
		// Name is the tiebreak for everything else, always ascending -- two files
		// of the same size flipping order between renders looks like a bug.
		return result !== 0 ? result * sign : collator.compare(name(a), name(b));
	});
}
