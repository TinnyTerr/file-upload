import { createSqliteDb } from "./sqlite.ts";
import type { Db } from "./types.ts";

/**
 * Picks a Db adapter by URL scheme. Only sqlite: is wired up today;
 * a future adapter (e.g. Postgres) implements the same Db interface
 * in its own file and gets added as another case here.
 */
export function createDb(databaseUrl: string): Db {
	// sqlite:///./data/app.db -> relative path "./data/app.db"
	// sqlite:////abs/path.db  -> absolute path "/abs/path.db"
	// sqlite://:memory:       -> in-memory
	if (databaseUrl.startsWith("sqlite:////")) {
		// sqlite:////abs/path.db -> "/abs/path.db"
		return createSqliteDb(databaseUrl.slice("sqlite:///".length));
	}
	if (databaseUrl.startsWith("sqlite:///")) {
		// sqlite:///./data/app.db -> "./data/app.db"
		const rest = databaseUrl.slice("sqlite:///".length);
		return createSqliteDb(
			rest === "" || rest === ":memory:" ? ":memory:" : rest,
		);
	}
	throw new Error(`Unsupported DATABASE_URL scheme: ${databaseUrl}`);
}

export type { Db, Row, SqlParams } from "./types.ts";
