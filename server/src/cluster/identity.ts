import { randomFillSync } from "node:crypto";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";

/**
 * Cluster-wide row identity (redesign §5.6).
 *
 * Every replicated table carries a `uid` — a ULID minted where the row is
 * created — alongside its local `INTEGER PRIMARY KEY`. The integer key stays:
 * it is what joins and foreign keys use, it is fast, and it is nobody's
 * business outside this node. The `uid` is the *replication* identity, and it
 * is the only one that goes on the wire.
 *
 * The reason is D1: two nodes accepting concurrent uploads both mint
 * `files.id = 42`, and no amount of announce/reserve/rebase protocol can undo
 * that after the fact, because there is nothing to renumber to. A ULID is
 * unique without coordination, so the collision never happens and the protocol
 * built to detect it is unnecessary.
 *
 * ULID rather than UUIDv4 because the first 48 bits are a timestamp: uids sort
 * roughly by creation time, which keeps the unique index append-mostly instead
 * of scattering inserts across the whole B-tree.
 *
 * SCOPE, until §5.7's change log lands: uids are minted by the boot backfill
 * and by `ensureUid`, not by the several dozen INSERT sites across the routes.
 * A row created between two boots therefore has `uid IS NULL` until something
 * asks for its identity. That is deliberate — the fix is not to hunt down every
 * call site but to move the append (and the mint with it) into the DB adapter,
 * where a write that isn't logged becomes impossible rather than discouraged.
 */

const log = getLogger("app.cluster.identity");

/** Tables that replicate, and therefore need an identity that survives leaving
 * this node. Kept in step with `cluster/replication.ts`'s REPLICATED_TABLES —
 * adding a table to one without the other means its rows either travel with no
 * identity or carry one nothing reads. */
export const UID_TABLES = [
	"users",
	"permissions",
	"content_blobs",
	"directories",
	"directory_links",
	"files",
	"links",
] as const;

export type UidTable = (typeof UID_TABLES)[number];

const UID_TABLE_SET: ReadonlySet<string> = new Set(UID_TABLES);

/** Guards every interpolation of a table name into SQL below. */
function assertUidTable(table: string): asserts table is UidTable {
	if (!UID_TABLE_SET.has(table)) {
		throw new Error(`not a uid-bearing table: ${table}`);
	}
}

// ── ULID minting ────────────────────────────────────────────────────────────

/** Crockford base32: no I, L, O or U, so a uid read aloud or retyped from a
 * log line doesn't turn into a different one. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10; // 48 bits
const RANDOM_BYTES = 10; // 80 bits -> 16 chars

let lastTime = 0;
const lastRandom = new Uint8Array(RANDOM_BYTES);

function encodeTime(ms: number): string {
	let remaining = ms;
	let out = "";
	for (let i = 0; i < TIME_CHARS; i++) {
		out = ENCODING[remaining % 32] + out;
		remaining = Math.floor(remaining / 32);
	}
	return out;
}

function encodeRandom(bytes: Uint8Array): string {
	let out = "";
	let value = 0;
	let bits = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ENCODING[(value >>> (bits - 5)) & 31];
			bits -= 5;
			value &= (1 << bits) - 1;
		}
	}
	return out;
}

/** Increment the random component as an 80-bit big-endian integer. Returns
 * false on overflow — all 80 bits set, which needs 2^80 uids inside one
 * millisecond and therefore never happens, but a silent wrap would mint a
 * duplicate so it is handled rather than assumed away. */
function incrementRandom(): boolean {
	for (let i = RANDOM_BYTES - 1; i >= 0; i--) {
		if (lastRandom[i]! < 0xff) {
			lastRandom[i]!++;
			return true;
		}
		lastRandom[i] = 0;
	}
	return false;
}

/** A new ULID. Monotonic within a millisecond: two uids minted in the same
 * tick still sort in creation order, so `ORDER BY uid` never lies about which
 * of two rows this node made first. */
export function newUid(): string {
	const now = Date.now();
	if (now > lastTime) {
		lastTime = now;
		randomFillSync(lastRandom);
	} else if (!incrementRandom()) {
		// Overflow, or a clock that stepped backwards: hold the timestamp and
		// carry, so a uid minted later never sorts before one minted earlier.
		lastTime += 1;
		randomFillSync(lastRandom);
	}
	return encodeTime(lastTime) + encodeRandom(lastRandom);
}

// ── uid ↔ id resolution ─────────────────────────────────────────────────────

export function idToUid(
	db: Db,
	table: UidTable,
	id: number,
): string | undefined {
	assertUidTable(table);
	return (
		db.get<{ uid: string | null }>(`SELECT uid FROM ${table} WHERE id = $id`, {
			$id: id,
		})?.uid ?? undefined
	);
}

export function uidToId(
	db: Db,
	table: UidTable,
	uid: string,
): number | undefined {
	assertUidTable(table);
	return db.get<{ id: number }>(`SELECT id FROM ${table} WHERE uid = $uid`, {
		$uid: uid,
	})?.id;
}

/** The uid for a local row, minting one if it has none.
 *
 * Rows created by code that predates the change log still arrive without a
 * uid; this is what stops that being a silent hole. Throws for an id that
 * doesn't exist, because a caller asking for the identity of a missing row is
 * asking the wrong question. */
export function ensureUid(db: Db, table: UidTable, id: number): string {
	assertUidTable(table);
	const existing = idToUid(db, table, id);
	if (existing) return existing;
	const row = db.get<{ id: number }>(`SELECT id FROM ${table} WHERE id = $id`, {
		$id: id,
	});
	if (!row) throw new Error(`${table} row ${id} does not exist`);
	const uid = newUid();
	db.run(`UPDATE ${table} SET uid = $uid WHERE id = $id AND uid IS NULL`, {
		$uid: uid,
		$id: id,
	});
	// A concurrent minter may have won; the stored value is the answer.
	return idToUid(db, table, id) ?? uid;
}

// ── backfill ────────────────────────────────────────────────────────────────

/** Rows updated per transaction. Small enough that a populated database is
 * never locked for long (D-14: the live data is on one node, and this runs
 * during its boot), large enough that a million rows isn't a million commits. */
const BACKFILL_CHUNK = 500;

/** Mint uids for every pre-existing row that lacks one.
 *
 * Idempotent and live-safe: it only ever writes rows where `uid IS NULL`, so
 * re-running it is a no-op and interrupting it loses nothing but the work not
 * yet done. Runs on every boot rather than behind a "have I done this" flag —
 * the query is an index seek that finds nothing once the table is converted,
 * and a flag would be one more thing that can be wrong. */
export function backfillUids(db: Db): Record<string, number> {
	const minted: Record<string, number> = {};
	for (const table of UID_TABLES) {
		let count = 0;
		// Keyset cursor, not a re-scan from the start: the pass always moves
		// forward even if a row somehow ends up still NULL, rather than fetching
		// the same page forever.
		let after = 0;
		for (;;) {
			const rows = db.all<{ id: number }>(
				`SELECT id FROM ${table} WHERE uid IS NULL AND id > $after
           ORDER BY id LIMIT ${BACKFILL_CHUNK}`,
				{ $after: after },
			);
			if (rows.length === 0) break;
			db.transaction(() => {
				for (const row of rows) {
					db.run(
						`UPDATE ${table} SET uid = $uid WHERE id = $id AND uid IS NULL`,
						{ $uid: newUid(), $id: row.id },
					);
				}
			});
			count += rows.length;
			after = rows[rows.length - 1]!.id;
		}
		if (count > 0) minted[table] = count;
	}
	const total = Object.values(minted).reduce((a, b) => a + b, 0);
	if (total > 0) {
		log.info(
			`minted ${total} row uids: ${Object.entries(minted)
				.map(([t, n]) => `${t}=${n}`)
				.join(" ")}`,
		);
	}
	return minted;
}
