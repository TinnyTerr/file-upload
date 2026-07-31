import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Edit-in-place, the way F2 works in Explorer.
 *
 * The stem is preselected and the extension is not: renaming `report.pdf`
 * almost never means changing `.pdf`, and having to arrow past it every time is
 * the small daily friction the old modal never fixed either.
 */
export function InlineRename({
	initial,
	isFolder,
	busy,
	onCommit,
	onCancel,
	className,
}: {
	initial: string;
	isFolder: boolean;
	busy?: boolean;
	onCommit: (name: string) => void;
	onCancel: () => void;
	className?: string;
}) {
	const ref = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initial);
	// A blur triggered by our own Enter/Escape must not fire a second commit.
	const settled = useRef(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus();
		const dot = initial.lastIndexOf(".");
		const stemEnd = !isFolder && dot > 0 ? dot : initial.length;
		el.setSelectionRange(0, stemEnd);
	}, [initial, isFolder]);

	const commit = () => {
		if (settled.current) return;
		settled.current = true;
		const next = value.trim();
		if (!next || next === initial) onCancel();
		else onCommit(next);
	};

	const cancel = () => {
		if (settled.current) return;
		settled.current = true;
		onCancel();
	};

	return (
		<input
			ref={ref}
			value={value}
			disabled={busy}
			onChange={(e) => setValue(e.target.value)}
			// Clicking the row underneath would otherwise select it and tear the
			// input down mid-edit.
			onClick={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
			onBlur={commit}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					cancel();
				}
			}}
			aria-label="New name"
			className={cn(
				"min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-sm outline-none",
				className,
			)}
		/>
	);
}
