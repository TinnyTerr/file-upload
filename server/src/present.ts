/** Narrow away null/undefined, throwing instead of lying like a `!` does. Use
 * where the surrounding code guarantees presence (a row just inserted, a
 * request that already passed `requireSession`) so a broken guarantee fails
 * loudly at the call site instead of as a TypeError somewhere downstream. */
export function present<T>(value: T | null | undefined, what = "value"): T {
	if (value === null || value === undefined) {
		throw new Error(`expected ${what} to be present`);
	}
	return value;
}
