import { nowIso, type PermissionRow, type UserRow } from "./db/rows.ts";
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
	// Account-hardening *restrictions*, not capabilities: they take things away
	// rather than granting them, which is why they are deliberately absent from
	// the master seed inserts and from MASTER_ALL_TRUE in routes/users.ts --
	// force-setting them on every master would lock every admin out of their own
	// deployment the moment this column lands.
	"require_mfa",
	"require_passkey",
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

interface CountRow {
	n: number;
}

/** Whether this account must complete a second factor at login. Masters are
 * enforced by role (pre-existing behavior), everyone else by the per-user
 * `users.mfa_required` column or either hardening flag -- `require_passkey`
 * implies `require_mfa`, it only narrows which factor is acceptable. */
export function mfaEnforcedFor(db: Db, user: UserRow): boolean {
	if (user.role === "master" || user.mfa_required) return true;
	const perm = ensurePermissions(db, user.id, {
		master: user.role === "master",
	});
	return !!perm.require_mfa || !!perm.require_passkey;
}

/** Whether `require_passkey` narrows this account's second factor to WebAuthn.
 * Masters are not special-cased here: their enforcement comes from the role,
 * which has never restricted *which* factor is acceptable. */
export function passkeyEnforcedFor(db: Db, user: UserRow): boolean {
	const perm = ensurePermissions(db, user.id, {
		master: user.role === "master",
	});
	return !!perm.require_passkey;
}

/** The credential this account is required to hold but doesn't, or null when
 * it is compliant. `require_passkey` is checked first because it is the
 * stricter of the two -- a user holding only TOTP still fails it. */
export function missingRequiredCredential(
	db: Db,
	user: UserRow,
): "passkey" | "mfa" | null {
	const perm = ensurePermissions(db, user.id, {
		master: user.role === "master",
	});
	if (perm.require_passkey) {
		const n = db.get<CountRow>(
			"SELECT COUNT(*) as n FROM credentials WHERE user_id = $id AND kind = 'webauthn'",
			{ $id: user.id },
		)!.n;
		if (n === 0) return "passkey";
	}
	if (perm.require_mfa) {
		const n = db.get<CountRow>(
			"SELECT COUNT(*) as n FROM credentials WHERE user_id = $id",
			{ $id: user.id },
		)!.n;
		if (n === 0) return "mfa";
	}
	return null;
}

export function hasPermission(perm: PermissionRow, name: string): boolean {
	if (!(BOOL_FLAGS as readonly string[]).includes(name)) {
		throw new Error(`unknown permission flag: ${name}`);
	}
	return !!perm[name as PermissionFlag];
}
