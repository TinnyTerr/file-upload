/**
 * Per-node credentials, rotation with overlap, and the router split
 * (`cluster/credentials.ts`, redesign §5.13, Phase 9 — S2 and S3).
 *
 * The three properties worth pinning down are the ones the shared token did not
 * have: a credential names *one pair*, so it cannot be replayed as anybody
 * else; rotating one never leaves a peer unable to call; and the shared token
 * stops being honoured on its own, without an operator step, once the mesh has
 * finished credentialing itself.
 *
 * Everything here runs over real HTTP between real nodes, so what is asserted
 * is what the wire does.
 */

import { describe, expect, test } from "bun:test";
import {
	credentialMaintenanceJob,
	credentialSummary,
	legacyTokenAcceptable,
	mintEnrollmentToken,
	performExchange,
	ROTATION_OVERLAP_MS,
} from "../src/cluster/credentials.ts";
import { enrollWithMaster } from "../src/cluster/membership.ts";
import type {
	ClusterNodeRow,
	ClusterPeerCredentialRow,
} from "../src/db/rows.ts";
import { type ClusterNodeHarness, makeCluster } from "./clusterHarness.ts";
import { makeUser } from "./harness.ts";

/** The secret `from` presents when it calls `to`. */
function outbound(from: ClusterNodeHarness, to: ClusterNodeHarness): string {
	return (
		from.db.get<ClusterNodeRow>(
			"SELECT * FROM cluster_nodes WHERE node_id = $id",
			{ $id: to.nodeId },
		)?.token ?? ""
	);
}

function inboundRows(
	node: ClusterNodeHarness,
	peer: ClusterNodeHarness,
): ClusterPeerCredentialRow[] {
	return node.db.all<ClusterPeerCredentialRow>(
		"SELECT * FROM cluster_peer_credentials WHERE peer_node_id = $id ORDER BY id",
		{ $id: peer.nodeId },
	);
}

describe("cluster per-node credentials", () => {
	test("an exchange gives each direction its own secret", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			await c.credentialAll();

			const aToB = outbound(a, b);
			const bToA = outbound(b, a);
			expect(aToB).not.toBe("");
			expect(bToA).not.toBe("");
			// Two directions, two secrets, neither of them the shared token.
			expect(aToB).not.toBe(bToA);
			expect(aToB).not.toBe(a.token);
			expect(bToA).not.toBe(a.token);

			// Each is accepted only by the node it was minted for. b's secret for a
			// is not a credential *on* b.
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: bToA })).status,
			).toBe(401);
			expect(
				(await a.asPeer("/api/cluster/ping", { secret: bToA })).status,
			).toBe(200);
		} finally {
			c.close();
		}
	});

	test("the shared token retires itself once every peer is credentialed", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];

			// Migration state: linked, uncredentialed, so the shared token is how
			// an upgraded cluster keeps working while it re-keys itself.
			expect(legacyTokenAcceptable(a.db)).toBe(true);
			expect((await a.asPeer("/api/cluster/ping")).status).toBe(200);

			await c.credentialAll();

			expect(legacyTokenAcceptable(a.db)).toBe(false);
			expect((await a.asPeer("/api/cluster/ping")).status).toBe(401);
			expect(
				(await a.asPeer("/api/cluster/ping", { secret: outbound(b, a) }))
					.status,
			).toBe(200);
			expect(credentialSummary(a.db)).toMatchObject({
				peers: 1,
				credentialed: 1,
				legacy_token_accepted: false,
			});
		} finally {
			c.close();
		}
	});

	test("a three-node mesh never locks a peer out while migrating", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const [a, b, cc] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			// Credential one edge only. b's inbound set is still incomplete (c has
			// not exchanged), so b keeps honouring the shared token — which is the
			// only thing c has to call it with.
			await performExchange(a.state, {
				baseUrl: b.baseUrl,
				auth: b.token,
				expectNodeId: b.nodeId,
			});
			expect(legacyTokenAcceptable(b.db)).toBe(true);
			expect((await b.asPeer("/api/cluster/ping")).status).toBe(200);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: outbound(a, b) }))
					.status,
			).toBe(200);

			await performExchange(cc.state, {
				baseUrl: b.baseUrl,
				auth: b.token,
				expectNodeId: b.nodeId,
			});
			expect(legacyTokenAcceptable(b.db)).toBe(false);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: outbound(cc, b) }))
					.status,
			).toBe(200);
		} finally {
			c.close();
		}
	});

	test("the maintenance job is the whole migration", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			for (const node of c.nodes) await credentialMaintenanceJob(node.state);
			for (const node of c.nodes) {
				expect(credentialSummary(node.db)).toMatchObject({
					peers: 2,
					credentialed: 2,
					legacy_token_accepted: false,
				});
			}
			// And the mesh still works, in both directions, on the new secrets.
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: outbound(a, b) }))
					.status,
			).toBe(200);
			expect(
				(await a.asPeer("/api/cluster/ping", { secret: outbound(b, a) }))
					.status,
			).toBe(200);
		} finally {
			c.close();
		}
	});

	test("rotation keeps the retired secret alive for the overlap window", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			await c.credentialAll();
			const firstAtoB = outbound(a, b);

			await performExchange(a.state, {
				baseUrl: b.baseUrl,
				auth: firstAtoB,
				expectNodeId: b.nodeId,
			});
			const secondAtoB = outbound(a, b);
			expect(secondAtoB).not.toBe(firstAtoB);

			// The new one works, and the old one has not been yanked out from under
			// anything still holding it — which is precisely what S3 was.
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: secondAtoB })).status,
			).toBe(200);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: firstAtoB })).status,
			).toBe(200);

			const rows = inboundRows(b, a);
			expect(rows).toHaveLength(2);
			const retired = rows[0]!;
			expect(retired.expires_at).not.toBeNull();
			const remaining = Date.parse(retired.expires_at!) - Date.now();
			expect(remaining).toBeGreaterThan(0);
			expect(remaining).toBeLessThanOrEqual(ROTATION_OVERLAP_MS);
			expect(rows[1]!.expires_at).toBeNull();
		} finally {
			c.close();
		}
	});

	test("an expired overlap stops being accepted and is swept", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			await c.credentialAll();
			const firstAtoB = outbound(a, b);
			await performExchange(a.state, {
				baseUrl: b.baseUrl,
				auth: firstAtoB,
				expectNodeId: b.nodeId,
			});

			// Wind the overlap clock past its end rather than waiting ten minutes.
			b.db.run(
				"UPDATE cluster_peer_credentials SET expires_at = $then WHERE expires_at IS NOT NULL",
				{ $then: new Date(Date.now() - 1000).toISOString() },
			);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: firstAtoB })).status,
			).toBe(401);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: outbound(a, b) }))
					.status,
			).toBe(200);

			await credentialMaintenanceJob(b.state);
			expect(inboundRows(b, a)).toHaveLength(1);
		} finally {
			c.close();
		}
	});

	test("a credential may only re-key its own node", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			c.linkAll();
			const [a, b, cc] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			await c.credentialAll();
			const beforeAtoC = outbound(a, cc);

			// a authenticates to c perfectly well — and still may not rotate what c
			// presents to b, which would cut b out of the mesh.
			const res = await cc.asPeer("/api/cluster/credentials/exchange", {
				secret: outbound(a, cc),
				json: { node_id: b.nodeId, inbound_secret: "attacker-chosen" },
			});
			expect(res.status).toBe(403);
			expect(outbound(cc, b)).not.toBe("attacker-chosen");
			expect(outbound(a, cc)).toBe(beforeAtoC);
		} finally {
			c.close();
		}
	});
});

describe("cluster enrolment tokens", () => {
	test("are one-use, scoped, and expire", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			await c.credentialAll();
			// b now refuses the shared token, so an enrolment token is the only way
			// a stranger gets an exchange.
			const minted = mintEnrollmentToken(b.db, { createdBy: "operator" });

			const first = await b.asPeer("/api/cluster/credentials/exchange", {
				secret: minted.token,
				json: {
					node_id: "node-z",
					name: "z",
					base_url: "http://127.0.0.1:9/",
					inbound_secret: "z-accepts-this",
				},
			});
			expect(first.status).toBe(200);
			expect(outbound(b, { nodeId: "node-z" } as ClusterNodeHarness)).toBe(
				"z-accepts-this",
			);

			// Burnt on success.
			const second = await b.asPeer("/api/cluster/credentials/exchange", {
				secret: minted.token,
				json: {
					node_id: "node-y",
					name: "y",
					base_url: "http://127.0.0.1:9/",
					inbound_secret: "y-accepts-this",
				},
			});
			expect(second.status).toBe(401);

			// An introduction names its subject, so relaying it does not make it
			// usable by whoever it passed through.
			const intro = mintEnrollmentToken(b.db, {
				subjectNodeId: "node-w",
				createdBy: `node:${a.nodeId}`,
			});
			const wrongSubject = await b.asPeer("/api/cluster/credentials/exchange", {
				secret: intro.token,
				json: {
					node_id: "node-v",
					base_url: "http://127.0.0.1:9/",
					inbound_secret: "nope",
				},
			});
			expect(wrongSubject.status).toBe(401);

			const expired = mintEnrollmentToken(b.db, {
				createdBy: "operator",
				ttlMs: -1000,
			});
			expect(
				(
					await b.asPeer("/api/cluster/credentials/exchange", {
						secret: expired.token,
						json: {
							node_id: "node-u",
							base_url: "http://127.0.0.1:9/",
							inbound_secret: "nope",
						},
					})
				).status,
			).toBe(401);
		} finally {
			c.close();
		}
	});

	test("buy exactly one exchange and nothing else", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const b = c.nodes[1]!;
			await c.credentialAll();
			const minted = mintEnrollmentToken(b.db, { createdBy: "operator" });
			// Not the change log, not the identity fetch, not a heartbeat.
			expect(
				(await b.asPeer("/api/cluster/changes", { secret: minted.token }))
					.status,
			).toBe(401);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: minted.token })).status,
			).toBe(401);
		} finally {
			c.close();
		}
	});
});

describe("enrolling", () => {
	test("joining hands out introductions, never a peer's credential", async () => {
		const c = await makeCluster({ size: 3 });
		try {
			const [a, b, cc] = c.nodes as [
				ClusterNodeHarness,
				ClusterNodeHarness,
				ClusterNodeHarness,
			];
			// a and b are an established cluster; c is the newcomer.
			c.link(a, b);
			c.link(b, a);
			await performExchange(a.state, {
				baseUrl: b.baseUrl,
				auth: b.token,
				expectNodeId: b.nodeId,
			});

			const invitation = mintEnrollmentToken(a.db, { createdBy: "operator" });
			const result = await enrollWithMaster(
				cc.state,
				a.baseUrl,
				invitation.token,
			);
			expect(result.status).toBe("ok");

			// The newcomer ends up with a pair credential to each of them, and
			// neither of those is the other's.
			const toA = outbound(cc, a);
			const toB = outbound(cc, b);
			expect(toA).not.toBe("");
			expect(toB).not.toBe("");
			expect(toA).not.toBe(toB);
			expect(
				(await a.asPeer("/api/cluster/ping", { secret: toA })).status,
			).toBe(200);
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: toB })).status,
			).toBe(200);
			// …and it is a real member: both of them can call it back.
			expect(
				(await cc.asPeer("/api/cluster/ping", { secret: outbound(a, cc) }))
					.status,
			).toBe(200);
			expect(
				(await cc.asPeer("/api/cluster/ping", { secret: outbound(b, cc) }))
					.status,
			).toBe(200);
		} finally {
			c.close();
		}
	});

	test("the operator link flow ends with one row per node, paired", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			const user = await makeUser(a.db, "operator", "master");
			const { cookie, csrf } = a.signIn(user);

			// What the operator does: generate a token on b, paste it into a.
			const invitation = mintEnrollmentToken(b.db, { createdBy: "operator" });
			const res = await a.request("/api/cluster/nodes", {
				method: "POST",
				cookie,
				csrf,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: b.nodeName,
					base_url: b.baseUrl,
					token: invitation.token,
				}),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).enroll.status).toBe("ok");

			// The placeholder row a created (base URL, no node id) became b's row
			// rather than lingering next to one — otherwise the dashboard shows a
			// ghost peer stuck on the shared token forever.
			const rows = a.db.all<ClusterNodeRow>("SELECT * FROM cluster_nodes");
			expect(rows).toHaveLength(1);
			expect(rows[0]!.node_id).toBe(b.nodeId);
			expect(rows[0]!.credential_at).not.toBeNull();
			expect(rows[0]!.token).not.toBe(invitation.token);

			// Both directions live, and neither node honours the shared token any
			// more.
			expect(
				(await b.asPeer("/api/cluster/ping", { secret: outbound(a, b) }))
					.status,
			).toBe(200);
			expect(
				(await a.asPeer("/api/cluster/ping", { secret: outbound(b, a) }))
					.status,
			).toBe(200);
			expect(legacyTokenAcceptable(a.db)).toBe(false);
			expect(legacyTokenAcceptable(b.db)).toBe(false);
		} finally {
			c.close();
		}
	});

	test("a re-join uses the credential it already holds, not the bootstrap token", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			const invitation = mintEnrollmentToken(a.db, { createdBy: "operator" });
			expect(
				(await enrollWithMaster(b.state, a.baseUrl, invitation.token)).status,
			).toBe("ok");
			const established = outbound(b, a);

			// The token is spent; a restart re-running joinCluster must not need it.
			// This is what makes a one-use MASTER_TOKEN survive every boot after the
			// first.
			expect(
				(await enrollWithMaster(b.state, a.baseUrl, invitation.token)).status,
			).toBe("ok");
			expect(outbound(b, a)).toBe(established);
		} finally {
			c.close();
		}
	});
});

describe("the node-to-node router split", () => {
	test("a peer credential does not reach the management surface", async () => {
		const c = await makeCluster({ size: 2 });
		try {
			c.linkAll();
			const [a, b] = c.nodes as [ClusterNodeHarness, ClusterNodeHarness];
			await c.credentialAll();
			const secret = outbound(b, a);
			// Both prefixes are /api/cluster; the guard is what separates them.
			expect((await a.asPeer("/api/cluster/changes", { secret })).status).toBe(
				200,
			);
			for (const path of [
				"/api/cluster/self",
				"/api/cluster/nodes",
				"/api/cluster/topology",
			]) {
				expect((await a.asPeer(path, { secret })).status).toBe(401);
			}
		} finally {
			c.close();
		}
	});
});
