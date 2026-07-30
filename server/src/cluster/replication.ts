import { createHash } from "node:crypto";
import type { AppState } from "../appState.ts";
import type { ClusterNodeRow } from "../db/rows.ts";
import type { Db, Row, SqlParams } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { adoptEpochIfHigher, getSelfState, resolveMaster } from "./election.ts";
import { ClusterHTTPError, getJson, postJson } from "./http.ts";

/** Mirrors app/cluster/replication.py, adapted from SQLAlchemy ORM merge()
 * to raw SQLite upserts (this codebase has no ORM -- see server/src/db/*).
 *
 * Replicated tables in FK-dependency order (parents first) so a bulk apply
 * never inserts a child before its parent. Sessions are deliberately NOT
 * replicated -- logins stay node-local. Identity/ownership rows replicate so
 * a file uploaded on one node is fully usable (listable, shareable,
 * downloadable) on every node. */
const REPLICATED_TABLES = [
	"users",
	"permissions",
	"content_blobs",
	"directories",
	"directory_links",
	"files",
	"links",
] as const;
type ReplicatedTable = (typeof REPLICATED_TABLES)[number];

const TABLE_COLUMNS: Record<ReplicatedTable, string[]> = {
	users: [
		"id",
		"username",
		"password_hash",
		"role",
		"must_change_credentials",
		"avatar_data",
		"avatar_content_type",
		"mfa_required",
		"webauthn_user_handle",
		"created_at",
	],
	permissions: [
		"id",
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
		"quota_bytes",
		"max_file_bytes",
		"archive_after_idle_days",
		"created_at",
	],
	content_blobs: [
		"id",
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
	directories: [
		"id",
		"owner_id",
		"slug",
		"title",
		"encryption_mode",
		"enc_key_blob",
		"enc_access_blob",
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
		"created_at",
	],
	directory_links: [
		"id",
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
		"id",
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
		"id",
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

const TABLE_ORDER: Record<string, number> = Object.fromEntries(
	REPLICATED_TABLES.map((t, i) => [t, i]),
);

// Columns excluded from a row's identity fingerprint: per-node counters and
// liveness timestamps that legitimately differ for the SAME logical row.
const VOLATILE = new Set([
	"last_downloaded_at",
	"last_seen_at",
	"last_heartbeat_at",
	"use_count",
	"ref_count",
]);

const log = getLogger("app.cluster.replication");

export interface SerializedRow {
	table: string;
	data: Record<string, unknown>;
}

function isTable(table: string): table is ReplicatedTable {
	return Object.hasOwn(TABLE_COLUMNS, table);
}

function encodeValue(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { __b64__: Buffer.from(value).toString("base64") };
	}
	return value;
}

function decodeValue(value: unknown): unknown {
	if (
		value &&
		typeof value === "object" &&
		"__b64__" in (value as Record<string, unknown>)
	) {
		return Buffer.from((value as { __b64__: string }).__b64__, "base64");
	}
	return value;
}

/** Serialize a raw DB row to a JSON-safe {table, data} envelope. */
export function serializeRow(table: ReplicatedTable, row: Row): SerializedRow {
	const data: Record<string, unknown> = {};
	for (const col of TABLE_COLUMNS[table]) {
		data[col] = encodeValue(row[col]);
	}
	return { table, data };
}

/** Stable fingerprint of a row's immutable identity, used to tell whether
 * two nodes hold the SAME logical row at a given id or DIFFERENT ones. */
export function identityHash(
	table: string,
	data: Record<string, unknown>,
): string {
	if (!isTable(table)) return "";
	const cols = TABLE_COLUMNS[table].filter((c) => !VOLATILE.has(c));
	const payload: Record<string, unknown> = {};
	for (const c of cols) payload[c] = data[c] ?? null;
	return createHash("sha256")
		.update(JSON.stringify(payload, Object.keys(payload).sort()))
		.digest("hex");
}

/** Identity fingerprint of the local row at (table, id), or null if absent. */
export function localIdentity(
	db: Db,
	table: string,
	id: number,
): string | null {
	if (!isTable(table)) return null;
	const row = db.get<Row>(`SELECT * FROM ${table} WHERE id = $id`, { $id: id });
	if (!row) return null;
	return identityHash(table, serializeRow(table, row).data);
}

/** Upsert one serialized row by primary key (insert-or-overwrite), the
 * semantics we want: for incoming replication it lands the row at its
 * canonical id, and for a rebase-from-master it overwrites local
 * divergence with the master's truth. */
function applyRow(db: Db, row: SerializedRow): boolean {
	if (!isTable(row.table)) return false;
	const cols = TABLE_COLUMNS[row.table];
	const data = row.data ?? {};
	const params: Record<string, unknown> = {};
	for (const col of cols) params[`$${col}`] = decodeValue(data[col]);
	const colList = cols.join(", ");
	const placeholders = cols.map((c) => `$${c}`).join(", ");
	const updateList = cols
		.filter((c) => c !== "id")
		.map((c) => `${c} = excluded.${c}`)
		.join(", ");
	db.run(
		`INSERT INTO ${row.table} (${colList}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateList}`,
		params as SqlParams,
	);
	return true;
}

/** Upsert serialized rows by primary key, parents before children. */
export function applyRows(db: Db, rows: SerializedRow[]): number {
	const ordered = [...rows].sort(
		(a, b) => (TABLE_ORDER[a.table] ?? 999) - (TABLE_ORDER[b.table] ?? 999),
	);
	let applied = 0;
	db.transaction(() => {
		for (const row of ordered) {
			if (applyRow(db, row)) applied++;
		}
	});
	return applied;
}

/** Serialize every replicated row -- the master's canonical snapshot a
 * joining or diverged node rebases onto. */
export function exportAll(db: Db): SerializedRow[] {
	const rows: SerializedRow[] = [];
	for (const table of REPLICATED_TABLES) {
		for (const row of db.all<Row>(`SELECT * FROM ${table}`)) {
			rows.push(serializeRow(table, row));
		}
	}
	return rows;
}

/** Everything a peer needs to make one uploaded file fully usable: the
 * file, its blob, its links, the owner (+permission) and any containing
 * directory. */
export function collectFileRows(db: Db, fileId: number): SerializedRow[] {
	const f = db.get<Row>("SELECT * FROM files WHERE id = $id", { $id: fileId });
	if (!f) return [];
	const rows: SerializedRow[] = [];
	const owner = db.get<Row>("SELECT * FROM users WHERE id = $id", {
		$id: f.owner_id as number,
	});
	if (owner) {
		rows.push(serializeRow("users", owner));
		const perm = db.get<Row>("SELECT * FROM permissions WHERE user_id = $id", {
			$id: f.owner_id as number,
		});
		if (perm) rows.push(serializeRow("permissions", perm));
	}
	if (f.blob_id) {
		const blob = db.get<Row>("SELECT * FROM content_blobs WHERE id = $id", {
			$id: f.blob_id as number,
		});
		if (blob) rows.push(serializeRow("content_blobs", blob));
	}
	if (f.directory_id) {
		const d = db.get<Row>("SELECT * FROM directories WHERE id = $id", {
			$id: f.directory_id as number,
		});
		if (d) {
			rows.push(serializeRow("directories", d));
			for (const dl of db.all<Row>(
				"SELECT * FROM directory_links WHERE directory_id = $id",
				{ $id: d.id as number },
			)) {
				rows.push(serializeRow("directory_links", dl));
			}
		}
	}
	rows.push(serializeRow("files", f));
	for (const lk of db.all<Row>("SELECT * FROM links WHERE file_id = $id", {
		$id: f.id as number,
	})) {
		rows.push(serializeRow("links", lk));
	}
	return rows;
}

// ── outbound client helpers ────────────────────────────────────────────────

function activePeers(db: Db): Array<{ baseUrl: string; token: string }> {
	return db
		.all<ClusterNodeRow>("SELECT * FROM cluster_nodes WHERE active = 1")
		.filter((n) => n.base_url && n.token)
		.map((n) => ({ baseUrl: n.base_url.replace(/\/$/, ""), token: n.token }));
}

/** Pull the master's canonical snapshot and overwrite local divergence.
 *
 * This is the conflict sledgehammer the announce-id protocol falls back to:
 * after a reservation conflict (or at join time) the node re-derives shared
 * state from the single source of truth. "The master" is resolved via
 * cluster/election.ts's live, epoch-versioned pointer rather than a
 * statically-flagged peer row -- who holds the role can change over the
 * node's lifetime. Returns true on success. */
export async function rebaseFromMaster(state: AppState): Promise<boolean> {
	const master = resolveMaster(state);
	if (!master) {
		log.warning(
			"Rebase-from-master requested, but no current master could be resolved (no cluster node is flagged as master and no live epoch owner was found) -- skipping rebase, local state is left as-is.",
		);
		return false;
	}
	log.info(
		`Rebase-from-master starting: fetching the full canonical row export from master node ${master.baseUrl} ...`,
	);
	let payload: { rows?: SerializedRow[] } | null;
	try {
		payload = (await getJson(
			`${master.baseUrl}/api/cluster/export`,
			master.token,
			30_000,
		)) as { rows?: SerializedRow[] };
	} catch (err) {
		const reason = err instanceof ClusterHTTPError ? err.message : String(err);
		log.warning(
			`Rebase-from-master FAILED: could not fetch the export snapshot from master ${master.baseUrl} (reason: ${reason}). ` +
				`Local rows are unchanged; a later sync/rebase attempt will retry this.`,
		);
		return false;
	}
	const rows = payload?.rows ?? [];
	const byTable = new Map<string, number>();
	for (const row of rows)
		byTable.set(row.table, (byTable.get(row.table) ?? 0) + 1);
	const breakdown = [...byTable.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([table, count]) => `${table}=${count}`)
		.join(", ");
	applyRows(state.db, rows);
	log.info(
		`Rebase-from-master complete: applied ${rows.length} row(s) from master ${master.baseUrl} onto local state` +
			(breakdown
				? ` (breakdown: ${breakdown})`
				: " (export was empty -- nothing to apply)") +
			". Local divergence at these ids has been overwritten with the master's canonical copy.",
	);
	return true;
}

export type ReplicateResult = "ok" | "conflict" | "noop";

/** Announce + replicate a freshly-uploaded file to every peer.
 *
 * Implements the announce-the-id protocol: reserve the file's id with each
 * peer; if any peer already holds a DIFFERENT row at that id, rebase from
 * the master (source of truth) and report a conflict; otherwise push the
 * file's rows to all peers. Best-effort and a no-op without peers, so
 * single-node behaviour is unchanged. */
export async function replicateFile(
	state: AppState,
	fileId: number,
): Promise<ReplicateResult> {
	const peers = activePeers(state.db);
	if (peers.length === 0) {
		log.debug(
			`Replicate file ${fileId}: no active cluster peers configured -- nothing to do, treating as single-node.`,
		);
		return "noop";
	}

	const rows = collectFileRows(state.db, fileId);
	const fileIdentity = localIdentity(state.db, "files", fileId);
	if (rows.length === 0 || fileIdentity === null) {
		log.debug(
			`Replicate file ${fileId}: local row lookup came back empty (file missing or already deleted) -- nothing to replicate.`,
		);
		return "noop";
	}

	log.info(
		`Replicate file ${fileId}: announcing to ${peers.length} peer(s) [${peers.map((p) => p.baseUrl).join(", ")}] ` +
			`with a payload of ${rows.length} row(s) before pushing.`,
	);

	// 1) Announce: reserve the file id on every peer. Each peer fences the
	// request against its own epoch (cluster/election.ts) -- a `stale_epoch`
	// response means WE'RE behind, so adopt the epoch it reports and retry
	// against that same peer once before giving up on it.
	interface ReserveResponse {
		ok?: boolean;
		stale_epoch?: boolean;
		current_epoch?: number;
	}
	for (const peer of peers) {
		let res: ReserveResponse | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			const epoch = getSelfState(state.db).epoch;
			try {
				res = (await postJson(
					`${peer.baseUrl}/api/cluster/reserve`,
					peer.token,
					{ table: "files", id: fileId, identity: fileIdentity, epoch },
					10_000,
				)) as ReserveResponse;
			} catch (err) {
				// Treat an unreachable peer as non-blocking; heartbeat will mark it
				// stale and a later sync/rebase reconciles it.
				log.debug(
					`Reserve file ${fileId} on peer ${peer.baseUrl}: peer is unreachable ` +
						`(${err instanceof Error ? err.message : String(err)}). Skipping this peer for now -- ` +
						"heartbeat will flag it stale and a later sync/rebase will reconcile it once it's back.",
				);
				res = null;
				break;
			}
			if (
				res.stale_epoch &&
				attempt === 0 &&
				typeof res.current_epoch === "number"
			) {
				log.debug(
					`Reserve file ${fileId} on peer ${peer.baseUrl}: peer reports a higher epoch (${res.current_epoch}) than ours ` +
						`(${epoch}), meaning we're the stale side of a past election -- adopting its epoch and retrying the reservation once.`,
				);
				adoptEpochIfHigher(state, res.current_epoch, {});
				continue;
			}
			break;
		}
		if (res === null) continue;
		if (!res.ok) {
			log.warning(
				`Reserve file ${fileId} on peer ${peer.baseUrl}: CONFLICT -- the peer already holds a different row at this id. ` +
					"Falling back to the announce-id protocol's conflict resolution: rebasing this node from the current master " +
					"to discard local divergence, then reporting the upload as conflicted rather than replicated.",
			);
			await rebaseFromMaster(state);
			return "conflict";
		}
	}

	// 2) Replicate: push the rows to every peer.
	let delivered = 0;
	let unreachable = 0;
	for (const peer of peers) {
		try {
			await postJson(
				`${peer.baseUrl}/api/cluster/replicate`,
				peer.token,
				{ rows },
				15_000,
			);
			delivered++;
		} catch (err) {
			unreachable++;
			log.debug(
				`Replicate file ${fileId} to peer ${peer.baseUrl}: peer is unreachable ` +
					`(${err instanceof Error ? err.message : String(err)}). Rows were NOT delivered to this peer; ` +
					"it will catch up via heartbeat-triggered sync once reachable again.",
			);
		}
	}
	log.info(
		`Replicate file ${fileId} complete: delivered ${rows.length} row(s) to ${delivered}/${peers.length} peer(s)` +
			(unreachable > 0
				? ` (${unreachable} peer(s) unreachable, will reconcile later)`
				: "") +
			".",
	);
	return "ok";
}
