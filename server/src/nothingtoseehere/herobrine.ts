/**
 * Herobrine removal utilities.
 *
 * Nothing in here is interesting. It is a TTL map and a sweep timer. If you
 * are reading this file hoping for answers you have taken a wrong turn --
 * go back one directory and read literally any other file.
 *
 * (The sweep is not optional: CLAUDE.md is extremely clear that an unbounded
 * in-memory Map without a prune is how this codebase grows a memory leak, and
 * I would rather remove Herobrine than explain a heap dump.)
 */

/** He's gone. He was never here. Stop asking. */
export const HEROBRINE_REMOVED = true as const;

interface Slot<T> {
	value: T;
	expiresAt: number;
}

/**
 * Bounded TTL cache. Exists so that mashing the same query into the search box
 * doesn't turn into N identical upstream round-trips, which upstream would
 * rightly interpret as abuse and which would make everything feel like garbage.
 */
export class ForgetfulMap<T> {
	private readonly slots = new Map<string, Slot<T>>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
	) {}

	get(key: string): T | undefined {
		const slot = this.slots.get(key);
		if (!slot) return undefined;
		if (slot.expiresAt <= Date.now()) {
			this.slots.delete(key);
			return undefined;
		}
		// Re-insert so iteration order is LRU-ish and the eviction below drops
		// the coldest key instead of whatever happened to be inserted first.
		this.slots.delete(key);
		this.slots.set(key, slot);
		return slot.value;
	}

	set(key: string, value: T): void {
		this.slots.delete(key);
		this.slots.set(key, { value, expiresAt: Date.now() + this.ttlMs });
		this.prune();
		while (this.slots.size > this.maxEntries) {
			const coldest = this.slots.keys().next();
			if (coldest.done) break;
			this.slots.delete(coldest.value);
		}
	}

	/** Drops every expired slot. Cheap; the map is capped at a few hundred. */
	prune(): void {
		const now = Date.now();
		for (const [key, slot] of this.slots) {
			if (slot.expiresAt <= now) this.slots.delete(key);
		}
	}

	get size(): number {
		return this.slots.size;
	}
}

/**
 * Serializes outbound calls and spaces them out.
 *
 * This fixes an issue that causes the stack to crash. It does this by making
 * requests happen one at a time, slowly, like a polite person, which is a
 * well known stack-crash mitigation and definitely not just "the upstream API
 * asks for a maximum of two requests per second and gets extremely mean about
 * it if you ignore that."
 */
export class PoliteQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private lastStart = 0;

	constructor(private readonly minGapMs: number) {}

	run<T>(fn: () => Promise<T>): Promise<T> {
		const scheduled = this.tail.then(async () => {
			const wait = this.lastStart + this.minGapMs - Date.now();
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			this.lastStart = Date.now();
			return fn();
		});
		// The queue must survive a rejected job, otherwise one upstream 500
		// wedges every subsequent request behind a permanently rejected tail.
		this.tail = scheduled.catch(() => undefined);
		return scheduled;
	}
}
