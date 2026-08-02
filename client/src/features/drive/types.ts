import type { Directory } from "@/features/directories/types";
import type { FileObject } from "@/features/files/types";

/** Where the explorer currently is. `"root"` is the literal id the backend
 * uses for "no containing folder", so it doubles as the URL segment. */
export type DriveLocation = number | "root";

export interface Breadcrumb {
	id: number;
	title: string;
}

/** How wide a read of the tree is: one level, one subtree, or everything the
 * caller can reach. Mirrors the backend's `scope` search parameter. */
export type DriveSearchScope = "level" | "subtree" | "all";

/** A response from `GET /directories`. At `scope=level` (the explorer's normal
 * fetch) this is one level of the tree and never a recursive dump; widening the
 * scope or passing `q` turns it into a result set, and every row then carries
 * the `path` it was found at. */
export interface DriveChildren {
	/** The folder being viewed, or null at the root / in an unscoped search. */
	directory: Directory | null;
	/** Root-first chain ending with `directory` itself; empty at the root. */
	breadcrumbs: Breadcrumb[];
	directories: (Directory & { path?: string[] })[];
	files: (FileObject & { path?: string[] })[];
	scope: DriveSearchScope;
	/** The search term that produced this, or null when just browsing. */
	query: string | null;
	/** Match counts before paging, so the UI can say "showing 50 of 300". */
	total: { directories: number; files: number };
	limit: number;
	offset: number;
}

export function parseLocation(param: string | undefined): DriveLocation {
	if (!param) return "root";
	const n = Number(param);
	return Number.isInteger(n) && n > 0 ? n : "root";
}

export function drivePath(loc: DriveLocation): string {
	return loc === "root" ? "/files" : `/files/${loc}`;
}
