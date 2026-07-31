import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DriveItem, itemKey } from "../lib/items";

export interface DriveSelection {
	selected: Set<string>;
	items: DriveItem[];
	isSelected: (item: DriveItem) => boolean;
	/** Handles the plain / ctrl-cmd / shift variants of a click. */
	onItemClick: (
		item: DriveItem,
		e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
	) => void;
	/** Selects `item` unless it is already part of a multi-item selection --
	 * what a right-click or a drag start should do. */
	ensureSelected: (item: DriveItem) => DriveItem[];
	selectedItems: DriveItem[];
	clear: () => void;
	selectAll: () => void;
}

/**
 * Explorer selection: click to select one, ctrl/cmd-click to toggle,
 * shift-click to extend from the last anchor. Keyed by `kind:id`, so folders
 * and files can be selected together and acted on in one go.
 */
export function useDriveSelection(items: DriveItem[]): DriveSelection {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const anchor = useRef<string | null>(null);
	const keys = useMemo(() => items.map(itemKey), [items]);
	const keySignature = keys.join("|");

	// Navigating to another folder -- or deleting what was selected -- must not
	// leave phantom ids behind for the bulk bar to act on.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the contents of `keys`, not its identity
	useEffect(() => {
		const live = new Set(keySignature ? keySignature.split("|") : []);
		setSelected((prev) => {
			const next = new Set([...prev].filter((k) => live.has(k)));
			return next.size === prev.size ? prev : next;
		});
	}, [keySignature]);

	const isSelected = useCallback(
		(item: DriveItem) => selected.has(itemKey(item)),
		[selected],
	);

	const onItemClick = useCallback<DriveSelection["onItemClick"]>(
		(item, e) => {
			const key = itemKey(item);
			if (e.shiftKey && anchor.current) {
				const from = keys.indexOf(anchor.current);
				const to = keys.indexOf(key);
				if (from !== -1 && to !== -1) {
					const [lo, hi] = from < to ? [from, to] : [to, from];
					setSelected(new Set(keys.slice(lo, hi + 1)));
					return;
				}
			}
			if (e.ctrlKey || e.metaKey) {
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(key)) next.delete(key);
					else next.add(key);
					return next;
				});
				anchor.current = key;
				return;
			}
			setSelected(new Set([key]));
			anchor.current = key;
		},
		[keys],
	);

	const selectedItems = useMemo(
		() => items.filter((i) => selected.has(itemKey(i))),
		[items, selected],
	);

	const ensureSelected = useCallback(
		(item: DriveItem) => {
			const key = itemKey(item);
			if (selected.has(key) && selected.size > 1) return selectedItems;
			setSelected(new Set([key]));
			anchor.current = key;
			return [item];
		},
		[selected, selectedItems],
	);

	const clear = useCallback(() => setSelected(new Set()), []);
	const selectAll = useCallback(() => setSelected(new Set(keys)), [keys]);

	return {
		selected,
		items,
		isSelected,
		onItemClick,
		ensureSelected,
		selectedItems,
		clear,
		selectAll,
	};
}
