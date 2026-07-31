import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { DriveSelection } from "./useDriveSelection";

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Below this the gesture was a click, not a drag — otherwise every click on
 * the background would run a hit test and clear the selection twice. */
const THRESHOLD = 4;

/**
 * Rubber-band selection over the content pane.
 *
 * Hit testing reads the live DOM rather than a maintained geometry model: the
 * views are four different layouts (table rows, a wrapping flex grid, a CSS
 * multi-column list), and `data-item-key` plus `getBoundingClientRect` is the
 * one description all four already provide for free.
 */
export function useMarquee(
	surfaceRef: RefObject<HTMLElement | null>,
	selection: DriveSelection,
) {
	const [rect, setRect] = useState<Rect | null>(null);
	const origin = useRef<{ x: number; y: number } | null>(null);
	const additive = useRef(false);
	const baseline = useRef<Set<string>>(new Set());

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			// Only a primary-button drag starting on the *background*: starting one
			// on a row would fight the row's own drag-to-move.
			if (e.button !== 0) return;
			if (e.target !== e.currentTarget) return;
			origin.current = { x: e.clientX, y: e.clientY };
			additive.current = e.ctrlKey || e.metaKey || e.shiftKey;
			baseline.current = new Set(selection.selected);
		},
		[selection.selected],
	);

	useEffect(() => {
		const move = (e: PointerEvent) => {
			const start = origin.current;
			const surface = surfaceRef.current;
			if (!start || !surface) return;
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;

			const bounds = surface.getBoundingClientRect();
			const left = Math.min(start.x, e.clientX);
			const top = Math.min(start.y, e.clientY);
			const width = Math.abs(dx);
			const height = Math.abs(dy);
			setRect({
				left: left - bounds.left,
				top: top - bounds.top,
				width,
				height,
			});

			const hits = new Set<string>();
			for (const el of surface.querySelectorAll<HTMLElement>(
				"[data-item-key]",
			)) {
				const r = el.getBoundingClientRect();
				const intersects =
					r.left < left + width &&
					r.right > left &&
					r.top < top + height &&
					r.bottom > top;
				if (intersects) {
					const key = el.dataset.itemKey;
					if (key) hits.add(key);
				}
			}
			const next = additive.current
				? new Set([...baseline.current, ...hits])
				: hits;
			selection.setSelected(next);
		};

		const up = () => {
			origin.current = null;
			setRect(null);
		};

		// First rung of the Escape cascade: abandoning a rubber-band puts the
		// selection back where it was. Registered in the *capture* phase so it
		// beats `useExplorerKeys`' window listener, which would otherwise clear
		// the selection entirely on the same keystroke.
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !origin.current) return;
			e.stopPropagation();
			selection.setSelected(new Set(baseline.current));
			up();
		};

		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [surfaceRef, selection]);

	return { rect, onPointerDown };
}
