/** The node-to-node surface (redesign §5.13, Phase 9).
 *
 * Everything here authenticates as a *node*, with a per-pair credential
 * (`cluster/credentials.ts`) — never as a user. That is the whole reason it is
 * its own file: the session-authenticated management surface in
 * `routes/cluster.ts` used to sit interleaved with these handlers, two auth
 * models in one 625-line router, and telling by eye which guard a given route
 * had was the failure mode. Here there is exactly one guard, applied at the
 * mount, and `routes/cluster.ts` cannot reach these paths.
 *
 * Mounted at /api/cluster in app.ts, ahead of `clusterRouter` — the two share a
 * prefix and no path, so the order only decides which one 404s first.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { Request, Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import {
	type ChangeEntry,
	logHead,
	readChanges,
} from "../cluster/changelog.ts";
import {
	acceptExchange,
	consumeEnrollmentToken,
	type ExchangeRequest,
	mintEnrollmentToken,
	requirePeer,
} from "../cluster/credentials.ts";
import { computeDigest } from "../cluster/digest.ts";
import * as clusterHttp from "../cluster/http.ts";
import {
	allowIdentityFetch,
	applyPublishedMaterial,
	type CredentialMaterial,
	fetchMaterial,
	localMaterial,
} from "../cluster/identityFetch.ts";
import { enrollWithMaster, upsertPeer } from "../cluster/membership.ts";
import {
	blobPath,
	localChunk,
	manifestOf,
	markChunk,
	touchChunk,
	writeChunkAt,
} from "../cluster/placement.ts";
import {
	type GrantRequest,
	grantReservation,
	renewReservation,
	settleReservation,
} from "../cluster/quota.ts";
import { applyPushedRevocation } from "../cluster/revocation.ts";
import { selfStats } from "../cluster/selfStats.ts";
import {
	currentTiering,
	isMaster,
	retierForNewMember,
	type Tiering,
} from "../cluster/tiering.ts";
import type { ClusterNodeRow, UserRow } from "../db/rows.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp } from "../middleware/auth.ts";
import { safeJoin, storageRoot } from "../storage/paths.ts";

const log = getLogger("app.cluster.routes.node");

interface ContentBlobRow {
	id: number;
	storage_path: string;
	stored_sha256: string;
	transform_key: string;
}

/** Read a pushed chunk's raw body, refusing anything that is not exactly the
 * length the manifest says. The cap is the point: a body is trusted only after
 * its hash matches, and an unbounded read would let a peer decide how much
 * memory this handler allocates. */
async function readBody(
	req: Request,
	expected: number,
): Promise<Buffer | null> {
	const pieces: Buffer[] = [];
	let total = 0;
	for await (const piece of req as AsyncIterable<Buffer>) {
		total += piece.length;
		if (total > expected) return null;
		pieces.push(piece);
	}
	return total === expected ? Buffer.concat(pieces) : null;
}

export function clusterNodeRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	// The default guard: a pair credential, or the shared token while
	// `legacyTokenAcceptable()` still holds. An enrolment token buys one
	// credential exchange and is refused everywhere else, so it is opted into
	// per route rather than allowed here.
	const peerAuth = requirePeer(state);
	const enrollAuth = requirePeer(state, { allowEnrollment: true });

	// ── credentials (redesign §5.13) ────────────────────────────────────────
	//
	// One endpoint establishes, migrates and rotates, because they are the same
	// operation: both directions of a pair are re-minted in a single round-trip.
	// What differs is only what authorized the call.

	router.post("/credentials/exchange", enrollAuth, (req, res) => {
		const body = req.body as Partial<ExchangeRequest>;
		const auth = req.peerAuth!;
		if (!body?.node_id || !body?.inbound_secret) {
			res
				.status(400)
				.json({ detail: "node_id and inbound_secret are required" });
			return;
		}
		// A credentialed caller may only re-key *itself*. Without this, any peer
		// could rotate the credential we present to any other peer and cut it out
		// of the mesh.
		if (auth.method === "credential" && auth.nodeId !== body.node_id) {
			res.status(403).json({
				detail: "a pair credential may only rotate its own node's secret",
			});
			return;
		}
		if (
			auth.method === "enrollment" &&
			auth.nodeId &&
			auth.nodeId !== body.node_id
		) {
			res
				.status(403)
				.json({ detail: "this enrolment token was minted for another node" });
			return;
		}
		let result: ReturnType<typeof acceptExchange>;
		try {
			result = acceptExchange(state, body as ExchangeRequest);
		} catch {
			res.status(409).json({
				detail: "that node is not linked here; link it before exchanging",
			});
			return;
		}
		// Burnt only now, so a failed exchange leaves the operator a token to
		// retry with rather than a dead one.
		if (auth.method === "enrollment" && auth.enrollmentToken) {
			consumeEnrollmentToken(db, auth.enrollmentToken, body.node_id);
		}
		recordAudit(db, {
			actor: `node:${body.node_id}`,
			action: "cluster.credential_exchanged",
			target: `node:${body.node_id}`,
			ip: clientIp(state, req),
		});
		res.json(result);
	});

	// An introduction. The master answers a `/join` by asking every peer for one
	// of these on the joiner's behalf, because the alternative — handing the
	// joiner each peer's credential — is precisely S1. Any credentialed peer may
	// ask: one that is compromised can already call `/changes` and `/revocations`
	// here, so minting a scoped, one-use, fifteen-minute token for a third node
	// is not a privilege it did not have.
	router.post("/credentials/introduce", peerAuth, (req, res) => {
		const forNodeId = (req.body as { for_node_id?: string })?.for_node_id;
		if (!forNodeId) {
			res.status(400).json({ detail: "for_node_id is required" });
			return;
		}
		const minted = mintEnrollmentToken(db, {
			subjectNodeId: forNodeId,
			createdBy: `node:${req.peerAuth?.nodeId ?? "unknown"}`,
		});
		res.json({ ...minted, node_id: state.settings.nodeId });
	});

	// ── membership handshake ────────────────────────────────────────────────

	interface JoinBody {
		node_id: string;
		name: string;
		base_url: string;
		/** The shared cluster token, still sent so a half-migrated mesh can call
		 * back before the pair credential exists. Ignored once one does. */
		token?: string;
		archive_enabled?: boolean;
		replication_mode?: string;
		disk_total_bytes?: number;
		disk_free_bytes?: number;
		used_bytes?: number;
		/** The sender's tiering generation. Adopted only if newer than ours; the
		 * sender's *role* is never taken from the body (S4). */
		tiering?: Tiering | null;
	}

	function peerOpts(body: JoinBody) {
		return {
			nodeId: body.node_id,
			name: body.name,
			baseUrl: body.base_url,
			token: body.token ?? "",
			archiveEnabled: body.archive_enabled !== false,
			replicationMode: body.replication_mode ?? "full",
			diskTotalBytes: body.disk_total_bytes ?? 0,
			diskFreeBytes: body.disk_free_bytes ?? 0,
			usedBytes: body.used_bytes ?? 0,
			tiering: body.tiering,
		};
	}

	// A pair credential, not an enrolment token: by the time anyone joins, the
	// exchange has already happened (membership.ts::enrollWithMaster does it
	// first), so letting an enrolment token in here would widen what it buys
	// beyond the one exchange it is for.
	router.post(
		"/join",
		peerAuth,
		asyncHandler(async (req, res) => {
			const body = req.body as JoinBody;
			if (!body?.node_id || !body?.name || !body?.base_url) {
				res
					.status(400)
					.json({ detail: "node_id, name and base_url are required" });
				return;
			}
			const peer = upsertPeer(state, peerOpts(body));
			recordAudit(db, {
				actor: `node:${body.node_id}`,
				action: "cluster.node_joined",
				target: `node:${peer.id}`,
				ip: clientIp(state, req),
			});
			// A node the current generation has never seen is admitted immediately
			// rather than waiting out the drift hold-down: until it is in a snapshot
			// it has no upstream, so its writes reach nobody. The response below then
			// carries the generation that names it, which is how the joiner learns its
			// own role in the same round-trip.
			retierForNewMember(state, body.node_id);

			// Every other node this one knows of, each with a one-use introduction
			// so the joiner can establish its own credential there. This used to
			// carry `token` — every peer's standing credential, to anything holding
			// the shared one (S1).
			const others = db
				.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
				.filter((n) => n.node_id && n.node_id !== body.node_id && n.base_url);
			const peers: Array<Record<string, unknown>> = [];
			for (const n of others) {
				let enrollmentToken: string | null = null;
				try {
					const intro = (await clusterHttp.postJson(
						`${n.base_url.replace(/\/$/, "")}/api/cluster/credentials/introduce`,
						n.token,
						{ for_node_id: body.node_id },
						10_000,
					)) as { token?: string } | null;
					enrollmentToken = intro?.token ?? null;
				} catch (err) {
					// The joiner meets that peer later: the credential maintenance job
					// on either side retries, so an unreachable peer costs the mesh a
					// few minutes rather than an edge.
					log.debug(
						`could not obtain an introduction to ${n.node_id} for ${body.node_id}: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
				peers.push({
					node_id: n.node_id,
					name: n.name,
					base_url: n.base_url,
					archive_enabled: !!n.archive_enabled,
					replication_mode: n.replication_mode,
					enrollment_token: enrollmentToken,
				});
			}
			res.json({ self: selfStats(state), peers });
		}),
	);

	router.post(
		"/enroll",
		enrollAuth,
		asyncHandler(async (req, res) => {
			const body = req.body as { master_url?: string; master_token?: string };
			if (!body?.master_url || !body?.master_token) {
				res
					.status(400)
					.json({ detail: "master_url and master_token are required" });
				return;
			}
			const result = await enrollWithMaster(
				state,
				body.master_url,
				body.master_token,
			);
			if (result.status === "ok" && req.peerAuth?.enrollmentToken) {
				consumeEnrollmentToken(db, req.peerAuth.enrollmentToken, null);
			}
			res.json(result);
		}),
	);

	router.post("/heartbeat", peerAuth, (req, res) => {
		const body = req.body as JoinBody;
		if (!body?.node_id || !body?.name || !body?.base_url) {
			res
				.status(400)
				.json({ detail: "node_id, name and base_url are required" });
			return;
		}
		upsertPeer(state, peerOpts(body));
		res.json(selfStats(state));
	});

	router.get("/ping", peerAuth, (_req, res) => {
		res.json(selfStats(state));
	});

	// ── blobs ───────────────────────────────────────────────────────────────

	function findLocalBlob(
		storedSha256: string,
		transform: string | null,
	): ContentBlobRow | undefined {
		if (transform) {
			return db.get<ContentBlobRow>(
				"SELECT * FROM content_blobs WHERE stored_sha256 = $hash AND transform_key = $t",
				{
					$hash: storedSha256,
					$t: transform,
				},
			);
		}
		return db.get<ContentBlobRow>(
			"SELECT * FROM content_blobs WHERE stored_sha256 = $hash",
			{ $hash: storedSha256 },
		);
	}

	// Cheap existence probe used by cluster/cacheEviction.ts before evicting a
	// locally-cached blob -- confirms a full-replica peer already has these
	// exact bytes without transferring them. No response body (just the
	// status code), so a large eviction pass never streams file content just
	// to check durability.
	router.head("/blobs/:storedSha256", peerAuth, (req, res) => {
		const transform =
			typeof req.query.transform === "string" ? req.query.transform : null;
		const blob = findLocalBlob(req.params.storedSha256, transform);
		if (!blob) {
			res.status(404).end();
			return;
		}
		let path: string;
		try {
			path = safeJoin(storageRoot(), blob.storage_path);
		} catch {
			res.status(404).end();
			return;
		}
		res.status(existsSync(path) ? 200 : 404).end();
	});

	router.get("/blobs/:storedSha256", peerAuth, (req, res) => {
		const transform =
			typeof req.query.transform === "string" ? req.query.transform : null;
		const blob = findLocalBlob(req.params.storedSha256, transform);
		if (!blob) {
			res.status(404).json({ detail: "blob not found" });
			return;
		}
		let path: string;
		try {
			path = safeJoin(storageRoot(), blob.storage_path);
		} catch {
			res.status(404).json({ detail: "blob not found" });
			return;
		}
		if (!existsSync(path)) {
			res.status(404).json({ detail: "blob bytes missing on this node" });
			return;
		}
		const stat = statSync(path);
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(stat.size),
			"X-Blob-Transform": blob.transform_key,
			"X-Blob-Stored-Sha256": blob.stored_sha256,
			"X-Blob-Storage-Path": blob.storage_path,
		});
		createReadStream(path).pipe(res);
	});

	// ── chunks (redesign §5.11) ─────────────────────────────────────────────
	//
	// The blob endpoints above move a whole file; these move one chunk of one,
	// which is what lets a node hold part of something bigger than its disk and
	// what makes a read cost a request to a node that has the bytes instead of
	// a walk down the peer list. Both directions live here: GET is a read-time
	// fetch or an eviction's durability probe, POST is placement pushing a
	// durability copy onto this node.

	router.head("/chunks/:storedSha256", peerAuth, (req, res) => {
		res.status(localChunk(db, req.params.storedSha256) ? 200 : 404).end();
	});

	router.get("/chunks/:storedSha256", peerAuth, (req, res) => {
		const sha256 = req.params.storedSha256;
		const local = localChunk(db, sha256);
		if (!local) {
			res.status(404).json({ detail: "chunk not held on this node" });
			return;
		}
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(local.size),
			"X-Chunk-Sha256": sha256,
		});
		// A byte range of the blob's file -- the chunk store *is* the blob store
		// (cluster/placement.ts), so serving one is a positional read.
		createReadStream(local.path, {
			start: local.offset,
			end: local.offset + local.size - 1,
		}).pipe(res);
		touchChunk(db, sha256);
	});

	router.post(
		"/chunks/:storedSha256",
		peerAuth,
		asyncHandler(async (req, res) => {
			const sha256 = req.params.storedSha256;
			const blobUid = typeof req.query.blob === "string" ? req.query.blob : "";
			const blob = blobUid
				? db.get<ContentBlobRow & { id: number }>(
						"SELECT * FROM content_blobs WHERE uid = $uid",
						{ $uid: blobUid },
					)
				: undefined;
			if (!blob) {
				// The row is on its way through the change log. 409 rather than 404
				// because the right response is for the pusher to try again later,
				// not to conclude the chunk is unwanted.
				res.status(409).json({ detail: "blob not replicated here yet" });
				return;
			}
			const slot = manifestOf(db, blob.id).find((s) => s.sha256 === sha256);
			if (!slot) {
				res.status(409).json({ detail: "chunk is not part of that blob here" });
				return;
			}
			const path = blobPath(blob);
			if (!path) {
				res.status(500).json({ detail: "invalid storage path" });
				return;
			}

			const body = await readBody(req, slot.size);
			if (!body) {
				res.status(400).json({ detail: "chunk body is the wrong length" });
				return;
			}
			// Content-addressed means the address is checkable, so it is checked:
			// these bytes are about to be written into the middle of a file the
			// read path will decrypt, where a corrupt range has no other signal.
			if (createHash("sha256").update(body).digest("hex") !== sha256) {
				res.status(400).json({ detail: "chunk failed its hash check" });
				return;
			}
			writeChunkAt(path, slot.offset, body);
			// Pinned: a placement push is a durability copy by definition, even
			// onto a cache node, and the eviction pass must leave it alone.
			markChunk(db, state.settings.nodeId, sha256, {
				state: "present",
				size: slot.size,
				pinned: true,
			});
			touchChunk(db, sha256);
			res.json({ stored: true, chunk_sha256: sha256, size_bytes: slot.size });
		}),
	);

	router.get("/digest", peerAuth, (_req, res) => {
		res.json(computeDigest(state));
	});

	// ── the replication change log (redesign §5.7) ──────────────────────────
	//
	// One endpoint, both directions. A peer pulls from here with the cursor it
	// last reached; whether that is a follower reading down from its master or
	// the master reading up from a follower is the caller's business, not this
	// handler's -- which is what lets the region tier slot in later without a
	// new endpoint.
	//
	// Ascending from `after`, front-truncated at `limit`. Returning the newest
	// N instead would silently strand everything older, which is exactly the
	// bug B2 was in the event pipeline.

	router.get("/changes", peerAuth, (req, res) => {
		const after = Number(req.query.after ?? 0) || 0;
		const limitRaw = Number(req.query.limit ?? 500);
		const limit = Math.max(
			1,
			Math.min(Number.isFinite(limitRaw) ? limitRaw : 500, 1000),
		);
		const entries = readChanges(db, { after, limit });
		res.json({
			entries,
			last_seq: entries.length > 0 ? entries[entries.length - 1]!.seq : after,
			// This node's log head, so a caller can tell "nothing new" from
			// "still catching up" without a second request.
			head: logHead(db),
			count: entries.length,
		});
	});

	// ── pushed revocations (redesign §5.9, D-13) ────────────────────────────
	//
	// The same entries the pull would have carried, delivered early because a
	// stale *grant* is a security hole and the operator is waiting. Applied
	// through the ordinary apply path, so a redelivery by the pull afterwards
	// dedups to nothing.

	router.post("/revocations", peerAuth, (req, res) => {
		const entries = Array.isArray(req.body?.entries)
			? (req.body.entries as ChangeEntry[])
			: [];
		if (entries.length === 0) {
			res.json({ applied: 0 });
			return;
		}
		res.json(applyPushedRevocation(state, entries));
	});

	// ── identity material (redesign §5.10, D-12) ────────────────────────────
	//
	// `password_hash` and TOTP seeds do not replicate. A node fetches them the
	// first time somebody tries to log in as a given user there, and the fetch
	// walks up the tier until it reaches a holder — the master, which every
	// credential write publishes to. Nothing walks down or sideways.
	//
	// A miss answers `{material: null}` rather than 404: "nobody up the chain
	// holds any" is a real answer, and the caller turns it into a failed login,
	// not an error.

	router.post(
		"/identity/fetch",
		peerAuth,
		asyncHandler(async (req, res) => {
			const userUid =
				typeof req.body?.user_uid === "string" ? req.body.user_uid : "";
			if (!userUid) {
				res.status(422).json({ detail: "user_uid required" });
				return;
			}
			// A pair credential names the caller, so the rate-limit bucket is now a
			// fact rather than a claim — an unauthenticated self-asserted node id
			// only ever decided which counter it throttled itself against, and now
			// it decides nothing at all. The body field and the IP remain as
			// fallbacks for a caller on the legacy token, which names nobody.
			const bucket =
				req.peerAuth?.nodeId ||
				(typeof req.body?.node_id === "string" && req.body.node_id
					? req.body.node_id
					: clientIp(state, req));
			if (!allowIdentityFetch(bucket, userUid)) {
				res.status(429).json({ detail: "too many identity fetches" });
				return;
			}
			const user = db.get<UserRow>("SELECT * FROM users WHERE uid = $uid", {
				$uid: userUid,
			});
			const material = user ? localMaterial(db, user) : null;
			if (material) {
				// §5.13: one user, on request, recorded. The bulk `/export` this
				// replaced was none of those things.
				recordAudit(db, {
					actor: `node:${bucket}`,
					action: "cluster.identity_fetched",
					target: `user:${userUid}`,
					ip: clientIp(state, req),
				});
				res.json({ material });
				return;
			}
			// Not held here. Forward up our own chain rather than answering "no" —
			// and deliberately do NOT keep a copy of what comes back: a relay that
			// cached would widen the set of nodes holding a hash beyond "nodes this
			// user has actually logged in on", which is the bound §5.10 promises.
			const hops = Number(req.body?.hops ?? 0) || 0;
			res.json({ material: await fetchMaterial(state, userUid, hops) });
		}),
	);

	router.post("/identity/publish", peerAuth, (req, res) => {
		const material = req.body?.material as CredentialMaterial | undefined;
		if (!material || typeof material.user_uid !== "string") {
			res.status(422).json({ detail: "material required" });
			return;
		}
		const result = applyPublishedMaterial(state, material);
		if (!result.stored) {
			// The user row has not replicated here yet. The publisher pushes the
			// log entries first precisely so this cannot happen; when it does, the
			// row arrives at pull speed and the material follows on the next
			// credential write or fetch.
			res.status(409).json({ detail: result.reason ?? "not stored" });
			return;
		}
		res.json({ stored: true });
	});

	// ── tiering (redesign §5.3-5.4) ─────────────────────────────────────────
	//
	// `/vote-request` and `/master-assumed` used to live here. There is nothing
	// to replace them with: leadership is not negotiated, it is computed, and
	// the only thing that travels between nodes is the generation itself —
	// which already rides on every join and heartbeat. This endpoint exists so a
	// node can ask for it directly rather than waiting for the next heartbeat.

	router.get("/tiering", peerAuth, (_req, res) => {
		res.json({ tiering: currentTiering(db) });
	});

	// ── quota reservations (redesign §5.9) ──────────────────────────────────
	//
	// The only synchronous cross-node call on the write path. Master-only: a
	// follower holds no ledger, and answering from one would be inventing the
	// authority the whole design exists to centralise. 409 rather than 403 —
	// the caller's credentials are fine, its *target* is wrong, and it should
	// re-resolve who the master is and retry.

	function requireQuotaAuthority(res: Response): boolean {
		if (isMaster(state)) return true;
		res.status(409).json({
			detail: "this node is not the cluster's quota authority",
			master_node_id: currentTiering(db)?.master_node_id ?? null,
		});
		return false;
	}

	router.post("/quota/reserve", peerAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const body = req.body as Partial<GrantRequest>;
		if (!body?.user_uid || typeof body.bytes !== "number") {
			res.status(400).json({ detail: "user_uid and bytes are required" });
			return;
		}
		res.json(
			grantReservation(db, {
				user_uid: body.user_uid,
				bytes: body.bytes,
				kind: body.kind ?? "upload",
				node_id: req.peerAuth?.nodeId ?? body.node_id ?? "unknown",
			}),
		);
	});

	router.post("/quota/renew", peerAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const uid = (req.body as { reservation_uid?: string })?.reservation_uid;
		if (!uid) {
			res.status(400).json({ detail: "reservation_uid is required" });
			return;
		}
		const renewed = renewReservation(db, uid);
		if (!renewed) {
			res.status(404).json({ detail: "no such reservation" });
			return;
		}
		res.json(renewed);
	});

	// Commit and release are idempotent and never fail on an unknown uid: a
	// reservation that already expired is settled, and the file row it admitted
	// exists either way. Erroring here would only make callers handle a case
	// with no remedy.
	router.post("/quota/commit", peerAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const body = req.body as {
			reservation_uid?: string;
			actual_bytes?: number;
		};
		if (body?.reservation_uid) {
			settleReservation(
				db,
				body.reservation_uid,
				"committed",
				body.actual_bytes,
			);
		}
		res.json({ status: "ok" });
	});

	router.post("/quota/release", peerAuth, (req, res) => {
		if (!requireQuotaAuthority(res)) return;
		const uid = (req.body as { reservation_uid?: string })?.reservation_uid;
		if (uid) settleReservation(db, uid, "released");
		res.json({ status: "ok" });
	});

	return router;
}
