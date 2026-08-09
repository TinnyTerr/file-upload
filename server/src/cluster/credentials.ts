/** Per-node credentials, rotation with overlap, and the peer auth guard
 * (redesign §5.13, Phase 9 — closes S2 and S3).
 *
 * Before this, every node accepted one static `CLUSTER_TOKEN` and stored every
 * *other* node's token in plaintext, handing the whole set out in the `/join`
 * response body. Compromising one node's database yielded the credentials of
 * every node, and rotating a token told nobody, so the cluster 401'd itself
 * apart.
 *
 * What replaces it is a secret per ordered pair, in two halves:
 *
 * - **outbound** — the secret this node presents when it calls a peer. It has
 *   to be recoverable, so it stays in plaintext in `cluster_nodes.token`, the
 *   column that already meant exactly that. What changed is the *value*: a
 *   secret shared with one peer, so reading this database lets an attacker act
 *   as this node and as nobody else.
 * - **inbound** — the secret a peer presents to us. Only ever compared, so it
 *   is stored hashed, in `cluster_peer_credentials`. More than one live row per
 *   peer is not a bug, it is the rotation overlap window.
 *
 * Establishment is one round-trip (`POST /cluster/credentials/exchange`) that
 * rotates *both* directions at once, authorized by one of three things: an
 * existing pair credential (that is a rotation), a one-use enrolment token (an
 * operator linking a node, or a peer introducing a joiner), or the shared
 * cluster token while `legacyTokenAcceptable()` still holds. That last one is
 * the migration path and it retires itself — see below.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppState } from "../appState.ts";
import type {
	ClusterEnrollmentTokenRow,
	ClusterNodeRow,
	ClusterPeerCredentialRow,
} from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { ClusterHTTPError, postJson } from "./http.ts";

const log = getLogger("app.cluster.credentials");

declare module "express-serve-static-core" {
	interface Request {
		/** Set by `requirePeer` once a node-to-node call has authenticated. */
		peerAuth?: PeerAuth;
	}
}

/** 32 bytes, like every other secret this codebase mints. */
const SECRET_BYTES = 32;

/** How long a retired inbound secret keeps being accepted after its
 * replacement has been acknowledged. Covers requests already in flight and a
 * peer that crashed between sending the exchange and storing the answer; short
 * enough that a rotation is meaningfully a rotation. */
export const ROTATION_OVERLAP_MS = 10 * 60_000;

/** When a pair credential is re-minted by the maintenance job. Long, because
 * rotation is now cheap and safe rather than because it is risky. */
export const CREDENTIAL_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Enrolment tokens are handled by a human between two browser tabs, or by one
 * node relaying an introduction to another within a single join. Neither takes
 * fifteen minutes. */
export const ENROLLMENT_TTL_MS = 15 * 60_000;

export function mintSecret(): string {
	return randomBytes(SECRET_BYTES).toString("base64url");
}

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time compare of two equal-length hex digests. */
function digestEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── who a request is ────────────────────────────────────────────────────────

export interface PeerAuth {
	/** The peer's node id when a pair credential named it. Null when the caller
	 * authenticated with the shared cluster token or an unscoped enrolment
	 * token — both of which identify nobody, which is the whole reason they are
	 * being retired. */
	nodeId: string | null;
	method: "credential" | "enrollment" | "legacy";
	/** The presented enrolment token, so the handler can consume it once its
	 * work has actually succeeded. */
	enrollmentToken?: string;
}

function presentedSecret(req: Request): string {
	const header = req.header("authorization") ?? "";
	const bearer = header.startsWith("Bearer ")
		? header.slice("Bearer ".length).trim()
		: "";
	return bearer || (req.header("x-cluster-token") ?? "").trim();
}

/** Match a presented secret against this node's inbound verifiers. At 2–10
 * nodes (D-9) with an overlap window that is a handful of rows, so a scan is
 * the right shape — and it is a scan over digests, not a lookup that could
 * leak which peer a near-miss belonged to. */
export function verifyPeerSecret(
	state: AppState,
	presented: string,
): string | null {
	if (!presented) return null;
	const digest = hashSecret(presented);
	const now = nowIso();
	const rows = state.db.all<ClusterPeerCredentialRow>(
		`SELECT * FROM cluster_peer_credentials
     WHERE expires_at IS NULL OR expires_at > $now`,
		{ $now: now },
	);
	for (const row of rows) {
		if (!digestEquals(row.secret_hash, digest)) continue;
		// Throttled the way sessions.last_seen_at is: this runs on every
		// node-to-node request, and the value is only ever read by a human
		// looking at the dashboard.
		if (!row.last_used_at || row.last_used_at < minuteAgo()) {
			state.db.run(
				"UPDATE cluster_peer_credentials SET last_used_at = $now WHERE id = $id",
				{ $now: now, $id: row.id },
			);
		}
		return row.peer_node_id;
	}
	return null;
}

function minuteAgo(): string {
	return new Date(Date.now() - 60_000).toISOString();
}

/** Whether the shared `CLUSTER_TOKEN` is still honoured on this node.
 *
 * It is, while any linked peer has yet to establish a pair credential with us —
 * which is the state every upgraded deployment starts in, and the state a
 * freshly configured node bootstrapping from `MASTER_TOKEN` is in. It stops
 * being honoured the moment the last peer has exchanged, with no operator
 * action and no window in which a node is locked out: the exchange establishes
 * both directions at once, so our inbound set is complete exactly when every
 * peer already holds a pair credential to call us with.
 *
 * A node with no peers at all and no credentials it has ever established also
 * honours it — that is a standalone server, where the shared token is the
 * bootstrap and there is nothing yet to protect. Once it has established even
 * one credential, unlinking everything does not bring the shared token back. */
export function legacyTokenAcceptable(db: Db): boolean {
	const row = db.get<{ peers: number; uncredentialed: number; creds: number }>(
		`SELECT
       (SELECT COUNT(*) FROM cluster_nodes
          WHERE node_id IS NOT NULL AND node_id <> '') AS peers,
       (SELECT COUNT(*) FROM cluster_nodes n
          WHERE n.node_id IS NOT NULL AND n.node_id <> ''
            AND NOT EXISTS (SELECT 1 FROM cluster_peer_credentials c
                              WHERE c.peer_node_id = n.node_id)) AS uncredentialed,
       (SELECT COUNT(*) FROM cluster_peer_credentials) AS creds`,
	);
	if (!row) return true;
	if (row.uncredentialed > 0) return true;
	return row.peers === 0 && row.creds === 0;
}

/** Whether the presented value is this node's shared cluster token. Separate
 * from "is it acceptable", because one surface accepts it after the rest have
 * stopped — see `allowBootstrapToken`. */
function isBootstrapToken(state: AppState, presented: string): boolean {
	const expected = state.clusterToken || "";
	return (
		!!expected &&
		presented.length === expected.length &&
		timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
	);
}

/** Authenticate a node-to-node request without consuming anything.
 *
 * `allowEnrollment` is off by default: an enrolment token buys exactly one
 * credential exchange, not access to the change log.
 *
 * `allowBootstrapToken` keeps honouring `CLUSTER_TOKEN` past the point where
 * `legacyTokenAcceptable()` has gone false, and exactly one surface sets it:
 * the event firehose, which is an operator monitoring endpoint as much as a
 * peer one. Retiring it there would silently kill whatever an operator has
 * pointed at it weeks after the upgrade, and the token is now genuinely
 * rotatable — rotation no longer breaks the peers, because the peers do not use
 * it. Nothing that reads or writes cluster *state* takes this. */
export function authenticatePeer(
	state: AppState,
	req: Request,
	opts: { allowEnrollment?: boolean; allowBootstrapToken?: boolean } = {},
): PeerAuth | null {
	const presented = presentedSecret(req);
	if (!presented) return null;

	const nodeId = verifyPeerSecret(state, presented);
	if (nodeId) return { nodeId, method: "credential" };

	if (opts.allowEnrollment) {
		const claimed =
			typeof (req.body as { node_id?: unknown } | undefined)?.node_id ===
			"string"
				? ((req.body as { node_id: string }).node_id as string)
				: null;
		const token = checkEnrollmentToken(state.db, presented, claimed);
		if (token) {
			return {
				nodeId: token.subject_node_id ?? claimed,
				method: "enrollment",
				enrollmentToken: presented,
			};
		}
	}

	if (
		isBootstrapToken(state, presented) &&
		(opts.allowBootstrapToken || legacyTokenAcceptable(state.db))
	) {
		return { nodeId: null, method: "legacy" };
	}
	return null;
}

/** Guard for the node-to-node surface. Replaces `requireClusterToken`. */
export function requirePeer(
	state: AppState,
	opts: { allowEnrollment?: boolean; allowBootstrapToken?: boolean } = {},
) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const auth = authenticatePeer(state, req, opts);
		if (!auth) {
			res.status(401).json({ detail: "invalid cluster credential" });
			return;
		}
		req.peerAuth = auth;
		next();
	};
}

// ── enrolment tokens ────────────────────────────────────────────────────────

export function mintEnrollmentToken(
	db: Db,
	opts: { subjectNodeId?: string | null; createdBy: string; ttlMs?: number },
): { token: string; expires_at: string } {
	const token = mintSecret();
	const expiresAt = new Date(
		Date.now() + (opts.ttlMs ?? ENROLLMENT_TTL_MS),
	).toISOString();
	db.run(
		`INSERT INTO cluster_enrollment_tokens
       (token_hash, subject_node_id, created_by, created_at, expires_at)
     VALUES ($hash, $subject, $by, $now, $expires)`,
		{
			$hash: hashSecret(token),
			$subject: opts.subjectNodeId || null,
			$by: opts.createdBy,
			$now: nowIso(),
			$expires: expiresAt,
		},
	);
	return { token, expires_at: expiresAt };
}

/** Look up an unused, unexpired enrolment token, honouring its subject scope.
 * Does NOT consume it — see `consumeEnrollmentToken`. */
function checkEnrollmentToken(
	db: Db,
	token: string,
	claimedNodeId: string | null,
): ClusterEnrollmentTokenRow | null {
	const row = db.get<ClusterEnrollmentTokenRow>(
		`SELECT * FROM cluster_enrollment_tokens
     WHERE token_hash = $hash AND used_at IS NULL AND expires_at > $now`,
		{ $hash: hashSecret(token), $now: nowIso() },
	);
	if (!row) return null;
	// An introduction names the node it was minted for. Honouring that is what
	// keeps a relayed token from being usable by whoever it passed through.
	if (row.subject_node_id && row.subject_node_id !== claimedNodeId) return null;
	return row;
}

/** Burn a token, atomically, so two simultaneous exchanges cannot both use it.
 * Called *after* the exchange has succeeded: a failed attempt leaving the
 * operator with a dead token and no way to retry is a worse failure than a
 * token that stayed live for its fifteen minutes. */
export function consumeEnrollmentToken(
	db: Db,
	token: string,
	usedBy: string | null,
): boolean {
	const claimed = db.get<{ id: number }>(
		`UPDATE cluster_enrollment_tokens
       SET used_at = $now, used_by_node_id = $by
     WHERE token_hash = $hash AND used_at IS NULL AND expires_at > $now
     RETURNING id`,
		{ $hash: hashSecret(token), $now: nowIso(), $by: usedBy },
	);
	return !!claimed;
}

// ── the exchange ────────────────────────────────────────────────────────────

/** Record a secret we will accept from `peerNodeId`, and start the overlap
 * clock on everything we accepted from it before. Both halves in one place, so
 * a rotation cannot retire the old credential without having minted its
 * replacement. */
function acceptInbound(db: Db, peerNodeId: string, secret: string): void {
	const now = nowIso();
	db.run(
		`UPDATE cluster_peer_credentials
       SET expires_at = $expires
     WHERE peer_node_id = $peer AND expires_at IS NULL`,
		{
			$peer: peerNodeId,
			$expires: new Date(Date.now() + ROTATION_OVERLAP_MS).toISOString(),
		},
	);
	db.run(
		`INSERT INTO cluster_peer_credentials (peer_node_id, secret_hash, created_at)
     VALUES ($peer, $hash, $now)`,
		{ $peer: peerNodeId, $hash: hashSecret(secret), $now: now },
	);
}

/** Adopt the row an operator created with `POST /cluster/nodes`, which carries a
 * base URL and a pasted token but no node id — the far side's identity is what
 * the operator does not have. Without this, the first contact from that node
 * inserts a *second* row for the same server: one placeholder stuck on the
 * shared token forever, one real. Matched on base URL and claimed only while
 * `node_id` is still null, so it can happen at most once. */
export function claimPlaceholderNode(
	db: Db,
	nodeId: string,
	baseUrl: string,
): void {
	if (!nodeId || !baseUrl) return;
	db.run(
		`UPDATE cluster_nodes SET node_id = $peer
     WHERE base_url = $url AND (node_id IS NULL OR node_id = '')`,
		{ $peer: nodeId, $url: baseUrl.replace(/\/$/, "") },
	);
}

/** Make sure we hold a `cluster_nodes` row for a peer we are exchanging with,
 * so the outbound secret has somewhere to live. Identity only — capacity, role
 * and region are written by the heartbeat and the tiering generation, and
 * touching them here would let an exchange reset stats it knows nothing about.
 *
 * This is the mesh's admission point, and it is deliberately one line of
 * consequence guarded by the exchange's own auth: a caller reaches it having
 * presented an operator-minted enrolment token, a peer's introduction, or the
 * shared token while that is still honoured. */
function ensureLinkRow(
	db: Db,
	opts: { nodeId: string; name?: string; baseUrl?: string },
): void {
	const baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
	const now = nowIso();
	claimPlaceholderNode(db, opts.nodeId, baseUrl);
	const existing = db.get<{ id: number }>(
		"SELECT id FROM cluster_nodes WHERE node_id = $peer",
		{ $peer: opts.nodeId },
	);
	if (existing) {
		db.run(
			`UPDATE cluster_nodes
         SET name = COALESCE(NULLIF($name, ''), name),
             base_url = COALESCE(NULLIF($baseUrl, ''), base_url),
             active = 1, last_seen_at = $now
       WHERE node_id = $peer`,
			{
				$name: opts.name ?? "",
				$baseUrl: baseUrl,
				$now: now,
				$peer: opts.nodeId,
			},
		);
		return;
	}
	if (!baseUrl) return;
	db.run(
		`INSERT INTO cluster_nodes (node_id, name, base_url, token, active, created_at, last_seen_at)
     VALUES ($peer, $name, $baseUrl, '', 1, $now, $now)`,
		{
			$peer: opts.nodeId,
			$name: opts.name || opts.nodeId,
			$baseUrl: baseUrl,
			$now: now,
		},
	);
}

/** Record the secret we will present when calling `peerNodeId`. */
function storeOutbound(db: Db, peerNodeId: string, secret: string): boolean {
	const claimed = db.get<{ id: number }>(
		`UPDATE cluster_nodes SET token = $token, credential_at = $now
     WHERE node_id = $peer RETURNING id`,
		{ $token: secret, $now: nowIso(), $peer: peerNodeId },
	);
	return !!claimed;
}

export interface ExchangeRequest {
	node_id: string;
	name?: string;
	base_url?: string;
	/** What the caller will accept from us from now on. */
	inbound_secret: string;
}

/** The responder's half. Stores what the caller told us to present to it, mints
 * what we will accept from it, and hands that back. Both directions rotate at
 * once, which is what makes "establish" and "rotate" the same code path. */
export function acceptExchange(
	state: AppState,
	req: ExchangeRequest,
): { node_id: string; name: string; inbound_secret: string } {
	const { db } = state;
	ensureLinkRow(db, {
		nodeId: req.node_id,
		name: req.name,
		baseUrl: req.base_url,
	});
	if (!storeOutbound(db, req.node_id, req.inbound_secret)) {
		throw new Error(`no linked node ${req.node_id} and no base_url to link it`);
	}
	const secret = mintSecret();
	acceptInbound(db, req.node_id, secret);
	log.info(`established a pair credential with ${req.node_id}`);
	return {
		node_id: state.settings.nodeId,
		name: state.settings.nodeName,
		inbound_secret: secret,
	};
}

/** The initiator's half. One round-trip against a peer we can already reach —
 * with a pair credential (rotation), an enrolment token (a link or an
 * introduction) or the shared token while it is still honoured (migration).
 *
 * The inbound verifier is stored only once the peer has answered, because the
 * answer is what carries its node id. A peer that calls us in the millisecond
 * before that lands gets one 401 and retries on its next tick. */
export async function performExchange(
	state: AppState,
	opts: { baseUrl: string; auth: string; expectNodeId?: string | null },
): Promise<{ nodeId: string; name: string }> {
	const secret = mintSecret();
	const baseUrl = opts.baseUrl.replace(/\/$/, "");
	const body = (await postJson(
		`${baseUrl}/api/cluster/credentials/exchange`,
		opts.auth,
		{
			node_id: state.settings.nodeId,
			name: state.settings.nodeName,
			base_url: state.settings.nodeUrl,
			inbound_secret: secret,
		},
		15_000,
	)) as { node_id?: string; name?: string; inbound_secret?: string } | null;

	const nodeId = body?.node_id ?? "";
	const theirSecret = body?.inbound_secret ?? "";
	if (!nodeId || !theirSecret) {
		throw new ClusterHTTPError(0, "peer returned no credential");
	}
	if (opts.expectNodeId && opts.expectNodeId !== nodeId) {
		throw new ClusterHTTPError(
			0,
			`expected to exchange with ${opts.expectNodeId}, reached ${nodeId}`,
		);
	}
	acceptInbound(state.db, nodeId, secret);
	// We dialled this URL, so linking what answered is not taking a stranger's
	// word for anything.
	ensureLinkRow(state.db, { nodeId, name: body?.name, baseUrl });
	storeOutbound(state.db, nodeId, theirSecret);
	return { nodeId, name: body?.name ?? nodeId };
}

// ── housekeeping ────────────────────────────────────────────────────────────

/** Establish a credential with any linked peer we are still calling with the
 * shared token, re-mint any that has aged out, and sweep what has expired.
 *
 * This is the whole migration: an upgraded cluster credentials itself within a
 * tick or two, and the shared token stops being accepted on its own
 * (`legacyTokenAcceptable`). A peer that is down keeps its node on the legacy
 * token until it comes back, which is a smaller failure than locking it out. */
export async function credentialMaintenanceJob(
	state: AppState,
): Promise<{ established: number; rotated: number; pruned: number }> {
	const { db } = state;
	const now = nowIso();
	const pruned = db.all<{ id: number }>(
		`DELETE FROM cluster_peer_credentials
     WHERE expires_at IS NOT NULL AND expires_at <= $now RETURNING id`,
		{ $now: now },
	).length;
	db.run("DELETE FROM cluster_enrollment_tokens WHERE expires_at <= $now", {
		$now: now,
	});

	const staleBefore = new Date(
		Date.now() - CREDENTIAL_MAX_AGE_MS,
	).toISOString();
	const peers = db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter(
			(n) =>
				n.node_id &&
				n.base_url &&
				n.token &&
				(!n.credential_at || n.credential_at <= staleBefore),
		);

	let established = 0;
	let rotated = 0;
	for (const peer of peers) {
		const isRotation = !!peer.credential_at;
		try {
			await performExchange(state, {
				baseUrl: peer.base_url,
				auth: peer.token,
				expectNodeId: peer.node_id,
			});
			if (isRotation) rotated++;
			else established++;
		} catch (err) {
			const reason =
				err instanceof ClusterHTTPError ? err.message : String(err);
			log.warning(
				`could not ${isRotation ? "rotate" : "establish"} the credential with ${peer.node_id}: ${reason}`,
			);
		}
	}
	return { established, rotated, pruned };
}

/** What the dashboard shows: how far this node is from having retired the
 * shared token, which is the only externally visible thing Phase 9 changes. */
export function credentialSummary(db: Db) {
	const peers = db.all<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id IS NOT NULL AND node_id <> ''",
	);
	return {
		peers: peers.length,
		credentialed: peers.filter((p) => !!p.credential_at).length,
		legacy_token_accepted: legacyTokenAcceptable(db),
		inbound_secrets: db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM cluster_peer_credentials",
		)?.n,
	};
}
