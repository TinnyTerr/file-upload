import { useCallback, useEffect, useState } from "react";

export type ViewMode = "icons" | "tiles" | "list" | "details";
export type SortKey = "name" | "date" | "size" | "type";
export type SortDir = "asc" | "desc";

export interface ExplorerPrefs {
	view: ViewMode;
	sortKey: SortKey;
	sortDir: SortDir;
	/** Windows keeps folders above files regardless of the sort. Off by choice. */
	foldersFirst: boolean;
	detailsOpen: boolean;
	navOpen: boolean;
	/** Details-view column widths in px, keyed by column id. */
	columnWidths: Record<string, number>;
	/** Details-view columns the user has hidden. */
	hiddenColumns: string[];
}

const STORAGE_KEY = "fu_explorer_prefs@v1";

export const DEFAULT_PREFS: ExplorerPrefs = {
	view: "details",
	sortKey: "name",
	sortDir: "asc",
	foldersFirst: true,
	detailsOpen: true,
	navOpen: true,
	columnWidths: {},
	hiddenColumns: [],
};

function load(): ExplorerPrefs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_PREFS;
		// Merged rather than replaced: a prefs blob written by an older build is
		// missing whatever keys were added since, and a missing `view` would
		// render nothing at all.
		return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ExplorerPrefs>) };
	} catch {
		return DEFAULT_PREFS;
	}
}

/**
 * How the explorer looks, persisted across sessions.
 *
 * `localStorage`, unlike the key vault — these are cosmetic preferences, and
 * losing them on every reload is exactly the annoyance the setting exists to
 * avoid.
 *
 * Deliberately one global view rather than Windows' per-folder memory: that
 * needs an unbounded map keyed by folder id with no eviction, and a folder
 * silently opening in a different view than the last one is more confusing
 * than helpful.
 */
export function useExplorerPrefs() {
	const [prefs, setPrefs] = useState<ExplorerPrefs>(load);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
		} catch {
			// Quota or private mode -- the session still works, it just forgets.
		}
	}, [prefs]);

	const update = useCallback(
		(patch: Partial<ExplorerPrefs>) => setPrefs((p) => ({ ...p, ...patch })),
		[],
	);

	/** Clicking the active column header flips direction; a new one starts
	 * ascending, except size and date, where "most" is the useful default. */
	const toggleSort = useCallback((key: SortKey) => {
		setPrefs((p) =>
			p.sortKey === key
				? { ...p, sortDir: p.sortDir === "asc" ? "desc" : "asc" }
				: {
						...p,
						sortKey: key,
						sortDir: key === "size" || key === "date" ? "desc" : "asc",
					},
		);
	}, []);

	const setColumnWidth = useCallback((id: string, width: number) => {
		setPrefs((p) => ({
			...p,
			columnWidths: { ...p.columnWidths, [id]: Math.round(width) },
		}));
	}, []);

	const toggleColumn = useCallback((id: string) => {
		setPrefs((p) => ({
			...p,
			hiddenColumns: p.hiddenColumns.includes(id)
				? p.hiddenColumns.filter((c) => c !== id)
				: [...p.hiddenColumns, id],
		}));
	}, []);

	return { prefs, update, toggleSort, setColumnWidth, toggleColumn };
}
