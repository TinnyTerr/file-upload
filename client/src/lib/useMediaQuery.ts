import { useEffect, useState } from "react";

/** Tracks a CSS media query in JS, live -- for the cases where a component
 * has to pick *which markup* to render (a resizable pane vs. a Sheet
 * overlay), not just style the same markup differently. Tailwind's own
 * breakpoint classes can't do that branch. */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() => window.matchMedia(query).matches,
	);

	useEffect(() => {
		const mql = window.matchMedia(query);
		setMatches(mql.matches);
		const onChange = () => setMatches(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);

	return matches;
}
