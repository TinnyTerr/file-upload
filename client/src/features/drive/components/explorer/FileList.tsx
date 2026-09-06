import { useVirtualizer } from "@tanstack/react-virtual";
import { Inbox, Search } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { useDropTarget } from "../../hooks/useDropTarget";
import { useExplorer } from "../../hooks/useExplorer";
import type { ViewMode } from "../../hooks/useExplorerPrefs";
import { useMarquee } from "../../hooks/useMarquee";
import { columnWidth, visibleColumns } from "../../lib/columns";
import {
	DRIVE_DRAG_TYPE,
	type DriveItem,
	itemKey,
	itemName,
	serializeDrag,
} from "../../lib/items";
import { ColumnHeaderRow } from "./ColumnHeader";
import { ItemRow } from "./ItemRow";
import { ItemTile } from "./ItemTile";

/**
 * Per view: the narrowest a tile may be (0 = one item per row) and a first
 * guess at row height. The guess only has to be close — every row reports its
 * real height back through `measureElement`, which matters because a name can
 * wrap to two lines in the icons view.
 */
const METRICS: Record<ViewMode, { tileWidth: number; estimate: number }> = {
	details: { tileWidth: 0, estimate: 33 },
	list: { tileWidth: 0, estimate: 30 },
	tiles: { tileWidth: 244, estimate: 84 },
	icons: { tileWidth: 132, estimate: 152 },
};

function ListSkeleton() {
	return (
		<div className="space-y-1 p-3">
			{["a", "b", "c", "d", "e", "f"].map((k) => (
				<div key={k} className="flex items-center gap-3 py-1.5">
					<Skeleton className="size-5 rounded" />
					<Skeleton className="h-4 w-1/3" />
					<Skeleton className="ml-auto h-3 w-20" />
				</div>
			))}
		</div>
	);
}

/** How many tiles fit across, measured rather than assumed — the pane is
 * resizable, so a breakpoint guess would be wrong most of the time. */
function useLanes(
	ref: React.RefObject<HTMLElement | null>,
	tileWidth: number,
): number {
	const [width, setWidth] = useState(0);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const ro = new ResizeObserver(([entry]) => {
			if (entry) setWidth(entry.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);

	if (!tileWidth) return 1;
	// Minus the container's own padding (p-3 / p-2, so 24px at worst).
	return Math.max(1, Math.floor((width - 24) / tileWidth));
}

function chunk<T>(list: T[], size: number): T[][] {
	if (size <= 1) return list.map((x) => [x]);
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

/**
 * The content pane: view switching, selection, drag sources, marquee and the
 * background drop target.
 *
 * The background itself is a drop zone, which is the single biggest change
 * from the old listing — files could previously only be dropped onto a folder
 * tile, so "put these in the folder I'm looking at" had no gesture at all.
 *
 * Rows are virtualized in every view. Browsing does not paginate — a plain
 * `GET /directories?parent=<id>` returns the whole level — so a folder with a
 * few thousand files is an ordinary case, not a pathological one. (The `limit`
 * / `offset` parameters exist for the wide `scope=all` searches, not here.)
 */
export function FileList() {
	const {
		items,
		isLoading,
		selection,
		actions,
		prefs,
		data,
		search,
		perms,
		setFocusKey,
		setRenameKey,
		commitRename,
		isCut,
		menuFor,
	} = useExplorer();
	const scrollRef = useRef<HTMLDivElement>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const virtualRef = useRef<HTMLDivElement>(null);

	const background = useDropTarget({
		kind: "current",
		dir: data?.directory ?? null,
	});
	const marquee = useMarquee(surfaceRef, selection);

	const dragPropsFor = useCallback(
		(item: DriveItem) => ({
			draggable: true,
			onDragStart: (e: React.DragEvent) => {
				const dragged = selection.ensureSelected(item);
				e.dataTransfer.setData(DRIVE_DRAG_TYPE, serializeDrag(dragged));
				// So dragging out to a text field or another app does something sane.
				e.dataTransfer.setData("text/plain", dragged.map(itemName).join("\n"));
				e.dataTransfer.effectAllowed = "move";
			},
		}),
		[selection],
	);

	const columns = visibleColumns(prefs.hiddenColumns);
	const metrics = METRICS[prefs.view];
	const lanes = useLanes(scrollRef, metrics.tileWidth);
	const rows = useMemo(() => chunk(items, lanes), [items, lanes]);

	// The Details view scrolls horizontally when the columns are wider than the
	// pane. Absolutely positioned rows contribute nothing to their container's
	// width, so the total has to be stated rather than discovered.
	const gridWidth =
		prefs.view === "details"
			? columns.reduce((n, c) => n + columnWidth(c, prefs.columnWidths), 0) + 12
			: undefined;

	// The column header sits inside the scroll container, so the virtualizer's
	// idea of "scrolled past" is offset by its height.
	const [scrollMargin, setScrollMargin] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the deps aren't read in the body; they are what changes the offset, since the column header only exists in the Details view and the skeleton is a different height.
	useLayoutEffect(() => {
		setScrollMargin(virtualRef.current?.offsetTop ?? 0);
	}, [prefs.view, items.length]);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => metrics.estimate,
		overscan: 8,
		scrollMargin,
	});

	const renderItem = (item: DriveItem) => {
		const shared = {
			item,
			onOpen: actions.open,
			onSelectClick: selection.onItemClick,
			onRename: commitRename,
			dragProps: dragPropsFor(item),
			cut: isCut(item),
		};
		return (
			<ContextMenu key={itemKey(item)} menu={menuFor(item)}>
				{prefs.view === "details" ? (
					<ItemRow {...shared} columns={columns} />
				) : (
					<ItemTile {...shared} variant={prefs.view} />
				)}
			</ContextMenu>
		);
	};

	const body = () => {
		if (isLoading) return <ListSkeleton />;
		if (!items.length) {
			return (
				<div className="p-8">
					<EmptyState
						icon={search ? Search : Inbox}
						title={
							search
								? "Nothing matches that"
								: data?.directory
									? "This folder is empty"
									: "Nothing here yet"
						}
						description={
							search
								? `No item in “${data?.directory?.title ?? "My Drive"}” has that in its name.`
								: perms.canUpload
									? "Drop files anywhere here, or use Upload in the toolbar."
									: "Nothing has been shared with you here."
						}
					/>
				</div>
			);
		}

		return (
			<div style={gridWidth ? { minWidth: gridWidth } : undefined}>
				{prefs.view === "details" && <ColumnHeaderRow columns={columns} />}
				<div
					ref={virtualRef}
					role="rowgroup"
					className={cn(
						"relative w-full",
						prefs.view === "icons" && "p-3",
						prefs.view === "tiles" && "p-2",
						prefs.view === "list" && "p-1",
					)}
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map((v) => {
						const row = rows[v.index];
						if (!row) return null;
						return (
							<div
								key={v.key}
								data-index={v.index}
								ref={virtualizer.measureElement}
								role={prefs.view === "details" ? "presentation" : "row"}
								className={cn(
									"absolute left-0 top-0 w-full",
									lanes > 1 && "flex gap-1",
									prefs.view === "icons" && lanes > 1 && "justify-start",
								)}
								style={{
									transform: `translateY(${v.start - scrollMargin}px)`,
								}}
							>
								{row.map(renderItem)}
							</div>
						);
					})}
				</div>
			</div>
		);
	};

	return (
		<div
			ref={scrollRef}
			role="grid"
			aria-multiselectable="true"
			aria-rowcount={rows.length}
			{...background.dropProps}
			className={cn(
				"relative h-full overflow-auto outline-none",
				background.active && "bg-primary/5 ring-2 ring-inset ring-primary/40",
			)}
		>
			<div
				ref={surfaceRef}
				className="relative min-h-full"
				onPointerDown={marquee.onPointerDown}
				onClick={(e) => {
					// A click on the empty area below the rows clears the selection,
					// as it does in every file manager.
					if (e.target === e.currentTarget) {
						selection.clear();
						setFocusKey(null);
						setRenameKey(null);
					}
				}}
			>
				{body()}
				{marquee.rect && (
					<div
						className="pointer-events-none absolute z-20 rounded-sm border border-primary/70 bg-primary/15"
						style={marquee.rect}
					/>
				)}
			</div>
		</div>
	);
}
