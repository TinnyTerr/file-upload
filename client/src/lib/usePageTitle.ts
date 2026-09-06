import { useEffect } from "react";

const BASE_TITLE = document.title;

/** Sets `document.title` for as long as the calling component is mounted,
 * restoring whatever it was before on unmount -- so navigating away (or a
 * page that never calls this) doesn't leave a stale title behind. */
export function usePageTitle(title: string | undefined | null): void {
	useEffect(() => {
		if (!title) return;
		const previous = document.title;
		document.title = `${title} · ${BASE_TITLE}`;
		return () => {
			document.title = previous;
		};
	}, [title]);
}
