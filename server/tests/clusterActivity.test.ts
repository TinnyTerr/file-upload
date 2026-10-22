/**
 * Live cluster activity tracer. The property that matters is the cost model:
 * nothing is built or buffered unless a watcher is subscribed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ActivityMessage, activity } from "../src/cluster/activity.ts";

afterEach(() => activity.clearJobs());

describe("activity tracer", () => {
	test("begin() is a no-op with no watcher, and tracks nothing", () => {
		expect(activity.watching).toBe(false);
		const end = activity.begin("out", "GET /x", { peer: "p:1" });
		end(true);
		const unsub = activity.subscribe(() => {});
		expect(
			(activity.snapshot() as Extract<ActivityMessage, { type: "snapshot" }>)
				.open,
		).toEqual([]);
		unsub();
	});

	test("watcher gets a snapshot, then start/end for spans", () => {
		const seen: ActivityMessage[] = [];
		const unsub = activity.subscribe((m) => seen.push(m));
		expect(seen[0]?.type).toBe("snapshot");
		const end = activity.begin("in", "POST /api/cluster/reserve", {
			touches: ["db"],
			peer: "10.0.0.2",
		});
		end(false, "409");
		end(true); // second end is ignored
		unsub();
		const types = seen.map((m) => m.type);
		expect(types).toEqual(["snapshot", "start", "end"]);
		const last = seen[2] as Extract<ActivityMessage, { type: "end" }>;
		expect(last.ok).toBe(false);
		expect(last.detail).toBe("409");
	});

	test("last unsubscribe drops open spans", () => {
		const unsub = activity.subscribe(() => {});
		activity.begin("out", "GET /never-ends");
		unsub();
		const again = activity.subscribe(() => {});
		expect(
			(activity.snapshot() as Extract<ActivityMessage, { type: "snapshot" }>)
				.open,
		).toEqual([]);
		again();
	});

	test("job stats are kept unwatched; outbound calls name their job when watched", async () => {
		activity.registerJob("j", 1000, ["db", "peers"]);
		await activity.runJob("j", () => {});
		const snap = activity.snapshot() as Extract<
			ActivityMessage,
			{ type: "snapshot" }
		>;
		const j = snap.jobs.find((x) => x.id === "j")!;
		expect(j.lastOk).toBe(true);
		expect(j.running).toBe(false);
		expect(j.lastMs).not.toBeNull();

		const seen: ActivityMessage[] = [];
		const unsub = activity.subscribe((m) => seen.push(m));
		await activity.runJob("j", async () => {
			await Promise.resolve();
			activity.begin("out", "POST /api/cluster/heartbeat", {
				peer: "p:1",
			})(true);
		});
		unsub();
		const out = seen.find(
			(m) => m.type === "start" && m.span.kind === "out",
		) as Extract<ActivityMessage, { type: "start" }>;
		expect(out.span.cause).toBe("j");
	});

	test("a failing job is recorded and rethrown", async () => {
		activity.registerJob("bad", 1000, []);
		await expect(
			activity.runJob("bad", () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const snap = activity.snapshot() as Extract<
			ActivityMessage,
			{ type: "snapshot" }
		>;
		expect(snap.jobs.find((x) => x.id === "bad")?.lastError).toBe("boom");
	});
});
