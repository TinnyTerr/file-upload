import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useRef } from "react";
import { ContextMenu } from "@/components/ui/context-menu";
import {
	DropdownMenuCheckboxItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { useExplorer } from "../../hooks/useExplorer";
import { COLUMNS, type ColumnDef, columnWidth } from "../../lib/columns";

/** One header cell: click to sort, drag the right edge to resize, right-click
 * for the column chooser. */
function HeaderCell({ col }: { col: ColumnDef }) {
	const { prefs, toggleSort, setColumnWidth } = useExplorer();
	const cellRef = useRef<HTMLDivElement>(null);
	const active = col.sort && prefs.sortKey === col.sort;
	const width = columnWidth(col, prefs.columnWidths);

	const startResize = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startWidth = width;
			// Pointer capture keeps the drag alive when the cursor leaves the 4px
			// handle, which it does immediately.
			const target = e.currentTarget as HTMLElement;
			target.setPointerCapture(e.pointerId);

			const move = (ev: PointerEvent) => {
				setColumnWidth(
					col.id,
					Math.max(col.minWidth, startWidth + (ev.clientX - startX)),
				);
			};
			const up = () => {
				target.releasePointerCapture(e.pointerId);
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", up);
			};
			target.addEventListener("pointermove", move);
			target.addEventListener("pointerup", up);
		},
		[col.id, col.minWidth, width, setColumnWidth],
	);

	return (
		<div
			ref={cellRef}
			className="relative flex shrink-0 items-center"
			style={{ width, minWidth: col.minWidth }}
		>
			<button
				type="button"
				disabled={!col.sort}
				onClick={() => col.sort && toggleSort(col.sort)}
				className={cn(
					"flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-xs font-medium transition-colors",
					col.align === "right" && "justify-end",
					col.sort
						? "text-muted-foreground hover:text-foreground"
						: "cursor-default text-muted-foreground",
					active && "text-foreground",
				)}
			>
				<span className="truncate">{col.label}</span>
				{active &&
					(prefs.sortDir === "asc" ? (
						<ArrowUp className="size-3 shrink-0" />
					) : (
						<ArrowDown className="size-3 shrink-0" />
					))}
			</button>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={`Resize the ${col.label} column`}
				onPointerDown={startResize}
				className="absolute -right-0.5 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/50"
			/>
		</div>
	);
}

export function ColumnHeaderRow({ columns }: { columns: ColumnDef[] }) {
	const { prefs, toggleColumn } = useExplorer();

	// Right-click anywhere on the header opens the chooser, as in Explorer.
	// `ContextMenu` is the app's own right-click wrapper -- a `DropdownMenuTrigger`
	// here would open the chooser on an ordinary left-click and swallow the
	// sort clicks the header cells are made of.
	return (
		<ContextMenu
			className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur"
			menu={
				<>
					<DropdownMenuLabel>Columns</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{COLUMNS.filter((c) => !c.fixed).map((c) => (
						<DropdownMenuCheckboxItem
							key={c.id}
							checked={!prefs.hiddenColumns.includes(c.id)}
							// Toggling a column shouldn't close the chooser -- nobody
							// turns exactly one column on and stops.
							onSelect={(e) => e.preventDefault()}
							onCheckedChange={() => toggleColumn(c.id)}
						>
							{c.label}
						</DropdownMenuCheckboxItem>
					))}
				</>
			}
		>
			<div role="row" className="flex pr-3">
				{columns.map((c) => (
					<HeaderCell key={c.id} col={c} />
				))}
			</div>
		</ContextMenu>
	);
}
