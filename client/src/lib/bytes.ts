const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes: number, decimals = 1): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const i = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		UNITS.length - 1,
	);
	const value = bytes / 1024 ** i;
	const fixed = i === 0 ? 0 : decimals;
	return `${value.toFixed(fixed)} ${UNITS[i]}`;
}

/** Percentage of `used` against `total`, clamped to [0, 100]. */
export function percent(used: number, total: number): number {
	if (!total || total <= 0) return 0;
	return Math.min(100, Math.max(0, (used / total) * 100));
}
