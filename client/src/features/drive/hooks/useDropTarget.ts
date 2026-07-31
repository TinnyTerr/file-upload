import { createContext, useCallback, useContext, useRef } from "react";
import type { Directory } from "@/features/directories/types";
import type { DriveItem } from "../lib/items";

/** Anywhere something can be dropped. The old explorer had exactly one kind of
 * drop target -- a folder tile -- which is why files could never be dropped on
 * the background, the breadcrumbs or the tree. */
export type DropZone =
	| { kind: "folder"; dir: Directory }
	/** The listing background: whatever folder is currently open. */
	| { kind: "current"; dir: Directory | null }
	/** The "up" button: the parent of the open folder. */
	| { kind: "parent"; id: number | null };

export function zoneId(zone: DropZone): string {
	switch (zone.kind) {
		case "folder":
			return `folder:${zone.dir.id}`;
		case "current":
			return `current:${zone.dir?.id ?? "root"}`;
		case "parent":
			return `parent:${zone.id ?? "root"}`;
	}
}

export function zoneDirectoryId(zone: DropZone): number | null {
	switch (zone.kind) {
		case "folder":
			return zone.dir.id;
		case "current":
			return zone.dir?.id ?? null;
		case "parent":
			return zone.id;
	}
}

export function zoneLabel(zone: DropZone): string {
	switch (zone.kind) {
		case "folder":
			return zone.dir.title;
		case "current":
			return zone.dir?.title ?? "My Drive";
		case "parent":
			return zone.id === null ? "My Drive" : "the folder above";
	}
}

export interface DropContextValue {
	/** The zone the pointer is currently over, or null. */
	activeZone: string | null;
	setActiveZone: (id: string | null) => void;
	canUpload: boolean;
	/** Internal move. Already filtered for no-ops by the caller. */
	onMoveInto: (items: DriveItem[], zone: DropZone) => void;
	/** OS files dropped into a zone. */
	onFilesInto: (
		files: File[],
		entries: DataTransferItem[],
		zone: DropZone,
	) => void;
	/** Resolves the drag payload against the current level. */
	resolveDragged: (raw: string, zone: DropZone) => DriveItem[];
}

export const DropContext = createContext<DropContextValue | null>(null);

export function useDropContext() {
	const ctx = useContext(DropContext);
	if (!ctx) throw new Error("useDropTarget must be used within DropContext");
	return ctx;
}

const DRIVE_DRAG_TYPE = "application/x-fileupload-drive-items";

/**
 * Drop wiring for one zone.
 *
 * `dragenter`/`dragleave` fire for every child element the pointer crosses, so
 * the old `dropTarget === dir.id` test flickered constantly. A depth counter
 * incremented on enter and decremented on leave is the standard fix: the zone
 * is only inactive once the count returns to zero.
 *
 * `zone` may be null for a row that isn't a drop target at all -- a file has
 * nothing to put anything inside. Hooks can't be called conditionally, so the
 * null case returns inert handlers rather than making every caller register a
 * zone it doesn't want.
 */
export function useDropTarget(zone: DropZone | null) {
	const ctx = useDropContext();
	const depth = useRef(0);
	const id = zone ? zoneId(zone) : null;
	const active = id !== null && ctx.activeZone === id;

	// A `parent` zone -- a breadcrumb or the "up" button -- is a bare folder id
	// with no `Directory` row behind it, so there is no way to check whether the
	// destination is end-to-end encrypted. Moving an *existing* item there is
	// fine (the server re-checks, and a move never re-keys), but uploading new
	// bytes into a folder whose mode we can't see is exactly the mistake the
	// client-folder refusal exists to prevent. So those zones take moves only.
	const externalAllowed = zone !== null && zone.kind !== "parent";

	const accepts = useCallback(
		(e: React.DragEvent) => {
			if (!zone) return { internal: false, external: false };
			const internal = e.dataTransfer.types.includes(DRIVE_DRAG_TYPE);
			const external = e.dataTransfer.types.includes("Files");
			return {
				internal,
				external: external && ctx.canUpload && externalAllowed,
			};
		},
		[ctx.canUpload, externalAllowed, zone],
	);

	const onDragEnter = useCallback(
		(e: React.DragEvent) => {
			const { internal, external } = accepts(e);
			if (!internal && !external) return;
			e.preventDefault();
			// The innermost zone wins: a row inside the listing should light up
			// instead of the listing behind it.
			e.stopPropagation();
			depth.current += 1;
			ctx.setActiveZone(id);
		},
		[accepts, ctx, id],
	);

	const onDragOver = useCallback(
		(e: React.DragEvent) => {
			const { internal, external } = accepts(e);
			if (!internal && !external) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = internal ? "move" : "copy";
			if (ctx.activeZone !== id) ctx.setActiveZone(id);
		},
		[accepts, ctx, id],
	);

	const onDragLeave = useCallback(
		(e: React.DragEvent) => {
			const { internal, external } = accepts(e);
			if (!internal && !external) return;
			e.stopPropagation();
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0 && ctx.activeZone === id) ctx.setActiveZone(null);
		},
		[accepts, ctx, id],
	);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			const { internal, external } = accepts(e);
			if ((!internal && !external) || !zone) return;
			e.preventDefault();
			e.stopPropagation();
			depth.current = 0;
			ctx.setActiveZone(null);

			const raw = e.dataTransfer.getData(DRIVE_DRAG_TYPE);
			if (raw) {
				const dropped = ctx.resolveDragged(raw, zone);
				if (dropped.length) ctx.onMoveInto(dropped, zone);
				return;
			}
			const files = Array.from(e.dataTransfer.files ?? []);
			// `items` carries the entry handles needed to walk a dropped OS folder;
			// it is only readable synchronously, so snapshot it here.
			const items = Array.from(e.dataTransfer.items ?? []);
			if (files.length || items.length) ctx.onFilesInto(files, items, zone);
		},
		[accepts, ctx, zone],
	);

	return {
		active,
		dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
	};
}
