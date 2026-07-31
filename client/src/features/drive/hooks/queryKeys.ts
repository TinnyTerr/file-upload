import type { DriveLocation } from "../types";

export const driveKeys = {
	/** Everything under one prefix so a mutation anywhere in the tree can
	 * invalidate every open level in a single call. */
	all: ["drive"] as const,
	children: (loc: DriveLocation) => ["drive", "children", String(loc)] as const,
};
