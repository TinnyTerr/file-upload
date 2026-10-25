import type { Request } from "express";
import type { AppState } from "./appState.ts";
import { nowIso } from "./db/rows.ts";
import type { Db } from "./db/types.ts";
import { clientCountry } from "./middleware/auth.ts";

export type LinkKind = "file" | "dir";
export type LinkEvent = "view" | "download" | "save";

/** Rows older than this are dropped by `pruneLinkHits`. */
export const LINK_HIT_RETENTION_DAYS = 90;

/** Counts one visit to a share link. Never throws: analytics failing must not
 * fail the download it describes. */
export function recordLinkHit(
	state: AppState,
	req: Request,
	kind: LinkKind,
	linkId: number,
	event: LinkEvent,
): void {
	try {
		state.db.run(
			`INSERT INTO link_hits (link_kind, link_id, event, country, created_at)
       VALUES ($kind, $id, $event, $country, $now)`,
			{
				$kind: kind,
				$id: linkId,
				$event: event,
				$country: clientCountry(state, req),
				$now: nowIso(),
			},
		);
	} catch {
		/* best effort */
	}
}

export function pruneLinkHits(db: Db): number {
	const cutoff = new Date(
		Date.now() - LINK_HIT_RETENTION_DAYS * 86_400_000,
	).toISOString();
	const n = db.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM link_hits WHERE created_at < $c",
		{ $c: cutoff },
	)!.n;
	if (n) db.run("DELETE FROM link_hits WHERE created_at < $c", { $c: cutoff });
	return n;
}

/** Hits for a link are meaningless once it is gone. */
export function deleteLinkHits(db: Db, kind: LinkKind, linkId: number): void {
	db.run("DELETE FROM link_hits WHERE link_kind = $k AND link_id = $id", {
		$k: kind,
		$id: linkId,
	});
}

export interface LinkStats {
	days: number;
	totals: Record<LinkEvent, number>;
	last_event_at: string | null;
	/** One entry per UTC day in the window, oldest first, zero-filled. */
	series: { day: string; view: number; download: number; save: number }[];
	/** Most-seen countries; `null` is "unknown" (no trusted country header). */
	countries: { country: string | null; count: number }[];
}

export function linkStats(
	db: Db,
	kind: LinkKind,
	linkId: number,
	days: number,
): LinkStats {
	const start = new Date();
	start.setUTCHours(0, 0, 0, 0);
	start.setUTCDate(start.getUTCDate() - (days - 1));
	const since = start.toISOString();
	const params = { $k: kind, $id: linkId, $since: since };

	const rows = db.all<{ day: string; event: LinkEvent; n: number }>(
		`SELECT substr(created_at, 1, 10) AS day, event, COUNT(*) AS n
     FROM link_hits
     WHERE link_kind = $k AND link_id = $id AND created_at >= $since
     GROUP BY day, event`,
		params,
	);
	const byDay = new Map<string, LinkStats["series"][number]>();
	for (let i = 0; i < days; i++) {
		const d = new Date(start.getTime() + i * 86_400_000)
			.toISOString()
			.slice(0, 10);
		byDay.set(d, { day: d, view: 0, download: 0, save: 0 });
	}
	const totals: LinkStats["totals"] = { view: 0, download: 0, save: 0 };
	for (const r of rows) {
		const slot = byDay.get(r.day);
		if (!slot || !(r.event in totals)) continue;
		slot[r.event] = r.n;
		totals[r.event] += r.n;
	}
	const countries = db.all<{ country: string | null; count: number }>(
		`SELECT country, COUNT(*) AS count FROM link_hits
     WHERE link_kind = $k AND link_id = $id AND created_at >= $since
       AND event != 'view'
     GROUP BY country ORDER BY count DESC LIMIT 10`,
		params,
	);
	const last = db.get<{ at: string | null }>(
		`SELECT MAX(created_at) AS at FROM link_hits
     WHERE link_kind = $k AND link_id = $id AND event != 'view'`,
		{ $k: kind, $id: linkId },
	);
	return {
		days,
		totals,
		last_event_at: last?.at ?? null,
		series: [...byDay.values()],
		countries,
	};
}
