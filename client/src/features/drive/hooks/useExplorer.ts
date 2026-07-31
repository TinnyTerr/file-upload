import { createContext, useContext } from "react";
import type { DriveItem } from "../lib/items";
import type { DriveChildren, DriveLocation } from "../types";
import type { DriveActions } from "./useDriveActions";
import type { DriveSelection } from "./useDriveSelection";
import type { ExplorerPrefs, SortKey } from "./useExplorerPrefs";

export interface ExplorerPermissions {
	canUpload: boolean;
	canDelete: boolean;
	canCreate: boolean;
	canManageLinks: boolean;
}

export interface ExplorerContextValue {
	loc: DriveLocation;
	data: DriveChildren | undefined;
	isLoading: boolean;
	/** Sorted and filtered -- what the views actually render. */
	items: DriveItem[];
	/** Sorted, before the search filter, for "3 of 47 items". */
	totalCount: number;
	selection: DriveSelection;
	actions: DriveActions;
	perms: ExplorerPermissions;
	prefs: ExplorerPrefs;
	updatePrefs: (patch: Partial<ExplorerPrefs>) => void;
	toggleSort: (key: SortKey) => void;
	setColumnWidth: (id: string, width: number) => void;
	toggleColumn: (id: string) => void;
	/** Roving focus for the keyboard model; an item key or null. */
	focusKey: string | null;
	setFocusKey: (key: string | null) => void;
	/** The item currently being renamed in place, or null. */
	renameKey: string | null;
	setRenameKey: (key: string | null) => void;
	commitRename: (item: DriveItem, name: string) => void;
	search: string;
	setSearch: (q: string) => void;
	/** Queued to move by a Cut; the views dim it until the paste lands. */
	isCut: (item: DriveItem) => boolean;
	busy: boolean;
	/** The context menu body, so every surface renders the same one. */
	menuFor: (item: DriveItem) => React.ReactNode;
}

export const ExplorerContext = createContext<ExplorerContextValue | null>(null);

export function useExplorer() {
	const ctx = useContext(ExplorerContext);
	if (!ctx) throw new Error("useExplorer must be used within ExplorerPage");
	return ctx;
}
