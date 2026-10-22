import { describe, expect, test } from "bun:test";
import {
	applyMessage,
	emptyStore,
} from "../src/features/cluster/lib/activityStore";
import type { ActivityJob } from "../src/features/cluster/types";

const job = (over: Partial<ActivityJob> = {}): ActivityJob => ({
	id: "cluster_heartbeat",
	intervalMs: 60000,
	touches: ["db", "peers"],
	running: false,
	lastStartAt: null,
	lastMs: null,
	lastOk: null,
	lastError: null,
	nextDueAt: 1000,
	skipped: 0,
	...over,
});

describe("activity store", () => {
	test("snapshot sets the server clock offset", () => {
		const s = emptyStore();
		applyMessage(
			s,
			{ type: "snapshot", now: 5000, jobs: [job()], open: [] },
			1000,
		);
		expect(s.offset).toBe(4000);
		expect(s.jobs.size).toBe(1);
	});

	test("job span start/end drives running state and last result", () => {
		const s = emptyStore();
		applyMessage(s, { type: "snapshot", now: 0, jobs: [job()], open: [] }, 0);
		const span = {
			id: 1,
			kind: "job" as const,
			name: "cluster_heartbeat",
			touches: [],
			startedAt: 100,
		};
		applyMessage(s, { type: "start", span });
		expect(s.jobs.get("cluster_heartbeat")?.running).toBe(true);
		expect(s.jobs.get("cluster_heartbeat")?.nextDueAt).toBe(60100);
		applyMessage(s, {
			type: "end",
			id: 1,
			ok: false,
			ms: 40,
			detail: "x",
			at: 140,
		});
		const j = s.jobs.get("cluster_heartbeat")!;
		expect(j.running).toBe(false);
		expect(j.lastOk).toBe(false);
		expect(s.recent[0]?.ms).toBe(40);
	});

	test("an end for a span begun before subscribing is ignored", () => {
		const s = emptyStore();
		applyMessage(s, { type: "end", id: 99, ok: true, ms: 1, at: 1 });
		expect(s.recent).toEqual([]);
	});

	test("recent is capped", () => {
		const s = emptyStore();
		for (let i = 1; i <= 100; i++) {
			applyMessage(s, {
				type: "start",
				span: { id: i, kind: "in", name: "x", touches: [], startedAt: i },
			});
			applyMessage(s, { type: "end", id: i, ok: true, ms: 1, at: i });
		}
		expect(s.recent.length).toBe(60);
		expect(s.recent[0]?.id).toBe(100);
	});
});
