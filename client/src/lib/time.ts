/** Format an ISO timestamp as a compact local date+time. */
export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Format an ISO timestamp as date only. */
export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** Relative time like "in 3 days" / "5 minutes ago". */
export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "never";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "never";
	const diff = d.getTime() - Date.now();
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 31536000000],
		["month", 2592000000],
		["day", 86400000],
		["hour", 3600000],
		["minute", 60000],
		["second", 1000],
	];
	for (const [unit, ms] of units) {
		if (abs >= ms || unit === "second") {
			return rtf.format(Math.round(diff / ms), unit);
		}
	}
	return "now";
}

/** Format a countdown like "45s" / "12m" / "3h" for an in-progress transfer.
 * "—" once there's nothing left to estimate from (null, zero, negative). */
export function formatEta(seconds: number | null | undefined): string {
	if (!seconds || seconds <= 0) return "—";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

/**
 * Parse a human duration string ("24h", "7d", "30m", "90s", "1w") into seconds.
 * Returns null if the input is empty/invalid.
 */
export function parseDuration(input: string): number | null {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) return null;
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/);
	if (!match) return null;
	const value = parseFloat(match[1]);
	const unit = match[2] ?? "s";
	const mult: Record<string, number> = {
		s: 1,
		m: 60,
		h: 3600,
		d: 86400,
		w: 604800,
	};
	return Math.round(value * mult[unit]);
}
