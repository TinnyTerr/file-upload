import { useCallback, useMemo, useState } from "react";

/** Manage a set of selected numeric ids for bulk operations. */
export function useSelection() {
	const [ids, setIds] = useState<Set<number>>(new Set());

	const toggle = useCallback((id: number) => {
		setIds((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	}, []);

	const set = useCallback((nextIds: number[], on: boolean) => {
		setIds((prev) => {
			const next = new Set(prev);
			for (const id of nextIds) {
				if (on) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	}, []);

	const clear = useCallback(() => setIds(new Set()), []);

	return useMemo(
		() => ({
			ids,
			has: (id: number) => ids.has(id),
			toggle,
			set,
			clear,
			list: [...ids],
			count: ids.size,
		}),
		[ids, toggle, set, clear],
	);
}
