import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureColumn } from "./backfill.ts";
import type { Db, Row, SqlParams } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

	const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
	sqlite.exec(schema);

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
	// Existing torrent jobs predate Real-Debrid, so they are qBittorrent jobs.
	ensureColumn(
		sqlite,
		"torrent_jobs",
		"provider",
		"provider TEXT NOT NULL DEFAULT 'qbittorrent'",
	);
	ensureColumn(sqlite, "torrent_jobs", "debrid_id", "debrid_id TEXT");
	ensureColumn(sqlite, "torrent_jobs", "debrid_status", "debrid_status TEXT");
	ensureColumn(
		sqlite,
		"torrent_jobs",
		"fallback_reason",
		"fallback_reason TEXT",
	);

	return {
		run(sql: string, params: SqlParams = {}) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			sqlite.query(sql).run(params as any);
		},
		get<T = Row>(sql: string, params: SqlParams = {}) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return sqlite.query(sql).get(params as any) as T | undefined;
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
