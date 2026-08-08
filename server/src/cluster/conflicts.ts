import { nowIso, type ReplicationConflictRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";

/**
 * Conflict arbitration (redesign §5.8).
 *
 * The master gates *quota*, not every mutation — a rename, a move, a
 * permission edit and a link revocation consume no quota, so two nodes can
 * still both accept an edit to the same row. Detection is optimistic
 * concurrency control keyed on `master_seq`: an entry carries the
 * `base_master_seq` the row was at when its writer changed it, and if that is
 * no longer where the row is, the two edits are concurrent.
 *
 * Arbitration is **later timestamp wins, node id breaking the tie** (D-8), and
 * three things about it are load-bearing:
 *
 * - **Only the master runs the rule.** It is evaluated once, against one
 *   clock's view of arrival, rather than independently on every node against
 *   its own — which is the failure mode last-write-wins-everywhere has and
 *   this does not. Two nodes cannot reach opposite verdicts.
 * - **The node-id tiebreak is not decoration.** Second-resolution timestamps
 *   collide constantly under scripted or bulk edits, and a rule that is
 *   undefined on a tie is a rule that diverges on a tie.
 * - **Clock skew is bounded, not trusted.** An entry whose `ts` runs ahead of
 *   the master's own clock by more than `CLOCK_SKEW_MS` is compared at master
 *   receipt time instead. Otherwise one node with a fast clock quietly wins
 *   every conflict it ever enters.
 *
 * Whichever edit loses is written to `replication_conflicts` — the incoming
 * one, or the one already committed when the timestamp rule goes the other
 * way. Nothing is silently dropped, which is the whole difference between this
 * and the undocumented "whoever pushed last wins" it replaces (D2).
 */

const log = getLogger("app.cluster.conflicts");

/** How far ahead of the master's clock an entry's `ts` may be and still be
 * taken at face value. Beyond it the entry is compared at receipt time, so a
 * node with a running-fast clock cannot mint itself a permanent advantage. */
export const CLOCK_SKEW_MS = 60_000;

export interface ArbitrationInput {
	ts: string;
	origin_node: string;
}

/** The rule itself, pure and total: later `ts`, then higher `origin_node`.
 *
 * Total is the point — every pair of inputs has a defined winner, so the same
 * pair cannot be decided two ways. */
export function winnerOf(
	committed: ArbitrationInput,
	incoming: ArbitrationInput,
): "committed" | "incoming" {
	if (incoming.ts !== committed.ts) {
		return incoming.ts > committed.ts ? "incoming" : "committed";
	}
	return incoming.origin_node > committed.origin_node
		? "incoming"
		: "committed";
}

/** An entry's timestamp as the master will compare it: its own, unless that is
 * further ahead of the master's clock than the skew allowance, in which case
 * receipt time stands in. */
export function comparableTs(
	entryTs: string,
	receivedAt: string,
	skewMs = CLOCK_SKEW_MS,
): string {
	const entry = Date.parse(entryTs);
	const now = Date.parse(receivedAt);
	if (!Number.isFinite(entry) || !Number.isFinite(now)) return entryTs;
	return entry - now > skewMs ? receivedAt : entryTs;
}

export interface ConflictRecord {
	table_name: string;
	row_uid: string;
	losing_op: string;
	/** JSON of the losing edit's columns, or `"null"` for a delete. */
	losing_payload: string;
	losing_ts: string;
	winning_master_seq: number;
	winning_ts: string;
	origin_node: string;
	winner_node: string;
	origin_seq: number | null;
}

/** Record a loser. Returns false when this exact losing entry has already been
 * recorded, which is what makes a re-delivered entry harmless: the master
 * neither double-records it nor restates the winner a second time. */
export function recordConflict(db: Db, record: ConflictRecord): boolean {
	// RETURNING tells us whether the row was actually inserted: ON CONFLICT DO
	// NOTHING returns nothing, which is exactly the "already recorded" signal.
	const inserted = db.get<{ id: number }>(
		`INSERT INTO replication_conflicts
       (table_name, row_uid, losing_op, losing_payload, losing_ts,
        winning_master_seq, winning_ts, origin_node, winner_node, origin_seq,
        detected_at)
     VALUES ($table, $uid, $op, $payload, $losingTs, $winningSeq, $winningTs,
             $origin, $winner, $originSeq, $now)
     ON CONFLICT(origin_node, origin_seq) DO NOTHING
     RETURNING id`,
		{
			$table: record.table_name,
			$uid: record.row_uid,
			$op: record.losing_op,
			$payload: record.losing_payload,
			$losingTs: record.losing_ts,
			$winningSeq: record.winning_master_seq,
			$winningTs: record.winning_ts,
			$origin: record.origin_node,
			$winner: record.winner_node,
			$originSeq: record.origin_seq,
			$now: nowIso(),
		},
	);
	if (!inserted) return false;
	log.warning(
		`replication conflict on ${record.table_name}/${record.row_uid}: ` +
			`${record.winner_node} @ ${record.winning_ts} beat ${record.origin_node} @ ${record.losing_ts}`,
	);
	return true;
}

export function listConflicts(
	db: Db,
	opts: { includeDismissed?: boolean; limit?: number } = {},
): ReplicationConflictRow[] {
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	return db.all<ReplicationConflictRow>(
		`SELECT * FROM replication_conflicts
      ${opts.includeDismissed ? "" : "WHERE dismissed_at IS NULL"}
      ORDER BY id DESC LIMIT $limit`,
		{ $limit: limit },
	);
}

export function getConflict(
	db: Db,
	id: number,
): ReplicationConflictRow | undefined {
	return db.get<ReplicationConflictRow>(
		"SELECT * FROM replication_conflicts WHERE id = $id",
		{ $id: id },
	);
}

/** Dismissing is bookkeeping, not a decision: the winner already won, and this
 * only says an operator has looked. Kept rather than deleted so the record of
 * the divergence survives. */
export function dismissConflict(db: Db, id: number): boolean {
	const row = getConflict(db, id);
	if (!row || row.dismissed_at) return false;
	db.run(
		"UPDATE replication_conflicts SET dismissed_at = $now WHERE id = $id",
		{ $now: nowIso(), $id: id },
	);
	return true;
}

export function openConflictCount(db: Db): number {
	return (
		db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM replication_conflicts WHERE dismissed_at IS NULL",
		)?.n ?? 0
	);
}
