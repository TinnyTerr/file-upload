import type { Database } from "bun:sqlite";
import { nowIso } from "../db/rows.ts";
import type { Db, SqlParams } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { comparableTs, recordConflict, winnerOf } from "./conflicts.ts";
import { UID_TABLES, type UidTable } from "./identity.ts";

/**
 * The replication change log (redesign §5.7).
 *
 * Every mutation to a replicated table appends one row to `replication_log`,
 * **inside the same transaction as the write**, from a trigger. Not from a
 * call site. That distinction is the whole phase: the old design asked ~40
 * route handlers to remember to call `replicateFile`, two of them did, and the
 * rest of the mutations (renames, moves, deletes, permission edits, link
 * revocations, lifecycle transitions) simply never left the node they happened
 * on — defect B5. A trigger cannot be forgotten.
 *
 * Three consequences worth stating, because they are what make the rest of the
 * file the shape it is:
 *
 * - **`id` never goes on the wire.** A payload carries the row's `uid`, and
 *   every foreign key is translated to the parent's `uid` on the way out and
 *   back to a local id on the way in. Two nodes minting `files.id = 42` is D1,
 *   and the fix is not to arbitrate the collision but to never speak the
 *   number.
 * - **Entries apply in `seq` order and stop at the first failure.** The origin
 *   appended them in causal order — a file row cannot be inserted before the
 *   folder holding it — and a forwarding hop re-appends in the order it
 *   applied. So seq order *is* dependency order, and the pending-parent buffer
 *   §5.7 allows for is unnecessary. A halt leaves the cursor before the bad
 *   entry rather than skipping it.
 * - **Applying is suppressed.** `replication_control.suppressed` is raised
 *   while a peer's entry is written, so it isn't re-logged as if this node had
 *   originated it; the entry is then appended explicitly with the origin's
 *   node id and seq preserved, which is what lets it forward another hop.
 */

const log = getLogger("app.cluster.changelog");

/** Replicated tables, parents before children. Applying in this order is only
 * a fallback for the seed pass — live entries are ordered by the log itself. */
export const CHANGELOG_TABLES = UID_TABLES;

/** Columns that replicate, per table. `id` is deliberately absent from every
 * one of them: it is node-local (§5.6). Anything added to a replicated table
 * has to be added here too, or it silently resets to its default on every
 * peer. */
export const TABLE_COLUMNS: Record<UidTable, string[]> = {
	users: [
		"uid",
		"username",
		// `password_hash` is deliberately absent (§5.10, D-12). Every node can
		// *authorize* every user without a round-trip, which is what §5.9's local
		// permission read depends on -- but the material that lets a node
		// *authenticate* them is fetched on demand at first login there, and the
		// hash therefore lives only on nodes the user has actually used.
		// `credential_version` is the invalidation half, and it does replicate:
		// a bump is how every peer learns its cached copy is stale.
		"credential_version",
		"role",
		"must_change_credentials",
		"avatar_data",
		"avatar_content_type",
		"mfa_required",
		"webauthn_user_handle",
		"created_at",
	],
	permissions: [
		"uid",
		"user_id",
		"can_upload",
		"can_upload_client_encrypted",
		"can_delete",
		"can_regenerate_links",
		"can_delete_links",
		"can_create_directories",
		"can_manage_lifecycle",
		"can_use_api_keys",
		"can_view_admin",
		"can_manage_users",
		"can_manage_storage",
		"can_manage_api_keys",
		"can_manage_cluster",
		"can_use_torrents",
		"can_watch_media",
		"require_mfa",
		"require_passkey",
		"quota_bytes",
		"max_file_bytes",
		"archive_after_idle_days",
		"created_at",
	],
	content_blobs: [
		"uid",
		"storage_path",
		"content_type",
		"size_bytes",
		"stored_size_bytes",
		"sha256",
		"sha1",
		"md5",
		"blake2b",
		"stored_sha256",
		"transform_key",
		"ref_count",
		"archived",
		"media_width",
		"media_height",
		"media_duration_seconds",
		"created_at",
	],
	blob_chunks: [
		"uid",
		"blob_id",
		"idx",
		"chunk_sha256",
		"size_bytes",
		"created_at",
	],
	chunk_locations: [
		"uid",
		"chunk_sha256",
		// The cluster node id, not a cluster_nodes row id: it is a name every
		// node already agrees on, so it needs no translation and appears in no
		// FOREIGN_KEYS entry.
		"node_id",
		"state",
		"size_bytes",
		"pinned",
		"updated_at",
		// `last_read_at` is deliberately absent -- it lives in the node-local
		// `local_chunk_cache`, because an LRU touch must not append a log entry.
	],
	directories: [
		"uid",
		"owner_id",
		"slug",
		"title",
		"parent_directory_id",
		"encryption_mode",
		"enc_key_blob",
		"enc_access_blob",
		"access_is_password",
		"encryption_overridden",
		"key_check_blob",
		"total_bytes",
		"expires_at",
		"hide_uploader",
		"saved_from_directory_id",
		"is_library",
		"library_visibility",
		"library_kind",
		"library_overview",
		"library_poster_file_id",
		"library_published_at",
		"gallery_view",
		"created_at",
	],
	directory_links: [
		"uid",
		"directory_id",
		"slug",
		"max_uses",
		"use_count",
		"expires_at",
		"active",
		"hide_uploader",
		"created_at",
	],
	files: [
		"uid",
		"owner_id",
		"blob_id",
		"directory_id",
		"storage_path",
		"original_filename",
		"source_type",
		"saved_from_file_id",
		"saved_from_directory_id",
		"size_bytes",
		"stored_size_bytes",
		"content_type",
		"encryption_mode",
		"enc_key_blob",
		"enc_access_blob",
		"access_is_password",
		"seal_salt",
		"encryption_overridden",
		"compressed",
		"archived",
		"archive_codec",
		"archive_original_stored_size_bytes",
		"archive_saved_bytes",
		"archive_after_idle_days",
		"lifecycle_state",
		"is_permanent",
		"expires_at",
		"delete_if_idle_days",
		"auto_unarchive_on_download",
		"created_at",
		"last_downloaded_at",
	],
	links: [
		"uid",
		"file_id",
		"slug",
		"max_uses",
		"use_count",
		"expires_at",
		"active",
		"hide_uploader",
		"created_at",
	],
};

/** Columns declared BLOB. `json_object()` refuses to hold a blob, so these
 * travel as uppercase hex and are decoded back on apply. Asserted against
 * `PRAGMA table_info` by the tests rather than derived at runtime — an
 * unnoticed new blob column should fail a test, not silently corrupt a
 * payload. */
export const BLOB_COLUMNS: Record<string, ReadonlySet<string>> = {
	users: new Set(["avatar_data"]),
	directories: new Set(["enc_key_blob", "enc_access_blob"]),
	files: new Set(["enc_key_blob", "enc_access_blob", "seal_salt"]),
};

/** NOT NULL columns that a payload deliberately does not carry, and what to
 * put in them when *inserting* a replicated row.
 *
 * Exactly one entry, and it is the identity split (§5.10): `password_hash` is
 * node-local material, but the column is NOT NULL on a table whose rows do
 * replicate, so an insert has to write something. '' is chosen because
 * `verifyPassword` reads a malformed hash as "wrong password" rather than
 * throwing — a node holding no material fails closed until it fetches.
 *
 * Applied on INSERT only, never in the ON CONFLICT assignments: an update
 * arriving from a peer must not wipe material this node already holds. */
const INSERT_PLACEHOLDERS: Partial<Record<UidTable, Record<string, unknown>>> =
	{
		users: { password_hash: "" },
	};

interface ForeignKey {
	/** The table the id points into. */
	parent: UidTable;
	/** A real FK the database enforces, so an unresolvable parent means this
	 * entry cannot be applied yet and the batch must halt. Soft references
	 * (no REFERENCES clause in schema.sql) are set to NULL instead: they are
	 * provenance, and losing the pointer is better than refusing the row. */
	required: boolean;
}

/** id-valued columns, and what they point at. Both the real foreign keys and
 * the bare INTEGER provenance columns — anything holding a local id has to be
 * translated, enforced or not, or it lands on a peer pointing at whatever row
 * happens to occupy that id there. */
export const FOREIGN_KEYS: Partial<
	Record<UidTable, Record<string, ForeignKey>>
> = {
	permissions: { user_id: { parent: "users", required: true } },
	// A manifest entry without its blob is meaningless, so the parent is
	// required: the batch halts until the `content_blobs` row lands, which the
	// origin appended first.
	blob_chunks: { blob_id: { parent: "content_blobs", required: true } },
	directories: {
		owner_id: { parent: "users", required: true },
		parent_directory_id: { parent: "directories", required: true },
		saved_from_directory_id: { parent: "directories", required: false },
		library_poster_file_id: { parent: "files", required: false },
	},
	directory_links: {
		directory_id: { parent: "directories", required: true },
	},
	files: {
		owner_id: { parent: "users", required: true },
		blob_id: { parent: "content_blobs", required: true },
		directory_id: { parent: "directories", required: true },
		saved_from_file_id: { parent: "files", required: false },
		saved_from_directory_id: { parent: "directories", required: false },
	},
	links: { file_id: { parent: "files", required: true } },
};

export type ChangeOp = "upsert" | "delete";

export interface ChangeEntry {
	/** The *serving* node's local seq. Only meaningful for cursoring against
	 * that node; never used as identity. */
	seq: number;
	master_seq: number | null;
	base_master_seq: number | null;
	table_name: string;
	row_uid: string;
	op: ChangeOp;
	payload: Record<string, unknown> | null;
	origin_node: string;
	origin_seq: number;
	ts: string;
}

// ── SQL fragments ───────────────────────────────────────────────────────────

/** Crockford base32, matching `identity.ts`'s ENCODING. */
const ULID_ALPHABET = "'0123456789ABCDEFGHJKMNPQRSTVWXYZ'";

/** A ULID, in pure SQL, for minting a uid inside an insert trigger.
 *
 * Same 26-character Crockford shape as `identity.ts::newUid` — 48 bits of
 * millisecond timestamp then 80 bits of randomness — because the two mint into
 * the same column and a uid should not betray which of them made it. It is not
 * monotonic within a millisecond the way `newUid` is; nothing depends on that,
 * since ordering authority is `replication_log.seq` and not the uid.
 *
 * `random() & 31` rather than `abs(random()) % 32`: SQLite's `abs()` returns
 * NULL for the one integer whose negation overflows, and a NULL there would
 * quietly produce a NULL uid. */
function ulidSql(): string {
	const ms = "CAST(unixepoch('now','subsec') * 1000 AS INTEGER)";
	const parts: string[] = [];
	for (let i = 9; i >= 0; i--) {
		parts.push(`substr(${ULID_ALPHABET}, ((${ms}) / ${32 ** i}) % 32 + 1, 1)`);
	}
	for (let i = 0; i < 16; i++) {
		parts.push(`substr(${ULID_ALPHABET}, (random() & 31) + 1, 1)`);
	}
	return parts.join(" || ");
}

/** Matches `nowIso()` exactly (ISO8601 UTC, milliseconds, trailing Z) — the
 * codebase compares timestamps as strings, so the format has to be identical
 * whichever side wrote it. */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const NODE_ID_SQL = "(SELECT node_id FROM replication_control WHERE id = 1)";
const SUPPRESSED_SQL =
	"(SELECT suppressed FROM replication_control WHERE id = 1)";

/** `json_object(...)` over one table's replicated columns, read from an alias
 * of the table itself rather than from NEW — the insert trigger mints the uid
 * first, and NEW would still hold the NULL. */
function payloadSql(table: UidTable): string {
	const blobs = BLOB_COLUMNS[table] ?? new Set<string>();
	const fks = FOREIGN_KEYS[table] ?? {};
	const args: string[] = [];
	for (const col of TABLE_COLUMNS[table]) {
		if (col === "uid") continue;
		const fk = fks[col];
		if (fk) {
			// The parent's uid, not its id. NULL id stays NULL; a parent row that
			// somehow has no uid also yields NULL, which apply treats as a miss.
			args.push(
				`'${col}', (SELECT p.uid FROM ${fk.parent} p WHERE p.id = ${table}.${col})`,
			);
		} else if (blobs.has(col)) {
			// hex(NULL) is '' rather than NULL, so the CASE is load-bearing.
			args.push(
				`'${col}', CASE WHEN ${table}.${col} IS NULL THEN NULL ELSE hex(${table}.${col}) END`,
			);
		} else {
			args.push(`'${col}', ${table}.${col}`);
		}
	}
	return `json_object(${args.join(", ")})`;
}

/** The append itself, as an INSERT..SELECT over the row(s) matched by `where`.
 * Shared verbatim between the triggers and the one-shot seed pass, so a seeded
 * entry and a live one are byte-identical in shape. */
function appendSql(table: UidTable, where: string): string {
	return `INSERT INTO replication_log
      (table_name, row_uid, op, payload, base_master_seq, origin_node, ts)
    SELECT '${table}', ${table}.uid, 'upsert', ${payloadSql(table)},
      (SELECT MAX(l.master_seq) FROM replication_log l
        WHERE l.table_name = '${table}' AND l.row_uid = ${table}.uid),
      ${NODE_ID_SQL}, ${NOW_SQL}
    FROM ${table} WHERE ${where} AND ${table}.uid IS NOT NULL`;
}

/** Fires only once this node has an identity and is not mid-apply. The
 * identity half is what keeps the boot uid backfill out of the log: it runs
 * during `createSqliteDb`, before `createAppState` names the node, and minting
 * an identity for an existing row is not a change any peer needs. */
function triggerGuard(): string {
	return `${NODE_ID_SQL} <> '' AND ${SUPPRESSED_SQL} = 0`;
}

function triggerSql(table: UidTable): string[] {
	const guard = triggerGuard();
	return [
		`DROP TRIGGER IF EXISTS trg_repl_${table}_ins`,
		`CREATE TRIGGER trg_repl_${table}_ins AFTER INSERT ON ${table}
       WHEN ${guard}
     BEGIN
       -- A trigger's own statements DO fire other triggers (recursive_triggers
       -- governs self-recursion only), so the mint is fenced or it would show
       -- up as a second, spurious update entry.
       UPDATE replication_control SET suppressed = 1 WHERE id = 1;
       UPDATE ${table} SET uid = ${ulidSql()} WHERE id = NEW.id AND uid IS NULL;
       UPDATE replication_control SET suppressed = 0 WHERE id = 1;
       ${appendSql(table, `${table}.id = NEW.id`)};
     END`,
		`DROP TRIGGER IF EXISTS trg_repl_${table}_upd`,
		`CREATE TRIGGER trg_repl_${table}_upd AFTER UPDATE ON ${table}
       WHEN ${guard}
     BEGIN
       -- Mints here too, not only on insert. A row can reach this trigger with
       -- no uid -- it was written in the window between the boot backfill and
       -- the node learning its identity -- and without the mint its every
       -- later change would be dropped silently, since the append below
       -- requires one.
       UPDATE replication_control SET suppressed = 1 WHERE id = 1;
       UPDATE ${table} SET uid = ${ulidSql()} WHERE id = NEW.id AND uid IS NULL;
       UPDATE replication_control SET suppressed = 0 WHERE id = 1;
       ${appendSql(table, `${table}.id = NEW.id`)};
     END`,
		`DROP TRIGGER IF EXISTS trg_repl_${table}_del`,
		`CREATE TRIGGER trg_repl_${table}_del AFTER DELETE ON ${table}
       WHEN ${guard} AND OLD.uid IS NOT NULL
     BEGIN
       INSERT INTO replication_log
         (table_name, row_uid, op, payload, base_master_seq, origin_node, ts)
       VALUES ('${table}', OLD.uid, 'delete', NULL,
         (SELECT MAX(l.master_seq) FROM replication_log l
           WHERE l.table_name = '${table}' AND l.row_uid = OLD.uid),
         ${NODE_ID_SQL}, ${NOW_SQL});
     END`,
	];
}

/** Fills in the two sequence numbers a freshly appended entry cannot know at
 * INSERT time.
 *
 * `origin_seq` defaults to this node's own `seq` — that is what "originated
 * here" means, and a forwarded entry supplies its own so COALESCE leaves it
 * alone. `master_seq` is assigned only on the master, where the local log
 * order *is* the canonical order, so the two numbers coincide there and no
 * separate counter is needed.
 *
 * "Am I the master" is read from `replication_control.is_master`, mirrored
 * there by `cluster/tiering.ts` on every generation change. It has to be a
 * table column for the same reason the node id and the suppression flag are: a
 * trigger cannot reach application state, only other tables. */
const LOG_FIXUP_SQL = [
	"DROP TRIGGER IF EXISTS trg_repl_log_seq",
	`CREATE TRIGGER trg_repl_log_seq AFTER INSERT ON replication_log
   BEGIN
     UPDATE replication_log
        SET origin_seq = COALESCE(origin_seq, seq),
            master_seq = CASE
              WHEN (SELECT is_master FROM replication_control WHERE id = 1) = 1
                THEN COALESCE(master_seq, seq)
              ELSE master_seq END
      WHERE seq = NEW.seq;
   END`,
];

// ── install ─────────────────────────────────────────────────────────────────

/** Create the control row and every trigger. Called from `createSqliteDb`, so
 * a database this process opened is always logging — there is no window in
 * which writes land untracked, and no call site that has to opt in.
 *
 * Idempotent: triggers are dropped and recreated, which is also how a schema
 * change to a replicated table takes effect (the trigger body embeds the
 * column list, so it has to be regenerated, and doing it every boot means it
 * cannot drift from `TABLE_COLUMNS`). */
export function installChangeLog(sqlite: Database): void {
	sqlite.exec(
		"INSERT INTO replication_control (id, node_id, suppressed) VALUES (1, '', 0) ON CONFLICT(id) DO NOTHING",
	);
	// A crash mid-apply would otherwise leave the flag raised and silently stop
	// logging every subsequent local write.
	sqlite.exec("UPDATE replication_control SET suppressed = 0 WHERE id = 1");
	for (const statement of LOG_FIXUP_SQL) sqlite.exec(statement);
	for (const table of CHANGELOG_TABLES) {
		for (const statement of triggerSql(table)) sqlite.exec(statement);
	}
}

/** Tell the triggers who this node is. Until this runs, writes are not logged
 * (see `triggerGuard`), which is exactly the behaviour the boot backfill
 * wants. Called from `createAppState`, before anything else writes. */
export function setNodeIdentity(db: Db, nodeId: string): void {
	db.run("UPDATE replication_control SET node_id = $nodeId WHERE id = 1", {
		$nodeId: nodeId,
	});
}

/** Give an already-populated database a change log describing it.
 *
 * Without this, a node that joins after the fact receives only mutations made
 * from that moment on and never learns about the corpus that predates them —
 * and the snapshot endpoint that used to cover that case (`/cluster/export`)
 * is gone, deliberately. Seeding an `upsert` per existing row means the
 * ordinary pull path delivers the whole corpus, so there is exactly one
 * mechanism for state transfer instead of two that can disagree.
 *
 * Runs once, only while the log is empty. */
export function seedChangeLog(db: Db): number {
	const existing = db.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM replication_log",
	);
	if ((existing?.n ?? 0) > 0) return 0;
	let seeded = 0;
	db.transaction(() => {
		for (const table of CHANGELOG_TABLES) db.run(appendSql(table, "1 = 1"));
		seeded = db.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM replication_log",
		)!.n;
	});
	if (seeded > 0) {
		log.info(
			`seeded the replication log with ${seeded} entries describing existing rows`,
		);
	}
	return seeded;
}

// ── reading ─────────────────────────────────────────────────────────────────

interface LogRow {
	seq: number;
	master_seq: number | null;
	base_master_seq: number | null;
	table_name: string;
	row_uid: string;
	op: string;
	payload: string | null;
	origin_node: string;
	origin_seq: number;
	ts: string;
}

function toEntry(row: LogRow): ChangeEntry {
	return {
		seq: row.seq,
		master_seq: row.master_seq,
		base_master_seq: row.base_master_seq,
		table_name: row.table_name,
		row_uid: row.row_uid,
		op: row.op === "delete" ? "delete" : "upsert",
		payload: row.payload
			? (JSON.parse(row.payload) as Record<string, unknown>)
			: null,
		origin_node: row.origin_node,
		origin_seq: row.origin_seq,
		ts: row.ts,
	};
}

/** This node's log from `after` (exclusive), oldest first. Ascending and
 * front-truncated, for the same reason `eventStore.readOwnEvents` is: a
 * consumer advances its cursor to the last entry it received, so handing back
 * the newest N would strand everything older forever (B2). */
export function readChanges(
	db: Db,
	opts: { after?: number; limit?: number } = {},
): ChangeEntry[] {
	const rows = db.all<LogRow>(
		`SELECT seq, master_seq, base_master_seq, table_name, row_uid, op, payload,
            origin_node, origin_seq, ts
       FROM replication_log
      WHERE seq > $after
      ORDER BY seq ASC
      LIMIT $limit`,
		{ $after: opts.after ?? 0, $limit: opts.limit ?? 500 },
	);
	return rows.map(toEntry);
}

export function logHead(db: Db): number {
	return (
		db.get<{ head: number | null }>(
			"SELECT MAX(seq) AS head FROM replication_log",
		)?.head ?? 0
	);
}

// ── cursors ─────────────────────────────────────────────────────────────────

export type PullDirection = "up" | "down";

export function getCursor(
	db: Db,
	peerNodeId: string,
	direction: PullDirection,
): number {
	return (
		db.get<{ seq: number }>(
			"SELECT seq FROM replication_cursors WHERE peer_node_id = $peer AND direction = $dir",
			{ $peer: peerNodeId, $dir: direction },
		)?.seq ?? 0
	);
}

export function setCursor(
	db: Db,
	peerNodeId: string,
	direction: PullDirection,
	seq: number,
): void {
	db.run(
		`INSERT INTO replication_cursors (peer_node_id, direction, seq, updated_at)
     VALUES ($peer, $dir, $seq, $now)
     ON CONFLICT(peer_node_id, direction) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`,
		{ $peer: peerNodeId, $dir: direction, $seq: seq, $now: nowIso() },
	);
}

// ── applying ────────────────────────────────────────────────────────────────

export function isChangelogTable(table: string): table is UidTable {
	return Object.hasOwn(TABLE_COLUMNS, table);
}

function localIdForUid(db: Db, table: UidTable, uid: string): number | null {
	return (
		db.get<{ id: number }>(`SELECT id FROM ${table} WHERE uid = $uid`, {
			$uid: uid,
		})?.id ?? null
	);
}

class UnresolvedParent extends Error {
	constructor(
		readonly column: string,
		readonly parentUid: string,
	) {
		super(`unresolved parent ${column} -> ${parentUid}`);
	}
}

/** Payload values as this node's database wants them: foreign keys back to
 * local ids, hex back to bytes. Throws `UnresolvedParent` when a required
 * parent hasn't landed yet, which halts the batch rather than writing a row
 * that points nowhere. */
function bindPayload(
	db: Db,
	table: UidTable,
	payload: Record<string, unknown>,
): SqlParams {
	const blobs = BLOB_COLUMNS[table] ?? new Set<string>();
	const fks = FOREIGN_KEYS[table] ?? {};
	const out: SqlParams = {};
	for (const col of TABLE_COLUMNS[table]) {
		const raw = payload[col];
		const fk = fks[col];
		if (fk) {
			if (raw === null || raw === undefined) {
				out[`$${col}`] = null;
				continue;
			}
			const id = localIdForUid(db, fk.parent, String(raw));
			if (id === null) {
				if (fk.required) throw new UnresolvedParent(col, String(raw));
				// Provenance only: keep the row, lose the pointer.
				out[`$${col}`] = null;
				continue;
			}
			out[`$${col}`] = id;
			continue;
		}
		if (blobs.has(col)) {
			out[`$${col}`] =
				typeof raw === "string" && raw.length > 0
					? Buffer.from(raw, "hex")
					: null;
			continue;
		}
		out[`$${col}`] = (raw ?? null) as SqlParams[string];
	}
	return out;
}

function upsertRow(
	db: Db,
	table: UidTable,
	uid: string,
	payload: Record<string, unknown>,
): void {
	const cols = TABLE_COLUMNS[table];
	const params = bindPayload(db, table, { ...payload, uid });
	const placeholders = INSERT_PLACEHOLDERS[table] ?? {};
	const placeholderCols = Object.keys(placeholders);
	for (const col of placeholderCols) {
		params[`$${col}`] = placeholders[col] as SqlParams[string];
	}
	// The placeholder columns are in the insert list and out of the update
	// list: a new row needs a value for a NOT NULL column the payload does not
	// carry, and an existing row must keep whatever it already has there.
	const insertCols = [...cols, ...placeholderCols];
	const assignments = cols
		.filter((c) => c !== "uid")
		.map((c) => `${c} = excluded.${c}`)
		.join(", ");
	db.run(
		`INSERT INTO ${table} (${insertCols.join(", ")})
     VALUES (${insertCols.map((c) => `$${c}`).join(", ")})
     ON CONFLICT(uid) DO UPDATE SET ${assignments}`,
		params,
	);
}

// ── arbitration (§5.8, the master only) ─────────────────────────────────────

/** Read from `replication_control` for the same reason the triggers do: it is
 * the one place "am I the master" is available without application state. */
export function isMasterNode(db: Db): boolean {
	return (
		(db.get<{ is_master: number }>(
			"SELECT is_master FROM replication_control WHERE id = 1",
		)?.is_master ?? 0) === 1
	);
}

/** The entry that currently holds this row's ordering — the highest
 * `master_seq` the master has assigned for it. Null for a row the master has
 * never ordered, which is a row nothing can conflict with yet. */
function committedEntry(
	db: Db,
	table: string,
	uid: string,
): LogRow | undefined {
	return db.get<LogRow>(
		`SELECT seq, master_seq, base_master_seq, table_name, row_uid, op, payload,
            origin_node, origin_seq, ts
       FROM replication_log
      WHERE table_name = $table AND row_uid = $uid AND master_seq IS NOT NULL
      ORDER BY master_seq DESC LIMIT 1`,
		{ $table: table, $uid: uid },
	);
}

/** Has this exact entry already been arbitrated here? Either it was accepted
 * (it is in the log, ordered) or it lost (it is in the conflicts table).
 *
 * Master-only, and deliberately so: re-applying an accepted entry would clobber
 * a *later* edit that has since won the row, and re-applying a rejected one
 * would overwrite the winner with the loser. On a follower the redelivery path
 * stays as it was — that is how a node adopts the `master_seq` for an entry it
 * originated. */
function alreadyArbitrated(db: Db, entry: ChangeEntry): boolean {
	const ordered = db.get<{ seq: number }>(
		`SELECT seq FROM replication_log
      WHERE origin_node = $origin AND origin_seq = $originSeq AND master_seq IS NOT NULL`,
		{ $origin: entry.origin_node, $originSeq: entry.origin_seq },
	);
	if (ordered) return true;
	return !!db.get<{ id: number }>(
		"SELECT id FROM replication_conflicts WHERE origin_node = $origin AND origin_seq = $originSeq",
		{ $origin: entry.origin_node, $originSeq: entry.origin_seq },
	);
}

/** Re-append the row's winning state so the node whose edit lost converges.
 *
 * The loser is never written to the master's log, so it never ships down; what
 * ships down is this restatement, which the losing node applies like any other
 * entry. A row that has since been deleted restates as a delete — "the winner"
 * is whatever the master holds, including its absence. */
function restateWinner(db: Db, table: UidTable, uid: string): void {
	const exists = db.get<{ id: number }>(
		`SELECT id FROM ${table} WHERE uid = $uid`,
		{ $uid: uid },
	);
	if (exists) {
		db.run(appendSql(table, `${table}.uid = $uid`), { $uid: uid });
		return;
	}
	db.run(
		`INSERT INTO replication_log
       (table_name, row_uid, op, payload, base_master_seq, origin_node, ts)
     VALUES ($table, $uid, 'delete', NULL,
       (SELECT MAX(l.master_seq) FROM replication_log l
         WHERE l.table_name = $table AND l.row_uid = $uid),
       ${NODE_ID_SQL}, ${NOW_SQL})`,
		{ $table: table, $uid: uid },
	);
}

/** The ordering the master just gave an entry it accepted. Read back rather
 * than predicted: `master_seq` is assigned by the log-fixup trigger, and
 * guessing at `MAX(seq)` would be a second copy of that rule. */
function masterSeqOf(db: Db, entry: ChangeEntry): number {
	return (
		db.get<{ master_seq: number | null }>(
			`SELECT master_seq FROM replication_log
        WHERE origin_node = $origin AND origin_seq = $originSeq`,
			{ $origin: entry.origin_node, $originSeq: entry.origin_seq },
		)?.master_seq ?? 0
	);
}

type Verdict =
	/** Write it. `committed` is set only when the incoming edit *beat* an edit
	 * already here — the loser to record once the winner has an ordering. */
	| { kind: "apply"; committed?: LogRow }
	/** Already decided once; the row state here already reflects the outcome. */
	| { kind: "skip" }
	/** Concurrent, and the edit already committed here wins. */
	| { kind: "reject"; committed: LogRow };

/** §5.8, on the master and nowhere else. */
function arbitrate(db: Db, entry: ChangeEntry, receivedAt: string): Verdict {
	if (alreadyArbitrated(db, entry)) return { kind: "skip" };
	const committed = committedEntry(db, entry.table_name, entry.row_uid);
	// Nothing ordered this row yet, or the writer edited the version this node
	// holds: not concurrent, so there is nothing to arbitrate.
	if (!committed) return { kind: "apply" };
	if (entry.base_master_seq === committed.master_seq) return { kind: "apply" };

	const winner = winnerOf(
		{ ts: committed.ts, origin_node: committed.origin_node },
		{
			ts: comparableTs(entry.ts, receivedAt),
			origin_node: entry.origin_node,
		},
	);
	return winner === "incoming"
		? { kind: "apply", committed }
		: { kind: "reject", committed };
}

/** Write a row as an ordinary *local* change — unsuppressed, so the triggers
 * log it as this node's own edit, with a fresh timestamp and whatever
 * `base_master_seq` the row now stands at.
 *
 * That is exactly what re-applying a losing edit has to be (§5.8): a new edit
 * on top of the winner, not a replay. Replaying the original entry would
 * re-enter it into the arbitration it already lost, and it would lose again. */
export function applyLocalUpsert(
	db: Db,
	table: UidTable,
	uid: string,
	payload: Record<string, unknown>,
): void {
	upsertRow(db, table, uid, payload);
}

export interface ApplyResult {
	/** Entries written locally. */
	applied: number;
	/** The serving node's seq to cursor at — the last entry that applied
	 * cleanly, or the incoming cursor when the very first one failed. */
	cursor: number;
	/** Set when the batch stopped early. The entry it names is retried on the
	 * next pull; it is never skipped. */
	halted?: { seq: number; reason: string };
}

/** Apply a peer's entries, in order, stopping at the first one that cannot be
 * written.
 *
 * Each entry is its own transaction, so a halt keeps everything before it.
 * Halting rather than skipping is the point: an entry that fails today because
 * its parent hasn't arrived succeeds once it has, whereas skipping it would
 * lose the row permanently and leave the cursor claiming otherwise. */
export function applyChanges(
	db: Db,
	entries: ChangeEntry[],
	startCursor: number,
): ApplyResult {
	let applied = 0;
	let cursor = startCursor;
	// Arbitration is the master's job alone (§5.8), and the answer cannot change
	// mid-batch: a node that stopped being master would be applying a batch it
	// no longer orders, and one generation lands between pulls, not inside one.
	const arbitrating = isMasterNode(db);
	for (const entry of entries) {
		if (!isChangelogTable(entry.table_name)) {
			// A peer running a newer version replicating a table this node does not
			// know about. Skipping is right here and only here: there is no local
			// table for it to depend on, so nothing downstream can be waiting.
			log.warning(
				`ignoring change for unknown table ${entry.table_name} (peer is ahead of this node?)`,
			);
			cursor = entry.seq;
			continue;
		}
		const table = entry.table_name;
		try {
			db.transaction(() => {
				const verdict: Verdict = arbitrating
					? arbitrate(db, entry, nowIso())
					: { kind: "apply" };
				if (verdict.kind === "skip") return;
				if (verdict.kind === "reject") {
					// The loser is not written to the row and never enters the log, so
					// it cannot ship down and overwrite the winner. What ships instead
					// is a restatement of the winning state, which is how the node that
					// lost finds out it lost.
					const recorded = recordConflict(db, {
						table_name: table,
						row_uid: entry.row_uid,
						losing_op: entry.op,
						losing_payload: entry.payload
							? JSON.stringify(entry.payload)
							: "null",
						losing_ts: entry.ts,
						winning_master_seq: verdict.committed.master_seq ?? 0,
						winning_ts: verdict.committed.ts,
						origin_node: entry.origin_node,
						winner_node: verdict.committed.origin_node,
						origin_seq: entry.origin_seq,
					});
					if (recorded) restateWinner(db, table, entry.row_uid);
					return;
				}
				db.run("UPDATE replication_control SET suppressed = 1 WHERE id = 1");
				try {
					if (entry.op === "delete") {
						db.run(`DELETE FROM ${table} WHERE uid = $uid`, {
							$uid: entry.row_uid,
						});
					} else if (entry.payload) {
						upsertRow(db, table, entry.row_uid, entry.payload);
					}
				} finally {
					db.run("UPDATE replication_control SET suppressed = 0 WHERE id = 1");
				}
				// Re-append with the origin preserved, so this node can forward it
				// another hop.
				//
				// UNIQUE(origin_node, origin_seq) makes a re-delivered entry harmless
				// -- a peer whose cursor slipped backwards must not error. The
				// conflict branch is not a no-op though: an entry this node wrote
				// itself comes back down carrying the master_seq the master gave it,
				// and adopting that is precisely §5.7's provisional-to-committed
				// transition. COALESCE so a relay that has not been ordered yet can
				// never blank an ordering already learned.
				db.run(
					`INSERT INTO replication_log
             (master_seq, table_name, row_uid, op, payload, base_master_seq, origin_node, origin_seq, ts)
           VALUES ($masterSeq, $table, $uid, $op, $payload, $baseMasterSeq, $origin, $originSeq, $ts)
           ON CONFLICT(origin_node, origin_seq)
             DO UPDATE SET master_seq = COALESCE(excluded.master_seq, replication_log.master_seq)`,
					{
						$masterSeq: entry.master_seq,
						$table: table,
						$uid: entry.row_uid,
						$op: entry.op,
						$payload: entry.payload ? JSON.stringify(entry.payload) : null,
						$baseMasterSeq: entry.base_master_seq,
						$origin: entry.origin_node,
						$originSeq: entry.origin_seq,
						$ts: entry.ts,
					},
				);
				if (verdict.committed) {
					// The incoming edit beat one that was already committed here. The
					// winner ships down on its own; what needs recording is the edit it
					// displaced, which its author still believes took effect.
					recordConflict(db, {
						table_name: table,
						row_uid: entry.row_uid,
						losing_op: verdict.committed.op,
						losing_payload: verdict.committed.payload ?? "null",
						losing_ts: verdict.committed.ts,
						winning_master_seq: masterSeqOf(db, entry),
						winning_ts: entry.ts,
						origin_node: verdict.committed.origin_node,
						winner_node: entry.origin_node,
						origin_seq: verdict.committed.origin_seq,
					});
				}
			});
		} catch (err) {
			const reason =
				err instanceof UnresolvedParent
					? err.message
					: err instanceof Error
						? err.message
						: String(err);
			log.warning(
				`replication apply halted at seq=${entry.seq} table=${table} uid=${entry.row_uid} op=${entry.op}: ${reason}. ` +
					"The cursor stays before this entry, so it is retried on the next pull rather than skipped.",
			);
			return { applied, cursor, halted: { seq: entry.seq, reason } };
		}
		applied++;
		cursor = entry.seq;
	}
	return { applied, cursor };
}
