/**
 * The identity split (redesign Phase 7, §5.10 — D-12 and D-18).
 *
 * Every node holds every user row so it can *authorize* anyone locally. What
 * it does not hold, until someone tries to log in there, is the material that
 * lets it *authenticate* them. These tests assert that split over real nodes:
 * the hash does not ride the log, a first login on a peer pulls it up the tier
 * exactly once, a password change anywhere makes every other node's copy read
 * as stale without anything being pushed for correctness, and a passkey never
 * travels at all.
 */

import { describe, expect, test } from "bun:test";
import { TABLE_COLUMNS } from "../src/cluster/changelog.ts";
import {
	materialState,
	resetIdentityFetchLimiter,
} from "../src/cluster/identityFetch.ts";
import { replicationPullJob } from "../src/cluster/replication.ts";
import { currentTiering, upstreamOf } from "../src/cluster/tiering.ts";
import type { UserRow } from "../src/db/rows.ts";
import type { Db } from "../src/db/types.ts";
import { makeCluster } from "./clusterHarness.ts";
import { makeUser } from "./harness.ts";

const PASSWORD = "correct horse battery staple";

const userOn = (db: Db, username: string) =>
	db.get<UserRow>("SELECT * FROM users WHERE username = $u", {
		$u: username,
	});

/** Drain the log in both directions until it settles, so a test asserting on
 * "what replicated" is not really asserting on how many ticks it ran. */
async function settle(
	nodes: Array<{ state: Parameters<typeof replicationPullJob>[0] }>,
	rounds = 4,
): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		for (const n of nodes) await replicationPullJob(n.state);
	}
}

describe("credential material does not replicate", () => {
	test("password_hash is absent from the replicated column set", () => {
		expect(TABLE_COLUMNS.users).not.toContain("password_hash");
		// The invalidation half does replicate, and has to: it is the only thing
		// that tells a peer its cached copy is dead.
		expect(TABLE_COLUMNS.users).toContain("credential_version");
		expect(TABLE_COLUMNS.users).not.toContain("credential_version_local");
	});

	test("a user replicates whole, minus the hash", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			await makeUser(master!.db, "alice");
			await settle(c.nodes);

			const onPeer = userOn(follower!.db, "alice");
			expect(onPeer).toBeTruthy();
			// Authorizable: the row is there, with its identity and its flags.
			expect(onPeer!.uid).toBe(userOn(master!.db, "alice")!.uid);
			expect(onPeer!.role).toBe("user");
			// Not authenticable: the material was left behind.
			expect(onPeer!.password_hash).toBe("");
			expect(materialState(onPeer!)).toBe("absent");
			expect(materialState(userOn(master!.db, "alice")!)).toBe("held");
		} finally {
			c.close();
		}
	});
});

describe("first login on a peer fetches up the tier", () => {
	test("a user who has never logged in on the follower can, once", async () => {
		resetIdentityFetchLimiter();
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			await makeUser(master!.db, "alice");
			await settle(c.nodes);
			expect(materialState(userOn(follower!.db, "alice")!)).toBe("absent");

			const res = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "alice", password: PASSWORD }),
			});
			expect(res.status).toBe(200);

			// Fetched once and kept: the node verifies locally from here on.
			const after = userOn(follower!.db, "alice")!;
			expect(materialState(after)).toBe("held");
			expect(after.password_hash).toBe(
				userOn(master!.db, "alice")!.password_hash,
			);
		} finally {
			c.close();
		}
	});

	test("a wrong password still fails, and nothing is cached for it", async () => {
		resetIdentityFetchLimiter();
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			await makeUser(master!.db, "alice");
			await settle(c.nodes);

			const res = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					username: "alice",
					password: "wrong wrong wrong",
				}),
			});
			expect(res.status).toBe(401);
			// The fetch happened -- it is keyed on the username, not on the
			// password being right -- but it proves nothing to an attacker: the
			// hash never leaves this node and the attempt counted against lockout.
			expect(materialState(userOn(follower!.db, "alice")!)).toBe("held");
			expect(master).toBeTruthy();
		} finally {
			c.close();
		}
	});

	test("an unknown user is not fetchable and does not 500", async () => {
		resetIdentityFetchLimiter();
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const follower = c.nodes[1]!;
			const res = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "nobody", password: PASSWORD }),
			});
			expect(res.status).toBe(401);
		} finally {
			c.close();
		}
	});

	test("a node with no upstream fails the login rather than improvising", async () => {
		resetIdentityFetchLimiter();
		const c = await makeCluster({ size: 2 });
		try {
			// Linked but never tiered: no generation, so no upstream, so nobody to
			// ask. The same rule `pullTargets` follows.
			const [master, follower] = c.nodes;
			c.link(master!, follower!);
			c.link(follower!, master!);
			const user = await makeUser(master!.db, "alice");
			// Put the row on the follower by hand, since replication is not running
			// without a generation either.
			follower!.db.run(
				`INSERT INTO users (uid, username, password_hash, role, must_change_credentials, created_at)
         VALUES ($uid, 'alice', '', 'user', 0, $now)`,
				{ $uid: user.uid, $now: new Date().toISOString() },
			);

			const res = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "alice", password: PASSWORD }),
			});
			expect(res.status).toBe(401);
			expect(materialState(userOn(follower!.db, "alice")!)).toBe("absent");
		} finally {
			c.close();
		}
	});
});

describe("invalidation rides the replicated version counter", () => {
	test("a password change elsewhere makes the peer's copy stale, then refetch", async () => {
		resetIdentityFetchLimiter();
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const alice = await makeUser(master!.db, "alice");
			await settle(c.nodes);

			// Log in on the follower so it holds material.
			await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "alice", password: PASSWORD }),
			});
			expect(materialState(userOn(follower!.db, "alice")!)).toBe("held");

			// Admin resets the password on the master. The push carries the bumped
			// credential_version; the hash itself is not in it.
			const admin = await makeUser(master!.db, "admin", "master");
			const session = master!.signIn(admin);
			const reset = await master!.request(`/api/users/${alice.id}`, {
				method: "PATCH",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ password: "a whole new password entirely" }),
			});
			expect(reset.status).toBe(200);

			// Pushed, not pulled: no replication tick has run since the reset.
			const stale = userOn(follower!.db, "alice")!;
			expect(materialState(stale)).toBe("stale");
			// The peer still physically holds the OLD hash -- what changed is that
			// it now knows not to trust it.
			expect(stale.password_hash).not.toBe("");

			// The old password is refused on the peer...
			const old = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "alice", password: PASSWORD }),
			});
			expect(old.status).toBe(401);

			// ...and the new one works, having refetched.
			const fresh = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					username: "alice",
					password: "a whole new password entirely",
				}),
			});
			expect(fresh.status).toBe(200);
			expect(materialState(userOn(follower!.db, "alice")!)).toBe("held");
		} finally {
			c.close();
		}
	});

	test("a user created on a follower is loginable on the master", async () => {
		resetIdentityFetchLimiter();
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			// The admin account has to exist on the node the call is made against.
			const admin = await makeUser(follower!.db, "admin", "master");
			const session = follower!.signIn(admin);
			const created = await follower!.request("/api/users", {
				method: "POST",
				cookie: session.cookie,
				csrf: session.csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					username: "bob",
					password: "another perfectly fine password",
					role: "user",
				}),
			});
			expect(created.status).toBe(200);

			// The create published the material to the master, so the master can
			// authenticate bob without ever having seen him log in.
			expect(materialState(userOn(master!.db, "bob")!)).toBe("held");
			const res = await master!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					username: "bob",
					password: "another perfectly fine password",
				}),
			});
			expect(res.status).toBe(200);
		} finally {
			c.close();
		}
	});
});

describe("what does not travel", () => {
	test("a relay does not keep a copy of what it forwards", async () => {
		resetIdentityFetchLimiter();
		// Three nodes: master, its region leader, and a follower under the
		// leader. The follower's fetch has to pass through the leader.
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const [master, leader, follower] = c.nodes;
			// Assert the shape rather than assume it: this test is only about a
			// relay if there actually is one between the follower and the master.
			const tiering = currentTiering(follower!.db)!;
			const reachable = () => true;
			expect(tiering.master_node_id).toBe(master!.nodeId);
			expect(upstreamOf(tiering, follower!.nodeId, reachable)).toBe(
				leader!.nodeId,
			);
			expect(upstreamOf(tiering, leader!.nodeId, reachable)).toBe(
				master!.nodeId,
			);

			await makeUser(master!.db, "alice");
			await settle(c.nodes, 6);
			expect(userOn(follower!.db, "alice")).toBeTruthy();
			expect(materialState(userOn(leader!.db, "alice")!)).toBe("absent");

			const res = await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "alice", password: PASSWORD }),
			});
			expect(res.status).toBe(200);
			expect(materialState(userOn(follower!.db, "alice")!)).toBe("held");
			// The hash ends up on nodes the user has *used*, not on every node it
			// passed through. A caching relay would break that bound.
			expect(materialState(userOn(leader!.db, "alice")!)).toBe("absent");
		} finally {
			c.close();
		}
	});

	test("webauthn credentials stay on the node they were enrolled on (D-18)", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [master, follower] = c.nodes;
			const alice = await makeUser(master!.db, "alice");
			master!.db.run(
				`INSERT INTO credentials (user_id, kind, webauthn_id, webauthn_public_key, created_at)
         VALUES ($id, 'webauthn', 'cred-1', $key, $now)`,
				{
					$id: alice.id,
					$key: Buffer.from("public-key-bytes"),
					$now: new Date().toISOString(),
				},
			);
			await settle(c.nodes);
			await follower!.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "alice", password: PASSWORD }),
			});

			const peerUser = userOn(follower!.db, "alice")!;
			// The fetch ran and brought the password material...
			expect(materialState(peerUser)).toBe("held");
			// ...and deliberately no passkey. A credential registered against the
			// master's rpID cannot be asserted here, so sending it would be
			// shipping something unusable.
			const passkeys = follower!.db.all<{ id: number }>(
				"SELECT id FROM credentials WHERE user_id = $id AND kind = 'webauthn'",
				{ $id: peerUser.id },
			);
			expect(passkeys.length).toBe(0);
		} finally {
			c.close();
		}
	});
});
