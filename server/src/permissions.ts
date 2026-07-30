import { nowIso, type PermissionRow } from "./db/rows.ts";
import type { Db } from "./db/types.ts";

/** Mirrors app/permissions/policy.py. */

export const BOOL_FLAGS = [
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
] as const;

export type PermissionFlag = (typeof BOOL_FLAGS)[number];

export function getPermissions(
	db: Db,
	userId: number,
): PermissionRow | undefined {
	return db.get<PermissionRow>(
		"SELECT * FROM permissions WHERE user_id = $userId",
		{ $userId: userId },
	);
}

export function ensurePermissions(
	db: Db,
	userId: number,
	opts: { master?: boolean } = {},
): PermissionRow {
	const existing = getPermissions(db, userId);
	if (existing) return existing;
	if (opts.master) {
		db.run(
			`INSERT INTO permissions (
         user_id, can_upload, can_upload_client_encrypted, can_delete, can_regenerate_links,
         can_delete_links, can_create_directories, can_manage_lifecycle, can_use_api_keys,
         can_view_admin, can_manage_users, can_manage_storage, can_manage_api_keys, can_manage_cluster,
         can_use_torrents, can_watch_media, created_at
       ) VALUES ($userId, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, $createdAt)`,
			{ $userId: userId, $createdAt: nowIso() },
		);
	} else {
		db.run(
			"INSERT INTO permissions (user_id, created_at) VALUES ($userId, $createdAt)",
			{
				$userId: userId,
				$createdAt: nowIso(),
			},
		);
	}
	return getPermissions(db, userId)!;
}

export function hasPermission(perm: PermissionRow, name: string): boolean {
	if (!(BOOL_FLAGS as readonly string[]).includes(name)) {
		throw new Error(`unknown permission flag: ${name}`);
	}
	return !!perm[name as PermissionFlag];
}
