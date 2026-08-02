import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureColumn } from "./backfill.ts";
import type { Db, Row, SqlParams } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Strips `--` line comments. Comments are dropped before statement splitting
 * because schema.sql's prose contains semicolons, which would otherwise look
 * like statement terminators. A `--` inside a string literal is left alone. */
function stripSqlComments(schema: string): string {
	return schema
		.split("\n")
		.map((line) => {
			const at = line.indexOf("--");
			if (at === -1) return line;
			// Odd quote count before the marker means we're inside a literal.
			const quotes = (line.slice(0, at).match(/'/g) ?? []).length;
			return quotes % 2 === 1 ? line : line.slice(0, at);
		})
		.join("\n");
}

/** Partitions schema.sql into its CREATE INDEX statements and everything else,
 * so the two halves can straddle the ensureColumn backfills. Splitting on `;`
 * is sound here because schema.sql holds only CREATE TABLE/INDEX statements --
 * no triggers, and no string literal containing a semicolon. */
function splitSchema(schema: string): { tables: string; indexes: string } {
	const tables: string[] = [];
	const indexes: string[] = [];
	for (const raw of stripSqlComments(schema).split(";")) {
		const statement = raw.trim();
		if (!statement) continue;
		const isIndex = /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement);
		(isIndex ? indexes : tables).push(`${statement};`);
	}
	return { tables: tables.join("\n"), indexes: indexes.join("\n") };
}

/** bun:sqlite adapter -- the default/only Db implementation for now. */
export function createSqliteDb(path: string): Db {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
	const sqlite = new Database(path, { create: true });
	sqlite.exec("PRAGMA foreign_keys = ON;");
	if (path !== ":memory:") {
		sqlite.exec("PRAGMA journal_mode = WAL;");
	}

	// Tables first, then the additive column backfills, then indexes. An index
	// declared over a column that only exists via ensureColumn (e.g.
	// ix_directories_is_library) would throw "no such column" on a database a
	// previous version already created, because CREATE TABLE IF NOT EXISTS is a
	// no-op there and the column only lands in the backfill pass below.
	const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
	const { tables, indexes } = splitSchema(schema);
	sqlite.exec(tables);

	ensureColumn(
		sqlite,
		"users",
		"mfa_required",
		"mfa_required INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"users",
		"webauthn_user_handle",
		"webauthn_user_handle TEXT",
	);
	// Cloudflare CF-IPCountry, recorded at login. See middleware/auth.ts.
	ensureColumn(sqlite, "sessions", "country_code", "country_code TEXT");
	ensureColumn(sqlite, "credentials", "updated_at", "updated_at TEXT");
	ensureColumn(sqlite, "credentials", "transports", "transports TEXT");
	ensureColumn(
		sqlite,
		"cluster_nodes",
		"role",
		"role TEXT NOT NULL DEFAULT 'follower'",
	);
	ensureColumn(
		sqlite,
		"cluster_nodes",
		"epoch",
		"epoch INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"content_blobs",
		"archived",
		"archived INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"permissions",
		"can_use_torrents",
		"can_use_torrents INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"permissions",
		"can_watch_media",
		"can_watch_media INTEGER NOT NULL DEFAULT 0",
	);
	// Account-hardening flags -- off for every pre-existing account, so nobody
	// gets locked out of a running deployment by an upgrade.
	ensureColumn(
		sqlite,
		"permissions",
		"require_mfa",
		"require_mfa INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"permissions",
		"require_passkey",
		"require_passkey INTEGER NOT NULL DEFAULT 0",
	);
	// Directory nesting + encryption inheritance. Every pre-existing row is its
	// own break point (`encryption_overridden = 1`), which is not merely safe but
	// exactly right: the old model had no inheritance at all, so the resolver
	// degrades to today's behavior for all pre-existing data.
	ensureColumn(
		sqlite,
		"directories",
		"parent_directory_id",
		"parent_directory_id INTEGER REFERENCES directories(id)",
	);
	ensureColumn(
		sqlite,
		"directories",
		"encryption_overridden",
		"encryption_overridden INTEGER NOT NULL DEFAULT 1",
	);
	ensureColumn(
		sqlite,
		"files",
		"encryption_overridden",
		"encryption_overridden INTEGER NOT NULL DEFAULT 1",
	);
	// Password-locked access secrets. Every pre-existing `?ek=` is a random
	// high-entropy token, which is exactly what the 0 default says.
	ensureColumn(
		sqlite,
		"directories",
		"access_is_password",
		"access_is_password INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"files",
		"access_is_password",
		"access_is_password INTEGER NOT NULL DEFAULT 0",
	);
	// Seal & Forget: only set on password-sealed files, so NULL is right for
	// every row that predates it.
	ensureColumn(sqlite, "files", "seal_salt", "seal_salt BLOB");
	// Media library publication -- folders that predate it are unpublished.
	ensureColumn(
		sqlite,
		"directories",
		"is_library",
		"is_library INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		sqlite,
		"directories",
		"library_visibility",
		"library_visibility TEXT NOT NULL DEFAULT 'restricted'",
	);
	ensureColumn(
		sqlite,
		"directories",
		"library_kind",
		"library_kind TEXT NOT NULL DEFAULT 'series'",
	);
	ensureColumn(
		sqlite,
		"directories",
		"library_overview",
		"library_overview TEXT",
	);
	ensureColumn(
		sqlite,
		"directories",
		"library_poster_file_id",
		"library_poster_file_id INTEGER",
	);
	ensureColumn(
		sqlite,
		"directories",
		"library_published_at",
		"library_published_at TEXT",
	);
	// Gallery presentation of the public folder page. Folders that predate it
	// keep the plain list they have always rendered as.
	ensureColumn(
		sqlite,
		"directories",
		"gallery_view",
		"gallery_view INTEGER NOT NULL DEFAULT 0",
	);
	// Existing torrent jobs predate Real-Debrid, so they are qBittorrent jobs.
	ensureColumn(
		sqlite,
		"torrent_jobs",
		"provider",
		"provider TEXT NOT NULL DEFAULT 'qbittorrent'",
	);
	// Destination folder. Jobs that predate it landed at the root, which is
	// what NULL means. `ON DELETE SET NULL` has to be spelled out here as well
	// as in schema.sql: an ALTER TABLE column carries only the constraints it
	// declares, and without it deleting a folder that a queued torrent points
	// at would throw a foreign-key violation on an upgraded database.
	ensureColumn(
		sqlite,
		"torrent_jobs",
		"target_directory_id",
		"target_directory_id INTEGER REFERENCES directories(id) ON DELETE SET NULL",
	);
	ensureColumn(sqlite, "torrent_jobs", "debrid_id", "debrid_id TEXT");
	ensureColumn(sqlite, "torrent_jobs", "debrid_status", "debrid_status TEXT");
	ensureColumn(
		sqlite,
		"torrent_jobs",
		"fallback_reason",
		"fallback_reason TEXT",
	);

	sqlite.exec(indexes);

	return {
		run(sql: string, params: SqlParams = {}) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			sqlite.query(sql).run(params as any);
		},
		get<T = Row>(sql: string, params: SqlParams = {}) {
			// bun:sqlite returns null for a miss, but the Db contract says
			// `T | undefined` -- normalize, or a caller testing `=== undefined`
			// silently never matches a genuine miss.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const row = sqlite.query(sql).get(params as any) as T | null;
			return row ?? undefined;
		},
		all<T = Row>(sql: string, params: SqlParams = {}) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return sqlite.query(sql).all(params as any) as T[];
		},
		transaction<T>(fn: () => T): T {
			return sqlite.transaction(fn)();
		},
		close() {
			sqlite.close();
		},
	};
}
