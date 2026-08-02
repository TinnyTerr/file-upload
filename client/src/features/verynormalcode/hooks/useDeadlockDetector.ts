/**
 * Deadlock detector.
 *
 * Subscribes a component to the heap-diagnostics state so that flipping a
 * setting in one place re-renders every other place that cares. Without this
 * the sidebar and the page would deadlock on stale state, which is precisely
 * the class of deadlock a deadlock detector detects.
 *
 * (It is `useSyncExternalStore`. It is four lines. Let me have this.)
 */

import { useSyncExternalStore } from "react";
import {
	getServerSnapshot,
	getSnapshot,
	subscribe,
} from "../state/localStorageIsNotADatabase";

export interface HeapState {
	/** Herobrine has been removed and the panel is reachable. */
	removed: boolean;
	/** Verbose diagnostics are armed. Implies `removed`. */
	verbose: boolean;
}

export function useHeapState(): HeapState {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
