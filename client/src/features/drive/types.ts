import type { Directory } from "@/features/directories/types";
import type { FileObject } from "@/features/files/types";

/** Where the explorer currently is. `"root"` is the literal id the backend
 * uses for "no containing folder", so it doubles as the URL segment. */
export type DriveLocation = number | "root";

export interface Breadcrumb {
	id: number;
	title: string;
}

/** One level of the tree -- never a recursive dump. */
export interface DriveChildren {
	/** The folder being viewed, or null at the root. */
	directory: Directory | null;
	/** Root-first chain ending with `directory` itself; empty at the root. */
	breadcrumbs: Breadcrumb[];
	directories: Directory[];
	files: FileObject[];
}

export function parseLocation(param: string | undefined): DriveLocation {
	if (!param) return "root";
	const n = Number(param);
	return Number.isInteger(n) && n > 0 ? n : "root";
}

export function drivePath(loc: DriveLocation): string {
	return loc === "root" ? "/files" : `/files/${loc}`;
}
