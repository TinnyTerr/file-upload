import { useEffect, useState } from "react";
import { useExplorer } from "../../hooks/useExplorer";
import { NavTreeNode } from "./NavTreeNode";

/**
 * The persistent folder pane.
 *
 * Expansion is seeded from `DriveChildren.breadcrumbs`, which is already the
 * root-first ancestor chain of wherever the explorer is — so navigating into a
 * folder five levels down opens the tree to it without a single extra request
 * and without any client-side path index.
 */
export function NavTree() {
	const { data, loc } = useExplorer();
	const [expanded, setExpanded] = useState<Set<number>>(new Set());

	const trail = data?.breadcrumbs ?? [];
	const trailKey = trail.map((c) => c.id).join(",");

	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the contents of the trail, not its identity
	useEffect(() => {
		if (!trailKey) return;
		const ids = trailKey.split(",").map(Number);
		setExpanded((prev) => {
			const next = new Set(prev);
			let changed = false;
			for (const id of ids) {
				if (!next.has(id)) {
					next.add(id);
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [trailKey]);

	const toggle = (id: number) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	return (
		<div
			role="tree"
			aria-label="Folders"
			className="h-full overflow-auto p-1.5 text-sm"
		>
			<NavTreeNode
				loc="root"
				label="My Drive"
				depth={0}
				expanded={expanded}
				onToggle={toggle}
				currentId={loc === "root" ? null : loc}
			/>
		</div>
	);
}
