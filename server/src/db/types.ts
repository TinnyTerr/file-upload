export type SqlParams = Record<
	string,
	string | number | bigint | boolean | null | Buffer
>;

export interface Row {
	[column: string]: unknown;
}

/**
 * Engine-agnostic DB contract. bun:sqlite is the only adapter today
 * (see sqlite.ts); a future Postgres/other adapter just implements
 * this same interface and gets picked up by createDb() in index.ts.
 */
export interface Db {
	run(sql: string, params?: SqlParams): void;
	get<T = Row>(sql: string, params?: SqlParams): T | undefined;
	all<T = Row>(sql: string, params?: SqlParams): T[];
	transaction<T>(fn: () => T): T;
	close(): void;
}
