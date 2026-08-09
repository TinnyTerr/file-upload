import type { AppState } from "../appState.ts";
import type { ClusterNodeRow, UserRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { ClusterHTTPError, postJson } from "./http.ts";
import { pushRevocation, type RevocationReport } from "./revocation.ts";
import { currentTiering, upstreamOf } from "./tiering.ts";

/**
 * The identity split (redesign §5.10, D-12 and D-18).
 *
 * Every node holds every user row, so every node can *authorize* anyone
 * without a round-trip — that is what §5.9's local permission read depends on.
 * What no node holds until it needs it is the material that lets it
 * *authenticate* them: `users.password_hash` and the TOTP seeds in
 * `credentials`. Those are absent from `TABLE_COLUMNS` and from
 * `CHANGELOG_TABLES` respectively, so they never ride the log. A node fetches
 * them the first time somebody tries to log in as that user there, stores
 * them, and verifies locally with Argon2id from then on.
 *
 * Three properties this buys, each of which the alternatives lose:
 *
 * - **Degraded mode keeps working where it is used.** A node cut off from the
 *   master can still log in every user who has logged in there before — in
 *   practice its entire population. Verify-at-a-holder cannot: it needs the
 *   holder, every time, forever.
 * - **The candidate password never leaves the node it was typed into.** The
 *   alternative ships a plaintext password to a peer on every single login.
 *   Moving a hash once is a smaller exposure than moving the plaintext
 *   repeatedly.
 * - **One round-trip per user per node**, not per login.
 *
 * The cost, stated plainly: the hash ends up on every node the user has
 * actually used. That set grows with *use*, not with cluster size. A relaying
 * node deliberately does **not** keep a copy of what it forwards, so the set
 * stays exactly "nodes this person has logged in on".
 *
 * **Invalidation is a replicated counter, not a message.** `credential_version`
 * is on the user row and does replicate; `credential_version_local` says which
 * version this node's copy matches and does not. A password change or TOTP
 * enrolment bumps the former, so every peer's copy becomes visibly stale the
 * moment the bump reaches it — and because a bump is monotonic, out-of-order
 * delivery, a node that was offline, and a node that never cached anything all
 * behave identically. Nothing has to be pushed for correctness. Credential
 * writes ride the *revocation* path on top of that (`cluster/revocation.ts`)
 * so the bump lands in milliseconds rather than at pull speed: a stale
 * password hash is a stale grant, which is the case §5.9 refuses to leave to
 * the pull.
 *
 * **The master is the holder of record.** A credential write publishes its
 * material to the master synchronously, and a fetch walks *up* the tier, so
 * the chain always terminates somewhere that has it. Nothing walks down or
 * sideways — a node asking a sibling is how two halves of a partition end up
 * authenticating against two different passwords.
 *
 * **WebAuthn credentials never travel (D-18).** The relying-party id and origin
 * come from the node's own hostname, so a credential registered against node
 * A's domain cannot be asserted against node B's; sending it would be shipping
 * something unusable. `webauthn_user_handle` *does* replicate — it is an
 * identifier, not a credential, and keeping it stable is what makes the same
 * user recognisable when they enrol a second passkey on a second node.
 *
 * One deployment assumption, inherited rather than introduced: TOTP seeds
 * travel sealed under `MASTER_KEY_B64` exactly as they are stored, so cluster
 * nodes must share that key. They already must — `files.enc_key_blob` is
 * replicated and sealed the same way.
 */

const log = getLogger("app.cluster.identityFetch");

/** One fetch attempt. Short: a login is waiting on it, and a node that cannot
 * answer in this long is one the user is better off being told about. */
const FETCH_TIMEOUT_MS = 5_000;

/** Publishing material to the master. Longer than a fetch because the caller
 * is an admin or a user changing their own password, not a login. */
const PUBLISH_TIMEOUT_MS = 10_000;

/** Relay hops a fetch may take before giving up. The tier is two deep
 * (follower → leader → master), so this only ever fires on a generation that
 * has gone circular, which is a bug rather than a topology. */
const MAX_HOPS = 4;

/** Rate limit on the *serving* side, per (requesting node, user). A cluster
 * peer is authenticated, so this is not an anti-enumeration control against
 * the internet — it bounds what a compromised or looping node can pull out of
 * a holder, and it stops a crash-looping peer from hammering the master. */
const FETCH_WINDOW_MS = 60_000;
const FETCH_MAX_PER_WINDOW = 10;

// ── material ────────────────────────────────────────────────────────────────

export interface CredentialMaterial {
	user_uid: string;
	credential_version: number;
	password_hash: string;
	/** TOTP seeds, sealed exactly as they are stored (hex, since JSON has no
	 * blob). WebAuthn credentials are never included — see D-18 above. */
	totp: Array<{ secret_hex: string; label: string | null; created_at: string }>;
}

export type MaterialState =
	/** This node's copy matches the replicated version. Verify locally. */
	| "held"
	/** Held, but a newer version exists somewhere. Refetch before verifying. */
	| "stale"
	/** Never fetched here, or dropped. */
	| "absent";

/** What this node holds for a user, without asking anyone.
 *
 * The two-column test is what makes invalidation free: `credential_version`
 * arrives with the ordinary user upsert, so a bump made anywhere turns every
 * other node's copy into `stale` with no message and no push. */
export function materialState(user: UserRow): MaterialState {
	if (!user.password_hash || user.credential_version_local === null) {
		return "absent";
	}
	return user.credential_version_local >= user.credential_version
		? "held"
		: "stale";
}

/** The material this node holds for a user, in wire form — or null if it holds
 * none. Serving side of `/cluster/identity/fetch`. */
export function localMaterial(
	db: Db,
	user: UserRow,
): CredentialMaterial | null {
	if (!user.uid) return null;
	if (materialState(user) !== "held") return null;
	const totp = db
		.all<{
			secret_blob: Uint8Array | null;
			label: string | null;
			created_at: string;
		}>(
			`SELECT secret_blob, label, created_at FROM credentials
        WHERE user_id = $userId AND kind = 'totp' AND secret_blob IS NOT NULL
        ORDER BY created_at ASC`,
			{ $userId: user.id },
		)
		.map((row) => ({
			secret_hex: Buffer.from(row.secret_blob!).toString("hex"),
			label: row.label,
			created_at: row.created_at,
		}));
	return {
		user_uid: user.uid,
		credential_version: user.credential_version,
		password_hash: user.password_hash,
		totp,
	};
}

/**
 * Write fetched material into this node's tables.
 *
 * Runs with the change-log triggers suppressed, and that is a correctness
 * requirement rather than an optimisation: this is material learned from a
 * peer, exactly like an entry coming out of `applyChanges`, and logging it
 * would append a spurious `users` upsert carrying no new replicated state —
 * one that could go on to *win* an arbitration against a real concurrent edit
 * and discard it. Suppression is raised and lowered in a `try/finally` for the
 * reason CLAUDE.md gives: left raised, this node silently stops logging its
 * own writes.
 *
 * The TOTP rows are replaced wholesale. Any this node holds are by definition
 * copies of the holder's — had they been enrolled here, this node would have
 * bumped the version and would not be fetching. WebAuthn rows are not touched:
 * they are node-local originals, not copies, and dropping them would delete a
 * passkey that still works.
 */
export function storeMaterial(
	db: Db,
	userId: number,
	material: CredentialMaterial,
): void {
	db.transaction(() => {
		db.run("UPDATE replication_control SET suppressed = 1 WHERE id = 1");
		try {
			db.run(
				`UPDATE users SET password_hash = $hash, credential_version_local = $version
          WHERE id = $id`,
				{
					$hash: material.password_hash,
					$version: material.credential_version,
					$id: userId,
				},
			);
			db.run("DELETE FROM credentials WHERE user_id = $id AND kind = 'totp'", {
				$id: userId,
			});
			for (const seed of material.totp) {
				db.run(
					`INSERT INTO credentials (user_id, kind, secret_blob, label, created_at)
           VALUES ($id, 'totp', $secret, $label, $createdAt)`,
					{
						$id: userId,
						$secret: Buffer.from(seed.secret_hex, "hex"),
						$label: seed.label,
						$createdAt: seed.created_at,
					},
				);
			}
		} finally {
			db.run("UPDATE replication_control SET suppressed = 0 WHERE id = 1");
		}
	});
}

/**
 * Record material this node just *minted* — a password set or a TOTP enrolment
 * that happened here.
 *
 * Bumps the replicated `credential_version`, which is what invalidates every
 * other node's copy, and claims the new version locally in the same statement
 * so this node does not immediately consider its own write stale. Unsuppressed
 * on purpose: the bump is a genuine local edit and has to reach every peer.
 *
 * Call it *inside* whatever transaction wrote the hash, and take a
 * `revocationMark` before that — the caller pushes afterwards.
 */
export function bumpCredentialVersion(db: Db, userId: number): number {
	db.run(
		`UPDATE users
        SET credential_version = credential_version + 1,
            credential_version_local = credential_version + 1
      WHERE id = $id`,
		{ $id: userId },
	);
	return (
		db.get<{ v: number }>(
			"SELECT credential_version AS v FROM users WHERE id = $id",
			{ $id: userId },
		)?.v ?? 1
	);
}

// ── fetching, up the tier ───────────────────────────────────────────────────

interface Peer {
	nodeId: string;
	baseUrl: string;
	token: string;
}

function peerRow(db: Db, nodeId: string): Peer | null {
	const row = db.get<ClusterNodeRow>(
		"SELECT * FROM cluster_nodes WHERE node_id = $id AND active = 1",
		{ $id: nodeId },
	);
	if (!row?.node_id || !row.base_url || !row.token) return null;
	return {
		nodeId: row.node_id,
		baseUrl: row.base_url.replace(/\/$/, ""),
		token: row.token,
	};
}

/** This node's upstream, resolved exactly as `replication.ts::pullTargets`
 * resolves it — same generation, same liveness observation, same
 * `upstreamOf`. A second rule for "who is above me" is a rule that can
 * disagree with the pulls the cluster is actually doing. */
function upstreamPeer(state: AppState): Peer | null {
	const tiering = currentTiering(state.db);
	if (!tiering) return null;
	const selfId = state.settings.nodeId;
	const reachable = (id: string) =>
		id === selfId || peerRow(state.db, id) !== null;
	const upstream = upstreamOf(tiering, selfId, reachable);
	return upstream ? peerRow(state.db, upstream) : null;
}

/** The master, for publishing. Null when this node *is* the master, or when no
 * generation has been adopted yet (a node that has never been tiered has no
 * cluster to publish to). */
function masterPeer(state: AppState): Peer | null {
	const tiering = currentTiering(state.db);
	if (!tiering) return null;
	if (tiering.master_node_id === state.settings.nodeId) return null;
	return peerRow(state.db, tiering.master_node_id);
}

/** Ask upstream for a user's material. Returns null when nobody up the chain
 * holds any — which is a real answer, not an error: it means the user has
 * never had a credential set anywhere this node can reach. */
export async function fetchMaterial(
	state: AppState,
	userUid: string,
	hops = 0,
): Promise<CredentialMaterial | null> {
	if (hops >= MAX_HOPS) {
		log.warning(`identity fetch for ${userUid} exceeded ${MAX_HOPS} hops`);
		return null;
	}
	const peer = upstreamPeer(state);
	if (!peer) return null;
	try {
		const res = (await postJson(
			`${peer.baseUrl}/api/cluster/identity/fetch`,
			peer.token,
			{ user_uid: userUid, hops: hops + 1 },
			FETCH_TIMEOUT_MS,
		)) as { material?: CredentialMaterial | null } | null;
		return res?.material ?? null;
	} catch (err) {
		const reason = err instanceof ClusterHTTPError ? err.message : String(err);
		log.warning(`identity fetch for ${userUid} from ${peer.nodeId}: ${reason}`);
		return null;
	}
}

/**
 * Make sure this node can verify a password for `user`, fetching if it can't,
 * and return the row to verify against.
 *
 * The login path's single entry point. It is safe on a single-node deployment
 * and on an untiered node: with no upstream there is nothing to ask, so it
 * returns the row unchanged and the caller fails the login the same way it
 * would for a wrong password.
 */
export async function ensureCredentialMaterial(
	state: AppState,
	user: UserRow,
): Promise<UserRow> {
	const held = materialState(user);
	if (held === "held") return user;
	if (!user.uid) return user;

	const material = await fetchMaterial(state, user.uid);
	if (!material) {
		if (held === "stale") {
			// Keep serving the copy we have rather than locking the user out of a
			// node that has simply lost its upstream. The window is bounded by the
			// same partition that already stops this node accepting writes (§5.5),
			// and refusing here would turn "your password changed elsewhere" into
			// "you cannot log in at all".
			log.warning(
				`identity: serving stale credential material for user ${user.id} (upstream unreachable)`,
			);
		}
		return user;
	}
	storeMaterial(state.db, user.id, material);
	log.info(
		`identity: fetched credential material for user ${user.id} (version ${material.credential_version})`,
	);
	return (
		state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: user.id,
		}) ?? user
	);
}

// ── publishing, to the master ───────────────────────────────────────────────

/**
 * Hand the master this node's freshly minted material for a user.
 *
 * A no-op on the master itself and on an untiered node. It runs *after* the
 * caller's `pushRevocation`, which is what guarantees the master already holds
 * the `users` row this material belongs to — publishing first would arrive at
 * a node with nothing to attach it to.
 *
 * A failure is logged and reported, never thrown. The write itself has already
 * committed locally and is correct here; what a failed publish costs is that
 * *other* nodes cannot fetch the new material until the master gets it, which
 * is the D-12 cost the design already accepts. It should not be reachable in
 * practice: a node that cannot reach the master is refusing writes anyway
 * (§5.5).
 */
export async function publishCredentialMaterial(
	state: AppState,
	userId: number,
): Promise<{ published: boolean; reason?: string }> {
	const peer = masterPeer(state);
	if (!peer) return { published: false };
	const user = state.db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: userId,
	});
	if (!user) return { published: false, reason: "user gone" };
	const material = localMaterial(state.db, user);
	if (!material) return { published: false, reason: "no material held" };
	try {
		await postJson(
			`${peer.baseUrl}/api/cluster/identity/publish`,
			peer.token,
			{ material },
			PUBLISH_TIMEOUT_MS,
		);
		return { published: true };
	} catch (err) {
		const reason = err instanceof ClusterHTTPError ? err.message : String(err);
		log.warning(
			`identity: publishing credential material for user ${userId} to master ${peer.nodeId} failed: ${reason}`,
		);
		return { published: false, reason };
	}
}

/**
 * The whole cluster-facing half of a credential write, in one call.
 *
 * Take a `revocationMark` *before* the write, call this after it. Two things
 * happen, in this order and for different reasons:
 *
 * 1. **Push the log entries** the write produced. Among them is the user row
 *    carrying the bumped `credential_version`, which is what tells every
 *    reachable peer that its cached hash is dead. Leaving that to the pull
 *    would leave a peer honouring the *old* password for up to a pull interval
 *    per hop — a stale grant, which is the case §5.9 exists to refuse.
 * 2. **Publish the material to the master.** The push above is what guarantees
 *    the master already holds the `users` row this attaches to, which is why
 *    the order is not arbitrary.
 *
 * On a single-node deployment both are no-ops and this costs nothing.
 */
export async function publishCredentialChange(
	state: AppState,
	userId: number,
	mark: number,
): Promise<RevocationReport & { material_published: boolean }> {
	const revocation = await pushRevocation(state, mark);
	const published = await publishCredentialMaterial(state, userId);
	return { ...revocation, material_published: published.published };
}

/** The receiving half of a publish. The material is stored the same way a
 * fetched one is — it is somebody else's write either way, so it must not be
 * re-logged. `credential_version` itself arrives down the ordinary log; this
 * only fills in the half that does not travel. */
export function applyPublishedMaterial(
	state: AppState,
	material: CredentialMaterial,
): { stored: boolean; reason?: string } {
	const user = state.db.get<UserRow>("SELECT * FROM users WHERE uid = $uid", {
		$uid: material.user_uid,
	});
	if (!user) return { stored: false, reason: "unknown user" };
	// A publish that is behind what this node already holds is a retry that lost
	// a race with a newer change; applying it would move the holder of record
	// backwards.
	if (
		user.credential_version_local !== null &&
		user.credential_version_local >= material.credential_version
	) {
		return { stored: true };
	}
	storeMaterial(state.db, user.id, material);
	return { stored: true };
}

// ── serving-side rate limit ─────────────────────────────────────────────────

const fetchHits = new Map<string, number[]>();

/** Bounded by construction: entries are pruned on every call, and a key with
 * nothing left in its window is dropped rather than kept at zero — CLAUDE.md's
 * rule about unbounded process-local maps. */
export function allowIdentityFetch(nodeId: string, userUid: string): boolean {
	const key = `${nodeId} ${userUid}`;
	const now = Date.now();
	const cutoff = now - FETCH_WINDOW_MS;
	const hits = (fetchHits.get(key) ?? []).filter((t) => t > cutoff);
	for (const [k, v] of fetchHits) {
		if (k !== key && (v.length === 0 || v[v.length - 1] <= cutoff)) {
			fetchHits.delete(k);
		}
	}
	if (hits.length >= FETCH_MAX_PER_WINDOW) {
		fetchHits.set(key, hits);
		return false;
	}
	hits.push(now);
	fetchHits.set(key, hits);
	return true;
}

/** Test seam — the limiter is process-local state and a cluster harness stands
 * several nodes up in one process. */
export function resetIdentityFetchLimiter(): void {
	fetchHits.clear();
}

/** Audit-friendly summary of what a node holds, for `GET /cluster/self`. */
export function materialSummary(db: Db): {
	users_total: number;
	material_held: number;
	material_stale: number;
} {
	const row = db.get<{
		total: number;
		held: number;
		stale: number;
	}>(
		`SELECT COUNT(*) AS total,
            SUM(CASE WHEN password_hash <> '' AND credential_version_local >= credential_version
                     THEN 1 ELSE 0 END) AS held,
            SUM(CASE WHEN password_hash <> '' AND credential_version_local < credential_version
                     THEN 1 ELSE 0 END) AS stale
       FROM users`,
	);
	return {
		users_total: row?.total ?? 0,
		material_held: row?.held ?? 0,
		material_stale: row?.stale ?? 0,
	};
}
