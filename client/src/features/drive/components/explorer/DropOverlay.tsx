import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The full-pane "drop it anywhere" affordance.
 *
 * Shown as soon as OS files enter the explorer, not when they reach a
 * particular target — the whole point of the rework is that there is no
 * designated drop rectangle to find any more. It names the destination so
 * dropping is never a guess about where the files will land.
 *
 * `dragenter`/`dragleave` fire for every element crossed, so the same depth
 * counter the individual drop zones use applies here too.
 */
export function DropOverlay({ destination }: { destination: string }) {
	const [visible, setVisible] = useState(false);
	const depth = useRef(0);

	useEffect(() => {
		const hasFiles = (e: DragEvent) =>
			Array.from(e.dataTransfer?.types ?? []).includes("Files");

		const onEnter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth.current += 1;
			setVisible(true);
		};
		const onLeave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setVisible(false);
		};
		const onDrop = () => {
			depth.current = 0;
			setVisible(false);
		};
		// Without a `dragover` preventDefault on the window, the browser navigates
		// to the dropped file instead of letting the page have it.
		const onOver = (e: DragEvent) => {
			if (hasFiles(e)) e.preventDefault();
		};

		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("dragover", onOver);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("drop", onDrop);
		};
	}, []);

	if (!visible) return null;

	return (
		<div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm">
			<div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/60 bg-card/90 px-10 py-8 shadow-xl">
				<span className="flex size-12 items-center justify-center rounded-full bg-brand-gradient text-white">
					<Upload className="size-6" />
				</span>
				<p className="text-sm font-medium">
					Drop to upload into{" "}
					<span className="text-primary">{destination}</span>
				</p>
				<p className="text-xs text-muted-foreground">
					Drop on a folder to put them there instead.
				</p>
			</div>
		</div>
	);
}
