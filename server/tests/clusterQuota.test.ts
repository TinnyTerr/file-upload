/**
 * Master-gated quota reservations and degraded mode (Phase 5, §5.5 + §5.9).
 *
 * The interesting property is not "a user over quota is refused" — that worked
 * before. It is that two nodes cannot each admit a write the cluster cannot
 * afford, which is only testable with two real nodes and a real reservation
 * ledger, and that a node cut off from the master stops writing rather than
 * guessing.
 */

import { describe, expect, test } from "bun:test";
import {
	awaitWritable,
	isDegraded,
	MASTER_GRACE_MS,
	masterStatus,
} from "../src/cluster/degraded.ts";
import { ensureUid } from "../src/cluster/identity.ts";
import {
	grantReservation,
	RESERVATION_TTL_MS,
	renewReservation,
	reserveQuota,
	settleReservation,
	sweepReservations,
} from "../src/cluster/quota.ts";
import { promoteSelf, selfRole } from "../src/cluster/tiering.ts";
import type { Db } from "../src/db/types.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeFile, makeUser } from "./harness.ts";

async function userWithQuota(db: Db, username: string, quotaBytes: number) {
	const user = await makeUser(db, username);
	db.run("UPDATE permissions SET quota_bytes = $q WHERE user_id = $id", {
		$q: quotaBytes,
		$id: user.id,
	});
	return { user, uid: ensureUid(db, "users", user.id) };
}

describe("the reservation ledger", () => {
	test("counts open reservations against the quota, so two writes cannot both fit", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const { uid } = await userWithQuota(c.master.db, "owner", 15_000);

			// This is the whole point. Without the ledger both calls read
			// SUM(files.size_bytes) = 0 and both succeed, and the change log
			// honestly converges on 20 000 bytes against a 15 000 byte quota.
			const first = grantReservation(c.master.db, {
				user_uid: uid,
				bytes: 10_000,
				kind: "upload",
				node_id: "node-a",
			});
			expect(first.bytes).toBe(10_000);
			expect(() =>
				grantReservation(c.master.db, {
					user_uid: uid,
					bytes: 10_000,
					kind: "upload",
					node_id: "node-b",
				}),
			).toThrow(/quota/);

			// Releasing hands the space straight back.
			settleReservation(c.master.db, first.uid, "released");
			expect(
				grantReservation(c.master.db, {
					user_uid: uid,
					bytes: 10_000,
					kind: "upload",
					node_id: "node-b",
				}).bytes,
			).toBe(10_000);
		} finally {
			c.close();
		}
	});

	test("committed bytes and open reservations are counted together, not either/or", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const { user, uid } = await userWithQuota(c.master.db, "owner", 10_000);
			makeFile(c.master.db, {
				ownerId: user.id,
				name: "existing.bin",
				sizeBytes: 6_000,
			});
			// 6 000 written + 3 000 reserved leaves 1 000.
			grantReservation(c.master.db, {
				user_uid: uid,
				bytes: 3_000,
				kind: "upload",
				node_id: "node-a",
			});
			expect(() =>
				grantReservation(c.master.db, {
					user_uid: uid,
					bytes: 1_001,
					kind: "upload",
					node_id: "node-a",
				}),
			).toThrow(/quota/);
			expect(
				grantReservation(c.master.db, {
					user_uid: uid,
					bytes: 1_000,
					kind: "upload",
					node_id: "node-a",
				}).bytes,
			).toBe(1_000);
		} finally {
			c.close();
		}
	});

	test("a settled reservation stops counting, so committing does not double-count", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const { uid } = await userWithQuota(c.master.db, "owner", 10_000);
			const r = grantReservation(c.master.db, {
				user_uid: uid,
				bytes: 9_000,
				kind: "upload",
				node_id: "node-a",
			});
			// While it is open the space is spoken for; once committed the file row
			// is the record and the reservation must get out of the way, or a user
			// would be charged twice for one write.
			settleReservation(c.master.db, r.uid, "committed", 9_000);
			expect(
				grantReservation(c.master.db, {
					user_uid: uid,
					bytes: 9_000,
					kind: "upload",
					node_id: "node-a",
				}).bytes,
			).toBe(9_000);
		} finally {
			c.close();
		}
	});
});

describe("the sliding TTL (D-16)", () => {
	test("expiry is an inactivity window, and renewing moves it", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const { uid } = await userWithQuota(db, "owner", 100_000);
			const start = new Date();
			const r = grantReservation(
				db,
				{ user_uid: uid, bytes: 1_000, kind: "torrent", node_id: "node-a" },
				start,
			);

			// A day later with no activity: gone, and the bytes are free again.
			const wayLater = new Date(start.getTime() + RESERVATION_TTL_MS * 2);
			// ...but only if nothing renewed it. Renew just inside the window and
			// the same instant no longer expires it -- which is what lets a
			// multi-day torrent import keep its space.
			const renewedAt = new Date(start.getTime() + RESERVATION_TTL_MS - 1000);
			expect(renewReservation(db, r.uid, renewedAt)).not.toBeNull();
			expect(sweepReservations(db, renewedAt)).toBe(0);

			expect(sweepReservations(db, wayLater)).toBe(1);
			expect(
				db.get<{ state: string }>(
					"SELECT state FROM quota_reservations WHERE uid = $uid",
					{ $uid: r.uid },
				)!.state,
			).toBe("expired");
		} finally {
			c.close();
		}
	});

	test("renewing something already settled is a no-op, not an error", async () => {
		const c = await makeCluster({ size: 1 });
		try {
			const db = c.master.db;
			const { uid } = await userWithQuota(db, "owner", 100_000);
			const r = grantReservation(db, {
				user_uid: uid,
				bytes: 1,
				kind: "upload",
				node_id: "node-a",
			});
			settleReservation(db, r.uid, "committed", 1);
			// A keepalive racing a commit is normal; making callers handle it would
			// be handling a case with no consequence.
			expect(renewReservation(db, r.uid)).not.toBeNull();
			expect(renewReservation(db, "no-such-uid")).toBeNull();
		} finally {
			c.close();
		}
	});
});

describe("a follower reserves against the master", () => {
	test("over HTTP, and the master's ledger is what decides", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const { user } = await userWithQuota(master!.db, "owner", 5_000);
			// The follower needs the user row to exist locally to resolve its uid;
			// replication puts it there, which is exactly how production gets it.
			const { replicationPullJob } = await import(
				"../src/cluster/replication.ts"
			);
			await replicationPullJob(follower!.state);

			const localUser = follower!.db.get<{ id: number }>(
				"SELECT * FROM users WHERE username = 'owner'",
			)!;
			const reservation = await reserveQuota(follower!.state, {
				user: { ...user, id: localUser.id },
				bytes: 4_000,
				kind: "upload",
			});
			expect(reservation.bytes).toBe(4_000);
			// It landed in the MASTER's table, not the follower's -- there is one
			// ledger and it is the master's.
			expect(
				master!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM quota_reservations WHERE state = 'open'",
				)!.n,
			).toBe(1);
			expect(
				follower!.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM quota_reservations",
				)!.n,
			).toBe(0);

			await expect(
				reserveQuota(follower!.state, {
					user: { ...user, id: localUser.id },
					bytes: 2_000,
					kind: "upload",
				}),
			).rejects.toThrow(/quota/);
		} finally {
			c.close();
		}
	});
});

describe("degraded mode (§5.5)", () => {
	test("a master and an unclustered node are never degraded", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			expect(selfRole(c.master.state)).toBe("master");
			// The authority cannot be cut off from itself.
			c.master.state.masterReachability.noteFailure();
			expect(isDegraded(c.master.state)).toBe(false);

			// And a node that was never tiered into a cluster must not be told it
			// is degraded because a cluster it is not part of has no leader.
			const lone = await makeCluster({ size: 1 });
			lone.nodes[0]!.db.run("DELETE FROM cluster_tiering");
			lone.nodes[0]!.state.masterReachability.noteFailure();
			expect(isDegraded(lone.nodes[0]!.state)).toBe(false);
			lone.close();
		} finally {
			c.close();
		}
	});

	test("holds through the grace window, then refuses", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const reach = follower.state.masterReachability;

			expect(masterStatus(follower.state).phase).toBe("ok");
			reach.noteFailure();
			// A master restart takes seconds. Turning that window into errors would
			// make routine maintenance look like an outage.
			expect(masterStatus(follower.state).phase).toBe("grace");
			expect(isDegraded(follower.state)).toBe(false);

			// A held request is released the moment contact returns.
			const held = awaitWritable(follower.state);
			reach.confirmContact();
			await held;
			expect(masterStatus(follower.state).phase).toBe("ok");
		} finally {
			c.close();
		}
	});

	test("past the grace window the write gate refuses and the API says so", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			// Reach back in time rather than waiting five minutes: the clock is
			// "time since last confirmed contact", so this is the same state.
			const reach = follower.state.masterReachability;
			reach.noteFailure();
			(reach as unknown as { lastContactMs: number }).lastContactMs =
				Date.now() - MASTER_GRACE_MS - 1000;

			expect(masterStatus(follower.state).phase).toBe("degraded");
			await expect(awaitWritable(follower.state)).rejects.toThrow(/read-only/);

			const user = await makeUser(follower.db, "someone");
			const session = follower.signIn(user);
			// Reads keep working -- every read here is local, which is the property
			// that makes a degraded node useful rather than merely up.
			expect(
				(await follower.request("/api/files", { cookie: session.cookie }))
					.status,
			).toBe(200);
			// Writes do not.
			const write = await follower.request("/api/directories", {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "nope" }),
			});
			expect(write.status).toBe(503);
			expect((await write.json()) as { degraded: boolean }).toMatchObject({
				degraded: true,
			});
		} finally {
			c.close();
		}
	});

	test("the endpoints that end the outage stay reachable while degraded", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const reach = follower.state.masterReachability;
			reach.noteFailure();
			(reach as unknown as { lastContactMs: number }).lastContactMs =
				Date.now() - MASTER_GRACE_MS - 1000;

			const admin = await makeUser(follower.db, "admin", "master");
			const session = follower.signIn(admin);
			// Gating /api/cluster would make degraded mode unrecoverable: promotion
			// is the way out, and it is a POST.
			const res = await follower.request("/api/cluster/promote", {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirm: "wrong-name" }),
			});
			expect(res.status).toBe(400);
			expect((await res.json()) as { detail: string }).toMatchObject({
				detail: expect.stringContaining("to confirm"),
			});
		} finally {
			c.close();
		}
	});
});

describe("operator promotion (§5.5)", () => {
	test("is refused while the master is reachable, and taken when it is not", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const admin = await makeUser(follower.db, "admin", "master");
			const session = follower.signIn(admin);

			// Promoting a healthy cluster splits it. That is the one thing this
			// endpoint must not make easy.
			const tooSoon = await follower.request("/api/cluster/promote", {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirm: follower.nodeName }),
			});
			expect(tooSoon.status).toBe(409);

			const reach = follower.state.masterReachability;
			reach.noteFailure();
			(reach as unknown as { lastContactMs: number }).lastContactMs =
				Date.now() - MASTER_GRACE_MS - 1000;

			const before = follower.db.get<{ g: number }>(
				"SELECT MAX(generation) AS g FROM cluster_tiering",
			)!.g;
			const ok = await follower.request("/api/cluster/promote", {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirm: follower.nodeName }),
			});
			expect(ok.status).toBe(200);
			expect(selfRole(follower.state)).toBe("master");
			expect(
				follower.db.get<{ g: number; reason: string }>(
					"SELECT generation AS g, reason FROM cluster_tiering ORDER BY generation DESC LIMIT 1",
				),
			).toMatchObject({ g: before + 1, reason: "promotion" });
			// And it stops being degraded, because it is now the authority.
			expect(isDegraded(follower.state)).toBe(false);
		} finally {
			c.close();
		}
	});

	test("promotion makes this node the quota authority in the same act", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const { user } = await userWithQuota(follower.db, "owner", 5_000);
			promoteSelf(follower.state, "operator");

			// No HTTP hop any more -- the ledger is local because leadership is.
			const reservation = await reserveQuota(follower.state, {
				user,
				bytes: 4_000,
				kind: "upload",
			});
			expect(reservation.bytes).toBe(4_000);
			expect(
				follower.db.get<{ n: number }>(
					"SELECT COUNT(*) AS n FROM quota_reservations WHERE state = 'open'",
				)!.n,
			).toBe(1);
		} finally {
			c.close();
		}
	});
});
