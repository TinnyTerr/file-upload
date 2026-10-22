import type {
	ActivityJob,
	ActivityMessage,
	ActivitySpan,
	FinishedSpan,
} from "../types";

/** Mutable model behind the live activity view. Pure (no React, no socket) so
 * the folding rules can be tested; the hook just feeds it messages and asks it
 * to be rendered. All times are server clock -- `offset` converts to local. */

export const RECENT_CAP = 60;

export interface ActivityStore {
	jobs: Map<string, ActivityJob>;
	open: Map<number, ActivitySpan>;
	/** Newest first. */
	recent: FinishedSpan[];
	/** serverNow - clientNow at the last snapshot. */
	offset: number;
	/** Messages folded since connect, for the rate readout. */
	received: number;
}

export function emptyStore(): ActivityStore {
	return {
		jobs: new Map(),
		open: new Map(),
		recent: [],
		offset: 0,
		received: 0,
	};
}

export function applyMessage(
	s: ActivityStore,
	msg: ActivityMessage,
	clientNow = Date.now(),
): void {
	s.received++;
	switch (msg.type) {
		case "snapshot": {
			s.offset = msg.now - clientNow;
			s.jobs = new Map(msg.jobs.map((j) => [j.id, j]));
			s.open = new Map(msg.open.map((sp) => [sp.id, sp]));
			return;
		}
		case "start": {
			s.open.set(msg.span.id, msg.span);
			if (msg.span.kind === "job") {
				const j = s.jobs.get(msg.span.name);
				if (j) {
					j.running = true;
					j.lastStartAt = msg.span.startedAt;
					// The timer ticks as the run starts, so the next one is an
					// interval on from here.
					j.nextDueAt = msg.span.startedAt + j.intervalMs;
				}
			}
			return;
		}
		case "end": {
			// Unknown id = it began before we subscribed; nothing to close.
			const span = s.open.get(msg.id);
			if (!span) return;
			s.open.delete(msg.id);
			s.recent.unshift({
				...span,
				endedAt: msg.at,
				ms: msg.ms,
				ok: msg.ok,
				detail: msg.detail,
			});
			if (s.recent.length > RECENT_CAP) s.recent.length = RECENT_CAP;
			if (span.kind === "job") {
				const j = s.jobs.get(span.name);
				if (j) {
					j.running = false;
					j.lastMs = msg.ms;
					j.lastOk = msg.ok;
					j.lastError = msg.ok ? null : (msg.detail ?? null);
				}
			}
			return;
		}
		case "skipped": {
			const j = s.jobs.get(msg.job);
			if (j) j.skipped++;
			return;
		}
	}
}
