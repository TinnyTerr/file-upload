import { useEffect, useRef } from "react";
import { type DriveItem, itemKey, itemName } from "../lib/items";
import type { DriveActions } from "./useDriveActions";
import type { DriveSelection } from "./useDriveSelection";
import type { ExplorerPrefs, ViewMode } from "./useExplorerPrefs";

export interface KeyHandlers {
	items: DriveItem[];
	selection: DriveSelection;
	actions: DriveActions;
	focusKey: string | null;
	setFocusKey: (key: string | null) => void;
	setRenameKey: (key: string | null) => void;
	renaming: boolean;
	prefs: ExplorerPrefs;
	updatePrefs: (patch: Partial<ExplorerPrefs>) => void;
	canDelete: boolean;
	onUp: () => void;
	onBack: () => void;
	onForward: () => void;
	onRefresh: () => void;
	onNewFolder: () => void;
	onCut: () => void;
	onCopy: () => void;
	onPaste: () => void;
	onCopyLink: () => void;
	/** Something is on the clipboard, so Escape clears that before the selection. */
	hasClipboard: boolean;
	onClearClipboard: () => void;
	/** Columns per row in the grid views, for ←/→ navigation. */
	columnsPerRow: () => number;
}

const VIEW_BY_DIGIT: Record<string, ViewMode> = {
	"1": "icons",
	"2": "tiles",
	"3": "list",
	"4": "details",
};

/** How long a typed prefix stays live before it resets. */
const TYPEAHEAD_MS = 700;

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * The explorer's whole keyboard model, in one `window` listener.
 *
 * Two guards keep it from firing where it shouldn't:
 *
 *   1. anything typed into an input, textarea, select or contenteditable
 *      belongs to that control;
 *   2. `document.body.style.pointerEvents === "none"` is precisely the flag
 *      `@radix-ui/react-dismissable-layer` sets while a modal layer is up, so
 *      that one test covers every dialog, sheet and menu in the app — including
 *      ones added later — without a registry to keep in sync.
 */
export function useExplorerKeys(h: KeyHandlers) {
	const ref = useRef(h);
	ref.current = h;
	const typed = useRef({ prefix: "", at: 0 });

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const {
				items,
				selection,
				actions,
				focusKey,
				setFocusKey,
				setRenameKey,
				renaming,
				prefs,
				updatePrefs,
				canDelete,
				columnsPerRow,
			} = ref.current;

			const target = e.target as HTMLElement | null;
			if (
				target?.isContentEditable ||
				/^(input|textarea|select)$/i.test(target?.tagName ?? "")
			)
				return;
			if (document.body.style.pointerEvents === "none") return;
			if (renaming) return;

			const index = focusKey
				? items.findIndex((i) => itemKey(i) === focusKey)
				: -1;
			const current = index >= 0 ? items[index] : undefined;
			const grid = prefs.view !== "details" && prefs.view !== "list";
			const step = grid ? columnsPerRow() : 1;

			const moveTo = (next: number, extend: boolean, focusOnly: boolean) => {
				if (!items.length) return;
				const clamped = Math.max(0, Math.min(items.length - 1, next));
				const item = items[clamped]!;
				setFocusKey(itemKey(item));
				if (focusOnly) return;
				if (extend) selection.extendTo(item);
				else selection.selectOnly(item);
				// Keep the moved-to row in view; the listing is the scroll container.
				document
					.querySelector(`[data-item-key="${CSS.escape(itemKey(item))}"]`)
					?.scrollIntoView({ block: "nearest" });
			};

			const mod = e.ctrlKey || e.metaKey;

			// ── navigation ────────────────────────────────────────────────
			if (e.altKey && e.key === "ArrowLeft") {
				e.preventDefault();
				ref.current.onBack();
				return;
			}
			if (e.altKey && e.key === "ArrowRight") {
				e.preventDefault();
				ref.current.onForward();
				return;
			}
			if ((e.altKey && e.key === "ArrowUp") || e.key === "Backspace") {
				e.preventDefault();
				ref.current.onUp();
				return;
			}
			if (e.key === "F5") {
				// Ctrl+R is deliberately left to the browser -- hijacking a full
				// reload is hostile when something is genuinely wedged.
				e.preventDefault();
				ref.current.onRefresh();
				return;
			}
			if (mod && e.key === "f") {
				e.preventDefault();
				window.dispatchEvent(new Event("fu:focus-search"));
				return;
			}

			// ── arrows / selection ────────────────────────────────────────
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const delta = e.key === "ArrowDown" ? step : -step;
				moveTo(index === -1 ? 0 : index + delta, e.shiftKey, mod);
				return;
			}
			if (grid && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
				e.preventDefault();
				moveTo(
					index === -1 ? 0 : index + (e.key === "ArrowRight" ? 1 : -1),
					e.shiftKey,
					mod,
				);
				return;
			}
			if (e.key === "Home" || e.key === "End") {
				e.preventDefault();
				moveTo(e.key === "Home" ? 0 : items.length - 1, e.shiftKey, mod);
				return;
			}
			if (e.key === "PageDown" || e.key === "PageUp") {
				e.preventDefault();
				const page = grid ? step * 4 : 12;
				moveTo(
					(index === -1 ? 0 : index) + (e.key === "PageDown" ? page : -page),
					e.shiftKey,
					mod,
				);
				return;
			}
			if (e.key === " " && current) {
				e.preventDefault();
				selection.onItemClick(current, {
					ctrlKey: true,
					metaKey: false,
					shiftKey: false,
				});
				return;
			}
			if (mod && e.key === "a") {
				e.preventDefault();
				selection.selectAll();
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				// The cascade: a live marquee already consumed this in the capture
				// phase (`useMarquee`), and a rename is handled by the input itself.
				// What's left is the cut queue, then the selection -- one Escape
				// should undo one thing, not everything at once.
				if (ref.current.hasClipboard) {
					ref.current.onClearClipboard();
					return;
				}
				selection.clear();
				setFocusKey(null);
				return;
			}

			// ── acting on the selection ───────────────────────────────────
			if (e.key === "Enter") {
				if (e.altKey) {
					e.preventDefault();
					updatePrefs({ detailsOpen: true });
					return;
				}
				const item = current ?? selection.selectedItems[0];
				if (item) {
					e.preventDefault();
					actions.open(item);
				}
				return;
			}
			if (e.key === "F2") {
				const item = current ?? selection.selectedItems[0];
				if (item) {
					e.preventDefault();
					selection.selectOnly(item);
					setFocusKey(itemKey(item));
					setRenameKey(itemKey(item));
				}
				return;
			}
			if (e.key === "Delete" && canDelete) {
				const targets = selection.selectedItems;
				if (targets.length) {
					e.preventDefault();
					void actions.remove(targets);
				}
				return;
			}
			if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
				e.preventDefault();
				ref.current.onCopyLink();
				return;
			}
			if (mod && e.shiftKey && e.key.toLowerCase() === "n") {
				e.preventDefault();
				ref.current.onNewFolder();
				return;
			}
			if (mod && e.shiftKey && VIEW_BY_DIGIT[e.key]) {
				e.preventDefault();
				updatePrefs({ view: VIEW_BY_DIGIT[e.key] });
				return;
			}
			if (mod && !e.shiftKey && e.key === "x") {
				e.preventDefault();
				ref.current.onCut();
				return;
			}
			if (mod && !e.shiftKey && e.key === "c") {
				e.preventDefault();
				ref.current.onCopy();
				return;
			}
			if (mod && !e.shiftKey && e.key === "v") {
				e.preventDefault();
				ref.current.onPaste();
				return;
			}
			if (mod && !e.shiftKey && e.key === "d") {
				e.preventDefault();
				actions.download(selection.selectedItems);
				return;
			}

			// ── type to select ────────────────────────────────────────────
			if (!mod && !e.altKey && e.key.length === 1 && e.key !== " ") {
				const now = Date.now();
				const state = typed.current;
				state.prefix =
					now - state.at > TYPEAHEAD_MS ? e.key : state.prefix + e.key;
				state.at = now;
				const hit = items.find(
					(i) =>
						collator.compare(
							itemName(i).slice(0, state.prefix.length),
							state.prefix,
						) === 0,
				);
				if (hit) {
					e.preventDefault();
					setFocusKey(itemKey(hit));
					selection.selectOnly(hit);
					document
						.querySelector(`[data-item-key="${CSS.escape(itemKey(hit))}"]`)
						?.scrollIntoView({ block: "nearest" });
				}
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
