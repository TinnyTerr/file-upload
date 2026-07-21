import type { Database } from "bun:sqlite";

interface ColumnInfoRow {
  name: string;
}

/** Adds a column to an existing table if it isn't already there. schema.sql
 * only runs CREATE TABLE IF NOT EXISTS, so columns added to a table that a
 * prior run already created need this instead (CLAUDE.md: no migrations,
 * additive columns only). */
export function ensureColumn(sqlite: Database, table: string, column: string, ddl: string): void {
  const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as ColumnInfoRow[];
  if (columns.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
