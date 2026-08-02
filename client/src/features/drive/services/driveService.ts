import { api } from "@/config/api";
import type { DriveChildren, DriveLocation, DriveSearchScope } from "../types";

/**
 * The tree is read through a single endpoint (`GET /directories`); which read
 * you get is chosen by search parameters rather than by path. `scope=level`
 * with no `q` is the explorer's per-level fetch — still one level at a time,
 * never a recursive dump.
 */
export const driveService = {
	children: (loc: DriveLocation) =>
		api.get<DriveChildren>("/directories", { query: { parent: loc } }),

	search: (
		term: string,
		opts: {
			/** Bounds the search to one subtree; omitted searches everything. */
			parent?: DriveLocation;
			scope?: DriveSearchScope;
			limit?: number;
			offset?: number;
		} = {},
	) =>
		api.get<DriveChildren>("/directories", {
			query: {
				q: term,
				scope: opts.scope ?? (opts.parent ? "subtree" : "all"),
				parent: opts.parent,
				limit: opts.limit,
				offset: opts.offset,
			},
		}),
};
