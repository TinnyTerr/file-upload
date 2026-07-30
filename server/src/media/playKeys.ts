/**
 * Playback keys for account-restricted media.
 *
 * A play key is the credential you paste into mpv. It is a **sealed token**
 * (crypto/secretbox.ts -- AES-256-GCM under MASTER_KEY_B64, the same primitive
 * the chunked-upload and dropbox tokens use) carrying everything needed to
 * authorize a stream: which media it covers, who it was minted for, when it
 * expires, and which node minted it. Verification is therefore a decrypt, not
 * a database join -- important because a single mpv session issues a Range
 * request per seek.
 *
 * Statelessness alone can't revoke, so `media_play_keys` backs every issued
 * token with a row, and `verifyPlayKey` refuses a jti that isn't there or that
 * carries `revoked_at`. Strict-unknown-is-invalid is what makes pruning safe:
 * `prunePlayKeys` only deletes rows already past `expires_at`, and the sealed
 * token is independently refused on expiry, so a pruned row can never revive a
 * working key.
 *
 * Keys are node-local by design (like `sessions`; see the schema comment on
 * media_play_keys). `nid` pins the minting node so a token replayed against a
 * peer fails with an actionable error instead of a bare 401.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AppState } from "../appState.ts";
import { getMasterKey } from "../config.ts";
import { openBox, seal } from "../crypto/secretbox.ts";
import { type MediaPlayKeyRow, nowIso } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";

const log = getLogger("app.media.playkeys");

/** Bound into the AEAD as additional data so a sealed blob minted for some
 * other purpose (an upload token, an access blob) can never be replayed here. */
const AAD = Buffer.from("fileupload:media-play-key:v1");

export const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MIN_TTL_SECONDS = 60;

/** How stale `last_used_at` is allowed to get before a stream request spends a
 * write on it. Mirrors SessionManager's throttle -- mpv issues a Range request
 * per seek and each one would otherwise be a write. */
const LAST_USED_THROTTLE_MS = 60 * 1000;

/** The sealed payload. Kept to short keys because the whole thing ends up in a
 * URL the user has to copy into a terminal. */
interface PlayKeyPayload {
	/** Payload version, so the shape can change without silently mis-parsing. */
	v: 1;
	/** Opaque id, the join key to the `media_play_keys` revocation row. */
	jti: string;
	/** User the key was minted for. */
	uid: number;
	/** File-scoped key: the only file it will play. */
	fid?: number;
	/** Collection-scoped key: plays any playable entry of this directory. */
	did?: number;
	/** Expiry, epoch seconds. */
	exp: number;
	/** Minting node's NODE_ID (empty string when unclustered). */
	nid: string;
}

export type PlayKeyScope =
	| { kind: "file"; fileId: number }
	| { kind: "directory"; directoryId: number };

export interface MintedPlayKey {
	row: MediaPlayKeyRow;
	/** The raw token. Shown once; only its jti is recoverable afterwards. */
	token: string;
}

export type PlayKeyFailure =
	| "malformed"
	| "expired"
	| "unknown"
	| "revoked"
	| "wrong_node"
	| "ip_mismatch";

export type PlayKeyResult =
	| { ok: true; payload: PlayKeyPayload; row: MediaPlayKeyRow }
	| { ok: false; reason: PlayKeyFailure; nodeId?: string };

export function clampTtl(seconds: number | undefined): number {
	if (!seconds || !Number.isFinite(seconds)) return DEFAULT_TTL_SECONDS;
	return Math.min(
		MAX_TTL_SECONDS,
		Math.max(MIN_TTL_SECONDS, Math.floor(seconds)),
	);
}

/** Mints a key: writes the revocation-list row, then seals the token. */
export function mintPlayKey(
	state: AppState,
	opts: {
		userId: number;
		scope: PlayKeyScope;
		ttlSeconds?: number;
		label?: string | null;
		/** When set, the key only streams from this address. */
		boundIp?: string | null;
	},
): MintedPlayKey {
	const ttl = clampTtl(opts.ttlSeconds);
	const expiresAt = new Date(Date.now() + ttl * 1000);
	const jti = randomBytes(16).toString("base64url");
	const nodeId = state.settings.nodeId || "";

	state.db.run(
		`INSERT INTO media_play_keys
       (jti, user_id, file_id, directory_id, label, node_id, bound_ip, expires_at, created_at)
     VALUES ($jti, $userId, $fileId, $directoryId, $label, $nodeId, $boundIp, $expiresAt, $createdAt)`,
		{
			$jti: jti,
			$userId: opts.userId,
			$fileId: opts.scope.kind === "file" ? opts.scope.fileId : null,
			$directoryId:
				opts.scope.kind === "directory" ? opts.scope.directoryId : null,
			$label: opts.label ?? null,
			$nodeId: nodeId,
			$boundIp: opts.boundIp ?? null,
			$expiresAt: expiresAt.toISOString(),
			$createdAt: nowIso(),
		},
	);
	const row = state.db.get<MediaPlayKeyRow>(
		"SELECT * FROM media_play_keys WHERE jti = $jti",
		{ $jti: jti },
	)!;

	const payload: PlayKeyPayload = {
		v: 1,
		jti,
		uid: opts.userId,
		exp: Math.floor(expiresAt.getTime() / 1000),
		nid: nodeId,
		...(opts.scope.kind === "file"
			? { fid: opts.scope.fileId }
			: { did: opts.scope.directoryId }),
	};
	const token = seal(
		getMasterKey(state.settings),
		Buffer.from(JSON.stringify(payload), "utf-8"),
		AAD,
	).toString("base64url");

	return { row, token };
}

/** Decrypts and validates a token, then checks it against the revocation list.
 * `clientIp` is only consulted for keys that were minted IP-bound. */
export function verifyPlayKey(
	state: AppState,
	token: string | null | undefined,
	clientIp: string | null,
): PlayKeyResult {
	if (!token) return { ok: false, reason: "malformed" };

	let payload: PlayKeyPayload;
	try {
		const plain = openBox(
			getMasterKey(state.settings),
			Buffer.from(token, "base64url"),
			AAD,
		);
		payload = JSON.parse(plain.toString("utf-8")) as PlayKeyPayload;
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (payload.v !== 1 || typeof payload.jti !== "string") {
		return { ok: false, reason: "malformed" };
	}
	if (!payload.fid && !payload.did) return { ok: false, reason: "malformed" };
	if (payload.exp * 1000 <= Date.now()) return { ok: false, reason: "expired" };

	const selfNode = state.settings.nodeId || "";
	if ((payload.nid || "") !== selfNode) {
		return { ok: false, reason: "wrong_node", nodeId: payload.nid };
	}

	const row = state.db.get<MediaPlayKeyRow>(
		"SELECT * FROM media_play_keys WHERE jti = $jti",
		{ $jti: payload.jti },
	);
	// Unknown jti is a hard failure, not a fallback to the token's own word --
	// see the module docstring for why that keeps pruning safe.
	if (!row) return { ok: false, reason: "unknown" };
	if (row.revoked_at) return { ok: false, reason: "revoked" };
	if (row.expires_at <= nowIso()) return { ok: false, reason: "expired" };

	if (row.bound_ip) {
		const a = Buffer.from(row.bound_ip);
		const b = Buffer.from(clientIp ?? "");
		if (a.length !== b.length || !timingSafeEqual(a, b)) {
			return { ok: false, reason: "ip_mismatch" };
		}
	}
	return { ok: true, payload, row };
}

/** True when this key is allowed to play `fileId`, which must already have been
 * confirmed to live in `directoryId`. */
export function playKeyCoversFile(
	result: Extract<PlayKeyResult, { ok: true }>,
	fileId: number,
	directoryId: number | null,
): boolean {
	const { payload } = result;
	if (payload.fid) return payload.fid === fileId;
	if (payload.did) return directoryId !== null && payload.did === directoryId;
	return false;
}

/** Throttled `last_used_at` bump -- see LAST_USED_THROTTLE_MS. */
export function touchPlayKey(db: Db, row: MediaPlayKeyRow): void {
	const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
	if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
	db.run("UPDATE media_play_keys SET last_used_at = $now WHERE id = $id", {
		$now: nowIso(),
		$id: row.id,
	});
}

/** Marks a key revoked. Returns false if it was already revoked or absent. */
export function revokePlayKey(db: Db, id: number, userId?: number): boolean {
	const claimed = db.get<{ id: number }>(
		`UPDATE media_play_keys SET revoked_at = $now
       WHERE id = $id AND revoked_at IS NULL
         AND ($userId IS NULL OR user_id = $userId)
     RETURNING id`,
		{ $now: nowIso(), $id: id, $userId: userId ?? null },
	);
	return !!claimed;
}

export function listPlayKeys(db: Db, userId: number): MediaPlayKeyRow[] {
	return db.all<MediaPlayKeyRow>(
		`SELECT * FROM media_play_keys
       WHERE user_id = $userId AND revoked_at IS NULL AND expires_at > $now
     ORDER BY created_at DESC`,
		{ $userId: userId, $now: nowIso() },
	);
}

/** Scheduler job. Only ever deletes rows whose expiry has already passed, so a
 * revocation is never dropped while the token it kills could still be used. */
export function prunePlayKeys(db: Db): number {
	const stale = db.all<{ id: number }>(
		"SELECT id FROM media_play_keys WHERE expires_at <= $now",
		{ $now: nowIso() },
	);
	if (stale.length === 0) return 0;
	db.run("DELETE FROM media_play_keys WHERE expires_at <= $now", {
		$now: nowIso(),
	});
	log.info(`pruned expired media play keys count=${stale.length}`);
	return stale.length;
}
