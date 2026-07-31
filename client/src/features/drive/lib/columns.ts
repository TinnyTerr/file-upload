import type { SortKey } from "../hooks/useExplorerPrefs";

export interface ColumnDef {
	id: string;
	label: string;
	/** Which comparator the header triggers, if it is sortable at all. */
	sort?: SortKey;
	defaultWidth: number;
	minWidth: number;
	align?: "left" | "right";
	/** Name is structural: it holds the checkbox, icon and inline rename. */
	fixed?: boolean;
}

/**
 * The Details view's columns.
 *
 * "Date added", not "Date modified": the schema has `files.created_at` and
 * `directories.created_at` and nothing else. There is no modification
 * timestamp to show, and labelling one of these "modified" is a claim the rest
 * of the UI would then have to keep pretending is true.
 */
export const COLUMNS: ColumnDef[] = [
	{
		id: "name",
		label: "Name",
		sort: "name",
		defaultWidth: 320,
		minWidth: 160,
		fixed: true,
	},
	{
		id: "date",
		label: "Date added",
		sort: "date",
		defaultWidth: 170,
		minWidth: 110,
	},
	{
		id: "size",
		label: "Size",
		sort: "size",
		defaultWidth: 100,
		minWidth: 70,
		align: "right",
	},
	{ id: "type", label: "Type", sort: "type", defaultWidth: 150, minWidth: 90 },
	{ id: "encryption", label: "Encryption", defaultWidth: 120, minWidth: 90 },
	{
		id: "links",
		label: "Links",
		defaultWidth: 80,
		minWidth: 60,
		align: "right",
	},
];

export function visibleColumns(hidden: string[]): ColumnDef[] {
	return COLUMNS.filter((c) => c.fixed || !hidden.includes(c.id));
}

export function columnWidth(
	col: ColumnDef,
	widths: Record<string, number>,
): number {
	return Math.max(col.minWidth, widths[col.id] ?? col.defaultWidth);
}
