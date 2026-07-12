import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
