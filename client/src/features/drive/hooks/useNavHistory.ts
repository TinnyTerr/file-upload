import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInvalidateDrive } from "./useDrive";

const MAX_IDX_KEY = "fu_explorer_max_idx@v1";

/** react-router stamps a monotonically increasing `idx` into history state on
 * every push, which is the only handle the History API gives us on "where in
 * the stack am I". */
function currentIdx(): number {
	const state = window.history.state as { idx?: number } | null;
	return state?.idx ?? 0;
}

function readMaxIdx(): number {
	const raw = sessionStorage.getItem(MAX_IDX_KEY);
	const n = raw ? Number(raw) : 0;
	return Number.isFinite(n) ? n : 0;
}

/**
 * Back / forward / up / refresh for the address bar.
 *
 * Deliberately backed by the router's own history rather than a private stack:
 * a private stack desyncs from the browser's back button the moment the user
 * touches it, and an explorer whose ← disagrees with the browser's ← is worse
 * than one whose → is occasionally enabled a step too eagerly.
 */
export function useNavHistory() {
	const navigate = useNavigate();
	const location = useLocation();
	const invalidate = useInvalidateDrive();
	const [idx, setIdx] = useState(currentIdx);
	const [maxIdx, setMaxIdx] = useState(readMaxIdx);

	// `history.state` is updated by the router *during* the navigation, so read
	// it after the location has settled rather than inside the click handler.
	// biome-ignore lint/correctness/useExhaustiveDependencies: location.key isn't read in the body; it is the signal that window.history.state has been rewritten, which is what the body reads.
	useEffect(() => {
		const now = currentIdx();
		setIdx(now);
		setMaxIdx((prev) => {
			const next = Math.max(prev, now);
			sessionStorage.setItem(MAX_IDX_KEY, String(next));
			return next;
		});
	}, [location.key]);

	const back = useCallback(() => navigate(-1), [navigate]);
	const forward = useCallback(() => navigate(1), [navigate]);
	const refresh = useCallback(() => invalidate(), [invalidate]);

	return {
		back,
		forward,
		refresh,
		canBack: idx > 0,
		// An upper bound, not a guarantee: a fresh push truncates anything ahead
		// of it, and the History API gives us no way to observe that.
		canForward: idx < maxIdx,
	};
}
