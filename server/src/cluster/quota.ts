import type { AppState } from "../appState.ts";
import type {
	PermissionRow,
	QuotaReservationRow,
	UserRow,
} from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import {
	ensureStorageSettings,
	usedStorageBytes,
} from "../storage/accounting.ts";
import { awaitWritable } from "./degraded.ts";
import { ClusterHTTPError, postJson } from "./http.ts";
import { ensureUid, newUid } from "./identity.ts";
import { isMaster, resolveMaster } from "./tiering.ts";

/**
 * Master-gated quota reservations (redesign §5.9, D-1, D-16, D-17).
 *
 * The problem this exists for: two nodes each read `SUM(files.size_bytes) = 0`
 * for a user with a 15 GB quota, each admit a 10 GB upload, and the change log
 * honestly converges on 20 GB. Nothing downstream can repair that — a file that
 * exists cannot be un-accepted, and picking one to delete is a data-loss policy,
 * not a reconciliation. Quota is therefore the one decision that is taken
 * synchronously, by one node, before bytes are accepted.
 *
 * **The unit is logical quota bytes, everywhere (D-17).** `quota_bytes` versus
 * `SUM(files.size_bytes)` is the number that decides whether a user may write,
 * so it is the number the master reserves against — and *every* path that
 * creates a `files` row reserves, including the ones that create no new bytes
 * at all. A save or a copy attaches an existing blob, so physical usage may not
 * move; logical usage does, and logical usage is the entitlement. Letting those
 * paths skip the reservation would let a user clone past `quota_bytes` for free.
 *
 * **The TTL slides; it is not a ceiling (D-16).** A 12-hour absolute cap would
 * kill a legitimate multi-day torrent import. `expires_at` is an *inactivity*
 * window pushed forward by every chunk commit, by the uploading node's idle
 * keepalive, and by a periodic tick for transfers with no chunk cadence. Expiry
 * means "nobody has touched this for a full window", which is the only
 * condition under which releasing the bytes is safe.
 *
 * On the master — and on a single-node deployment, which is a cluster of one
 * whose master is itself — every call below resolves in-process against the
 * local table. There is no HTTP hop and no behavioural difference, which is
 * what keeps the un-clustered case exactly as fast as it was.
 */

const log = getLogger("app.cluster.quota");

/** Matches `CHUNK_SESSION_TTL` in routes/files.ts: a resumable upload session
 * must not outlive the reservation admitting it. */
export const RESERVATION_TTL_MS = 12 * 60 * 60 * 1000;

const RESERVE_TIMEOUT_MS = 15_000;

export type ReservationKind = "upload" | "save" | "copy" | "torrent" | "remote";

export interface Reservation {
	uid: string;
	bytes: number;
	expires_at: string;
}

// ── master side: the ledger ─────────────────────────────────────────────────

function openReservationBytes(db: Db, userUid: string): number {
	return (
		db.get<{ total: number | null }>(
			`SELECT SUM(bytes) AS total FROM quota_reservations
        WHERE user_uid = $user AND state = 'open'`,
			{ $user: userUid },
		)?.total ?? 0
	);
}

/** Committed logical bytes for a user, read from the master's own replica.
 *
 * Every replicated table lands on the master, so this is a cluster-wide number
 * rather than a local one — modulo replication lag, which is bounded by the
 * outstanding reservations that cover exactly the writes still in flight. That
 * overlap is the point: a file whose row has not reached the master yet is
 * still counted, because its reservation is still open. */
function committedBytes(db: Db, userUid: string): number {
	return (
		db.get<{ total: number | null }>(
			`SELECT SUM(f.size_bytes) AS total
         FROM files f JOIN users u ON u.id = f.owner_id
        WHERE u.uid = $user`,
			{ $user: userUid },
		)?.total ?? 0
	);
}

export interface GrantRequest {
	user_uid: string;
	bytes: number;
	kind: ReservationKind;
	node_id: string;
}

/**
 * Decide, and record the decision. The master's whole job.
 *
 * Refusals name **quota** whenever quota is the binding constraint, because
 * that is the one a user can do something about: the global storage cap is an
 * operator's number and "the server is full" is not actionable advice for
 * someone who is under their own limit.
 *
 * The global cap is checked here too, against post-dedup `SUM(stored_size_bytes)`
 * — it is about disk, not entitlement, so it keeps its own unit. Free disk is
 * *not* checked here and must not be: it is a fact about the node that will hold
 * the bytes, and the master's free space says nothing about that node's.
 * `enforceGlobalUploadCapacity` keeps that check local.
 */
export function grantReservation(
	db: Db,
	req: GrantRequest,
	now = new Date(),
): Reservation {
	const bytes = Math.max(0, Math.trunc(req.bytes));
	const perm = db.get<PermissionRow>(
		`SELECT p.* FROM permissions p JOIN users u ON u.id = p.user_id
      WHERE u.uid = $user`,
		{ $user: req.user_uid },
	);
	if (!perm) {
		throw new HttpError(404, "no such user on the quota authority");
	}

	const outstanding = openReservationBytes(db, req.user_uid);
	const committed = committedBytes(db, req.user_uid);
	if (committed + outstanding + bytes > perm.quota_bytes) {
		log.info(
			`quota refused user_uid=${req.user_uid} bytes=${bytes} committed=${committed} outstanding=${outstanding} quota=${perm.quota_bytes}`,
		);
		throw new HttpError(413, "this would exceed your quota");
	}

	const storage = ensureStorageSettings(db);
	if (
		usedStorageBytes(db) + outstanding + bytes >
		storage.global_storage_quota_bytes
	) {
		throw new HttpError(413, "this would exceed global storage allocation");
	}

	const uid = newUid();
	const iso = now.toISOString();
	const expires = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
	db.run(
		`INSERT INTO quota_reservations
       (uid, user_uid, bytes, node_id, kind, state, created_at, renewed_at, expires_at)
     VALUES ($uid, $user, $bytes, $node, $kind, 'open', $now, $now, $expires)`,
		{
			$uid: uid,
			$user: req.user_uid,
			$bytes: bytes,
			$node: req.node_id,
			$kind: req.kind,
			$now: iso,
			$expires: expires,
		},
	);
	return { uid, bytes, expires_at: expires };
}

/** Push the inactivity window forward. Silently succeeds for a reservation that
 * is already settled — a keepalive racing a commit is normal, and turning that
 * into an error would make every caller handle a case with no consequence. */
export function renewReservation(
	db: Db,
	uid: string,
	now = new Date(),
): { expires_at: string } | null {
	const row = db.get<QuotaReservationRow>(
		"SELECT * FROM quota_reservations WHERE uid = $uid",
		{ $uid: uid },
	);
	if (!row) return null;
	if (row.state !== "open") return { expires_at: row.expires_at };
	const iso = now.toISOString();
	const expires = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
	db.run(
		"UPDATE quota_reservations SET renewed_at = $now, expires_at = $expires WHERE uid = $uid",
		{ $now: iso, $expires: expires, $uid: uid },
	);
	return { expires_at: expires };
}

/** Settle a reservation. `committed` records what was actually written, which
 * is what makes an over-reservation harmless: the row stops counting toward
 * outstanding either way, and the real bytes are already in `files`. */
export function settleReservation(
	db: Db,
	uid: string,
	state: "committed" | "released" | "expired",
	actualBytes?: number,
): void {
	db.run(
		`UPDATE quota_reservations
        SET state = $state, committed_bytes = $bytes
      WHERE uid = $uid AND state = 'open'`,
		{
			$state: state,
			$bytes: state === "committed" ? (actualBytes ?? null) : null,
			$uid: uid,
		},
	);
}

/** Drop reservations nobody has touched for a full window, and prune settled
 * rows once they are old enough to be uninteresting. Returns how many expired.
 *
 * Expiry is the only path that releases bytes without the reserving node
 * saying so, which is why the window is an inactivity window: a transfer that is
 * making — or even just attempting — progress renews, so reaching this code
 * means the uploader is genuinely gone. */
export function sweepReservations(db: Db, now = new Date()): number {
	const iso = now.toISOString();
	const stale = db.all<QuotaReservationRow>(
		"SELECT * FROM quota_reservations WHERE state = 'open' AND expires_at < $now",
		{ $now: iso },
	);
	for (const row of stale) {
		settleReservation(db, row.uid, "expired");
		log.warning(
			`quota reservation expired uid=${row.uid} user_uid=${row.user_uid} bytes=${row.bytes} node=${row.node_id} kind=${row.kind}`,
		);
	}
	const cutoff = new Date(
		now.getTime() - 7 * 24 * 60 * 60 * 1000,
	).toISOString();
	db.run(
		"DELETE FROM quota_reservations WHERE state <> 'open' AND renewed_at < $cutoff",
		{ $cutoff: cutoff },
	);
	return stale.length;
}

/** Master-side view for the admin panel: what is currently admitted but not yet
 * written, per user. */
export function outstandingReservations(db: Db): QuotaReservationRow[] {
	return db.all<QuotaReservationRow>(
		"SELECT * FROM quota_reservations WHERE state = 'open' ORDER BY created_at",
	);
}

// ── client side ─────────────────────────────────────────────────────────────

/** Translate an error from the master into one the caller can return verbatim.
 *
 * A 413 from the master is the user's own quota and travels through unchanged.
 * Anything else — unreachable, 5xx, a timeout — is *not* a quota refusal and
 * must not be reported as one: it means this node currently has no write
 * authority, which is a 503 with a cause the operator can act on. Collapsing
 * the two would tell a user they are out of space when the cluster is simply
 * degraded. */
function asHttpError(err: unknown): HttpError {
	if (err instanceof HttpError) return err;
	if (err instanceof ClusterHTTPError) {
		if (err.status === 413 || err.status === 403 || err.status === 404) {
			let detail = "this would exceed your quota";
			try {
				const parsed = JSON.parse(err.body) as { detail?: string };
				if (parsed?.detail) detail = parsed.detail;
			} catch {
				// keep the default
			}
			return new HttpError(err.status, detail);
		}
	}
	return new HttpError(
		503,
		"the cluster's quota authority is unreachable; writes are paused until it returns",
	);
}

/** Reserve `bytes` of this user's logical quota before accepting the write.
 *
 * On the master this is a local transaction. On a follower it is one HTTP
 * round-trip to the master — the only synchronous cross-node call on the write
 * path, and §5.9's whole cost. A node that cannot reach the master cannot
 * write, by design (D-1): guessing at the answer is what makes quota
 * unreconcilable in the first place. */
export async function reserveQuota(
	state: AppState,
	opts: { user: UserRow; bytes: number; kind: ReservationKind },
): Promise<Reservation> {
	const userUid = ensureUid(state.db, "users", opts.user.id);
	const payload: GrantRequest = {
		user_uid: userUid,
		bytes: Math.max(0, Math.trunc(opts.bytes)),
		kind: opts.kind,
		node_id: state.settings.nodeId,
	};
	if (isMaster(state)) {
		return grantReservation(state.db, payload);
	}
	// Hold through a master restart rather than failing (§5.5). Past the grace
	// window this throws, and the message names the cause.
	try {
		await awaitWritable(state);
	} catch (err) {
		throw new HttpError(
			503,
			err instanceof Error ? err.message : "the cluster master is unreachable",
		);
	}
	const master = resolveMaster(state);
	if (!master) throw asHttpError(new ClusterHTTPError(0, "no master"));
	try {
		const reservation = (await postJson(
			`${master.baseUrl}/api/cluster/quota/reserve`,
			master.token,
			payload,
			RESERVE_TIMEOUT_MS,
		)) as Reservation;
		state.masterReachability.confirmContact();
		return reservation;
	} catch (err) {
		// A 4xx is the master answering, which is contact. Only a transport
		// failure means it is gone -- conflating the two would degrade a node for
		// the crime of asking for more space than a user has.
		if (err instanceof ClusterHTTPError && err.status > 0) {
			state.masterReachability.confirmContact();
		} else {
			state.masterReachability.noteFailure();
		}
		throw asHttpError(err);
	}
}

async function settle(
	state: AppState,
	uid: string,
	op: "commit" | "release" | "renew",
	actualBytes?: number,
): Promise<void> {
	if (isMaster(state)) {
		if (op === "renew") renewReservation(state.db, uid);
		else {
			settleReservation(
				state.db,
				uid,
				op === "commit" ? "committed" : "released",
				actualBytes,
			);
		}
		return;
	}
	const master = resolveMaster(state);
	if (!master) {
		// Deliberately not fatal. A commit that cannot be delivered leaves an
		// open reservation which the master expires after its window -- bytes
		// briefly double-counted against one user, self-healing, and far better
		// than failing a write whose file row already exists.
		log.warning(
			`could not ${op} quota reservation ${uid}: no master reachable; it will expire on its own`,
		);
		return;
	}
	try {
		await postJson(
			`${master.baseUrl}/api/cluster/quota/${op}`,
			master.token,
			{ reservation_uid: uid, actual_bytes: actualBytes },
			RESERVE_TIMEOUT_MS,
		);
	} catch (err) {
		log.warning(
			`could not ${op} quota reservation ${uid}: ${err instanceof Error ? err.message : String(err)}; it will expire on its own`,
		);
	}
}

export function commitQuota(
	state: AppState,
	uid: string,
	actualBytes: number,
): Promise<void> {
	return settle(state, uid, "commit", actualBytes);
}

export function releaseQuota(state: AppState, uid: string): Promise<void> {
	return settle(state, uid, "release");
}

export function renewQuota(state: AppState, uid: string): Promise<void> {
	return settle(state, uid, "renew");
}

/**
 * Reserve, run, then commit or release. The shape almost every call site wants.
 *
 * `fn` receives the reservation so a long-running caller can persist its uid
 * and renew it. Whatever `fn` returns is passed through; whatever it throws
 * releases the reservation and propagates, so a failed write never leaves bytes
 * held against a user.
 */
export async function withQuota<T>(
	state: AppState,
	opts: { user: UserRow; bytes: number; kind: ReservationKind },
	fn: (reservation: Reservation) => Promise<T> | T,
): Promise<T> {
	const reservation = await reserveQuota(state, opts);
	let result: T;
	try {
		result = await fn(reservation);
	} catch (err) {
		await releaseQuota(state, reservation.uid);
		throw err;
	}
	await commitQuota(state, reservation.uid, reservation.bytes);
	return result;
}

/** The `cluster_quota_sweep` scheduler job. Master-only: a follower holds no
 * ledger, so there is nothing for it to sweep. */
export function quotaSweepJob(state: AppState): number {
	if (!isMaster(state)) return 0;
	return sweepReservations(state.db);
}
