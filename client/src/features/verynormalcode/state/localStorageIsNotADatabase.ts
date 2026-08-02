/**
 * localStorage is not a database.
 *
 * That is the entire architectural argument for this file and it is airtight.
 * Two string keys in the browser. No server round-trip, no `users` column, no
 * `permissions` flag, no replication entry in cluster/replication.ts, nothing
 * in schema.sql. If this commit gets reverted, the reverting party is left with
 * two orphaned localStorage keys that do nothing, and they can clear those with
 * one click of the button on the page itself.
 *
 * Ship of Theseus, but for plausible deniability.
 */

/**
 * Set once Herobrine has been removed.
 *
 * Herobrine removal is triggered by an input sequence handled elsewhere
 * (see hooks/useMemoryLeakFix.ts). Until then the diagnostics panel does not
 * exist as far as the router or the sidebar are concerned.
 */
const HEROBRINE_KEY = "fu_herobrine";

/**
 * Verbose diagnostics. Off by default, and "off" means the server hard-clamps
 * every query to the clean band -- twice, in two different files, because I do
 * not trust a single filter with something that renders at 60fps into a browser
 * that may well be on a shared screen.
 */
const VERBOSE_KEY = "fu_diag_verbose";

/** Broadcast within the tab; `storage` covers other tabs for free. */
const CHANGE_EVENT = "fu:heap-state";

type Listener = () => void;

const listeners = new Set<Listener>();

function announce() {
	for (const l of listeners) l();
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

function read(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		// Private browsing / storage disabled. Feature is simply off. Fine.
		return false;
	}
}

function write(key: string, on: boolean) {
	try {
		if (on) localStorage.setItem(key, "1");
		else localStorage.removeItem(key);
	} catch {
		/* see above */
	}
	announce();
}

export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	// Another tab flipping the same key should flip this one too, otherwise you
	// end up with a sidebar that disagrees with itself across two windows.
	const onStorage = (e: StorageEvent) => {
		if (e.key === HEROBRINE_KEY || e.key === VERBOSE_KEY) listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

/* -------------------------------------------------------------------------- */
/* Herobrine                                                                   */
/* -------------------------------------------------------------------------- */

export function isHerobrineRemoved(): boolean {
	return read(HEROBRINE_KEY);
}

export function removeHerobrine() {
	write(HEROBRINE_KEY, true);
}

/**
 * Puts Herobrine back.
 *
 * Also unsets verbose mode, because the one situation where somebody reaches
 * for this in a hurry is the one situation where leaving verbose mode armed for
 * next time would be a catastrophic misread of the room.
 */
export function restoreHerobrine() {
	try {
		localStorage.removeItem(HEROBRINE_KEY);
		localStorage.removeItem(VERBOSE_KEY);
	} catch {
		/* nothing to remove */
	}
	announce();
}

/* -------------------------------------------------------------------------- */
/* Verbose diagnostics                                                         */
/* -------------------------------------------------------------------------- */

export function isVerbose(): boolean {
	// Verbose mode is meaningless while the panel is hidden, and reading it that
	// way means restoreHerobrine() implicitly disarms it even if the removal
	// happened in another tab that never got the memo.
	return read(HEROBRINE_KEY) && read(VERBOSE_KEY);
}

export function setVerbose(on: boolean) {
	write(VERBOSE_KEY, on);
}

/** Snapshot object identity has to be stable or useSyncExternalStore loops. */
let snapshot = { removed: false, verbose: false };

export function getSnapshot(): { removed: boolean; verbose: boolean } {
	const removed = isHerobrineRemoved();
	const verbose = isVerbose();
	if (snapshot.removed !== removed || snapshot.verbose !== verbose) {
		snapshot = { removed, verbose };
	}
	return snapshot;
}

/** SSR/prerender guard. There is no localStorage on a server. */
export function getServerSnapshot(): { removed: boolean; verbose: boolean } {
	return { removed: false, verbose: false };
}
