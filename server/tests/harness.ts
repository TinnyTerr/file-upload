/**
 * In-process test harness: a real Express app over an in-memory database.
 *
 * Everything is wired the way index.ts wires it, minus the listener, the
 * scheduler and the cluster — routes are exercised through `createApp`, so a
 * test failure means the route is wrong rather than the stub being wrong.
 */

import { randomBytes } from "node:crypto";
import type { Express } from "express";
import { createApp } from "../src/app.ts";
import { createAppState } from "../src/appState.ts";
import type { Settings } from "../src/config.ts";
import { nowIso, type UserRow } from "../src/db/rows.ts";
import { createSqliteDb } from "../src/db/sqlite.ts";
import type { Db } from "../src/db/types.ts";
import { ensurePermissions } from "../src/permissions.ts";
import { hashPassword } from "../src/security/passwords.ts";

export function testSettings(overrides: Partial<Settings> = {}): Settings {
	return {
		appEnv: "dev",
		databaseUrl: "sqlite://:memory:",
		secretKey: randomBytes(32).toString("hex"),
		masterKeyB64: randomBytes(32).toString("base64"),
		configPath: "/dev/null",
		trustProxy: false,
		trustProxyMode: "off",
		allowedHosts: "",
		clusterToken: "",
		nodeId: "test-node",
		nodeName: "test",
		nodeRole: "master",
		nodeUrl: "",
		masterUrl: "",
		masterToken: "",
		archiveEnabled: false,
		replicationMode: "full",
		cacheMaxBytes: 0,
		qbittorrentUrl: "",
		qbittorrentUsername: "",
		qbittorrentPassword: "",
		qbittorrentSavePath: "",
		torrentContentPath: "",
		realDebridApiKey: "",
		realDebridEnabled: false,
		...overrides,
	};
}

export interface Harness {
	app: Express;
	db: Db;
	state: ReturnType<typeof createAppState>;
	/** Signs a user in without going through the login ceremony. */
	signIn(user: UserRow): { cookie: string; csrf: string };
	/** fetch-alike bound to the app, over a real ephemeral port. */
	request(
		path: string,
		init?: RequestInit & { cookie?: string; csrf?: string },
	): Promise<Response>;
	close(): void;
}

export async function makeHarness(
	settingsOverrides: Partial<Settings> = {},
): Promise<Harness> {
	const settings = testSettings(settingsOverrides);
	const db = createSqliteDb(":memory:");
	const state = createAppState(settings, db);
	const app = createApp(state);
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const base = `http://127.0.0.1:${port}`;

	return {
		app,
		db,
		state,
		signIn(user) {
			const { cookieValue, csrfToken } = state.sessionManager.create(
				db,
				user.id,
				{ ip: "127.0.0.1", userAgent: "test" },
			);
			return { cookie: `fu_session=${cookieValue}`, csrf: csrfToken };
		},
		async request(path, init = {}) {
			const { cookie, csrf, headers, ...rest } = init;
			const h = new Headers(headers);
			if (cookie) h.set("cookie", cookie);
			if (csrf) h.set("x-csrf-token", csrf);
			return fetch(`${base}${path}`, { ...rest, headers: h });
		},
		close() {
			server.close();
			db.close();
		},
	};
}

/** Creates an active (not must_change_credentials) user with all permissions
 * a plain `user` can hold, so tests exercise routes rather than the gate. */
export async function makeUser(
	db: Db,
	username: string,
	role: "master" | "user" = "user",
): Promise<UserRow> {
	db.run(
		`INSERT INTO users (username, password_hash, role, must_change_credentials, created_at)
     VALUES ($username, $hash, $role, 0, $now)`,
		{
			$username: username,
			$hash: await hashPassword("correct horse battery staple"),
			$role: role,
			$now: nowIso(),
		},
	);
	const user = db.get<UserRow>("SELECT * FROM users WHERE username = $u", {
		$u: username,
	})!;
	ensurePermissions(db, user.id, { master: role === "master" });
	return user;
}

/** Inserts a folder directly, bypassing the create route's key ceremony. */
export function makeDirectory(
	db: Db,
	opts: {
		ownerId: number;
		title: string;
		parentId?: number | null;
	},
): number {
	db.run(
		`INSERT INTO directories (owner_id, title, slug, parent_directory_id, encryption_mode,
       encryption_overridden, created_at)
     VALUES ($owner, $title, $slug, $parent, 'none', $overridden, $now)`,
		{
			$owner: opts.ownerId,
			$title: opts.title,
			$slug: randomBytes(4).toString("hex"),
			$parent: opts.parentId ?? null,
			// A root folder is always a break point; a nested one inherits.
			$overridden: opts.parentId ? 0 : 1,
			$now: nowIso(),
		},
	);
	return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}

/** Inserts a file row directly. No bytes are written — these tests are about
 * listing and filtering, not storage. */
export function makeFile(
	db: Db,
	opts: { ownerId: number; name: string; directoryId?: number | null },
): number {
	db.run(
		`INSERT INTO files (owner_id, directory_id, storage_path, original_filename,
       source_type, size_bytes, stored_size_bytes, content_type, encryption_mode,
       encryption_overridden, created_at)
     VALUES ($owner, $dir, $path, $name, 'upload', 0, 0, 'text/plain', 'none', 0, $now)`,
		{
			$owner: opts.ownerId,
			$dir: opts.directoryId ?? null,
			$path: `ab/cd/${randomBytes(8).toString("hex")}`,
			$name: opts.name,
			$now: nowIso(),
		},
	);
	return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}
