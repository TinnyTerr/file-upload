import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import {
	type FileRow,
	nowIso,
	type PermissionRow,
	type UserRow,
} from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireMaster } from "../middleware/deps.ts";
import {
	BOOL_FLAGS,
	ensurePermissions,
	type PermissionFlag,
} from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import { hashPassword } from "../security/passwords.ts";
import {
	allocatedQuotaBytes,
	allocatedQuotaBytesWithOverride,
	ensureStorageSettings,
	usedStorageBytesForUser,
	validateAllocatedQuotaCapacity,
} from "../storage/accounting.ts";
import { releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";

const log = getLogger("app.routes.users");

interface CountRow {
	n: number;
}
interface IdRow {
	id: number;
}

const MASTER_ALL_TRUE: PermissionFlag[] = [
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
	"can_use_torrents",
	"can_manage_cluster",
];

function serializePermissions(perm: PermissionRow) {
	const out: Record<string, unknown> = {};
	for (const flag of BOOL_FLAGS) out[flag] = !!perm[flag];
	out.quota_bytes = perm.quota_bytes;
	out.max_file_bytes = perm.max_file_bytes;
	return out;
}

function masterCount(db: AppState["db"]): number {
	return db.get<CountRow>(
		"SELECT COUNT(*) as n FROM users WHERE role = 'master'",
	)!.n;
}

/** Mirrors app/routes/users.py -- admin CRUD for user accounts + permissions. */
export function usersRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.get("/", requireMaster(state), (_req, res) => {
		const users = db.all<UserRow>(
			"SELECT * FROM users ORDER BY created_at ASC",
		);
		res.json({
			users: users.map((u) => {
				const perm = db.get<PermissionRow>(
					"SELECT * FROM permissions WHERE user_id = $id",
					{ $id: u.id },
				);
				const mfaCount = db.get<CountRow>(
					"SELECT COUNT(*) as n FROM credentials WHERE user_id = $id",
					{ $id: u.id },
				)!.n;
				return {
					id: u.id,
					username: u.username,
					role: u.role,
					has_avatar: u.avatar_data !== null,
					must_change_credentials: !!u.must_change_credentials,
					mfa_required: !!u.mfa_required,
					mfa_enrolled: mfaCount > 0,
					created_at: u.created_at,
					permissions: perm ? serializePermissions(perm) : null,
				};
			}),
		});
	});

	router.post(
		"/",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		asyncHandler(async (req, res) => {
			const master = req.currentUser!;
			const body = req.body ?? {};
			const username = String(body.username ?? "");
			const password = String(body.password ?? "");
			const role = String(body.role ?? "user");

			if (password.length < 12) {
				res
					.status(400)
					.json({ detail: "password must be at least 12 characters" });
				return;
			}
			if (role !== "user" && role !== "master") {
				res.status(400).json({ detail: "role must be 'user' or 'master'" });
				return;
			}
			if (
				db.get<UserRow>("SELECT * FROM users WHERE username = $u", {
					$u: username,
				})
			) {
				res.status(409).json({ detail: "username taken" });
				return;
			}

			try {
				// Hash before the insert so the row never exists with an empty
				// password_hash -- Bun.password.verify("", ...) throws rather than
				// returning false, which used to let a half-created row hang a login.
				const passwordHash = await hashPassword(password);
				db.transaction(() => {
					db.run(
						`INSERT INTO users (username, password_hash, role, must_change_credentials, created_at)
           VALUES ($u, $hash, $role, 0, $now)`,
						{ $u: username, $hash: passwordHash, $role: role, $now: nowIso() },
					);
				});
				const user = db.get<UserRow>(
					"SELECT * FROM users WHERE username = $u",
					{ $u: username },
				)!;

				const perm = ensurePermissions(db, user.id, {
					master: role === "master",
				});
				const updates: Partial<Record<PermissionFlag, boolean>> = {
					can_upload: body.can_upload !== undefined ? !!body.can_upload : true,
				};
				for (const flag of BOOL_FLAGS) {
					if (body[flag] !== undefined) updates[flag] = !!body[flag];
				}
				if (role === "master") {
					for (const flag of MASTER_ALL_TRUE) updates[flag] = true;
				}
				const setCols = Object.keys(updates);
				if (setCols.length) {
					db.run(
						`UPDATE permissions SET ${setCols.map((c) => `${c} = $${c}`).join(", ")} WHERE user_id = $userId`,
						{
							...Object.fromEntries(
								setCols.map((c) => [
									`$${c}`,
									updates[c as PermissionFlag] ? 1 : 0,
								]),
							),
							$userId: user.id,
						},
					);
				}
				if (body.quota_bytes !== undefined) {
					db.run(
						"UPDATE permissions SET quota_bytes = $q WHERE user_id = $userId",
						{
							$q: Number(body.quota_bytes),
							$userId: user.id,
						},
					);
				}
				if (body.max_file_bytes !== undefined) {
					db.run(
						"UPDATE permissions SET max_file_bytes = $m WHERE user_id = $userId",
						{
							$m: Number(body.max_file_bytes),
							$userId: user.id,
						},
					);
				}

				const settings = ensureStorageSettings(db);
				if (allocatedQuotaBytes(db) > settings.global_storage_quota_bytes) {
					db.run("DELETE FROM permissions WHERE user_id = $id", {
						$id: user.id,
					});
					db.run("DELETE FROM users WHERE id = $id", { $id: user.id });
					res.status(400).json({
						detail: "user quotas would exceed global storage allocation",
					});
					return;
				}
				if (body.quota_bytes !== undefined) {
					validateAllocatedQuotaCapacity(allocatedQuotaBytes(db));
				}

				recordAudit(db, {
					actor: master.username,
					action: "user.created",
					target: `user:${user.id}`,
					ip: clientIp(state, req),
				});
				log.info(
					`admin user created target_user_id=${user.id} role=${user.role} actor_id=${master.id}`,
				);
				res.json({ id: user.id, username: user.username, role: user.role });
			} catch (err) {
				if (!res.headersSent) {
					res.status(err instanceof HttpError ? err.status : 500).json({
						detail:
							err instanceof HttpError ? err.detail : "internal server error",
					});
				}
			}
		}),
	);

	router.patch(
		"/:userId",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		asyncHandler(async (req, res) => {
			const master = req.currentUser!;
			const userId = Number(req.params.userId);
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: userId,
			});
			if (!user) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			const body = req.body ?? {};

			try {
				if (body.username !== undefined) {
					const username = String(body.username ?? "").trim();
					if (!username) {
						res.status(400).json({ detail: "username is required" });
						return;
					}
					const existing = db.get<UserRow>(
						"SELECT * FROM users WHERE username = $u",
						{ $u: username },
					);
					if (existing && existing.id !== user.id) {
						res.status(409).json({ detail: "username taken" });
						return;
					}
					db.run("UPDATE users SET username = $u WHERE id = $id", {
						$u: username,
						$id: user.id,
					});
					log.info(
						`admin user rename target_user_id=${user.id} actor_id=${master.id}`,
					);
				}

				if (body.password !== undefined && body.password !== null) {
					const password = String(body.password);
					if (password.length < 12) {
						res
							.status(400)
							.json({ detail: "password must be at least 12 characters" });
						return;
					}
					const hash = await hashPassword(password);
					db.run("UPDATE users SET password_hash = $h WHERE id = $id", {
						$h: hash,
						$id: user.id,
					});
					db.run("DELETE FROM sessions WHERE user_id = $id", { $id: user.id });
					log.warning(
						`admin password reset target_user_id=${user.id} actor_id=${master.id} sessions_revoked=true`,
					);
				}

				if (body.role !== undefined && body.role !== null) {
					const role = String(body.role);
					if (role !== "user" && role !== "master") {
						res.status(400).json({ detail: "role must be 'user' or 'master'" });
						return;
					}
					if (
						user.role === "master" &&
						role !== "master" &&
						masterCount(db) <= 1
					) {
						res.status(400).json({ detail: "cannot demote the last master" });
						return;
					}
					db.run("UPDATE users SET role = $r WHERE id = $id", {
						$r: role,
						$id: user.id,
					});
					log.warning(
						`admin role changed target_user_id=${user.id} role=${role} actor_id=${master.id}`,
					);
					const perm = ensurePermissions(db, user.id, {
						master: role === "master",
					});
					if (role === "master") {
						db.run(
							`UPDATE permissions SET ${MASTER_ALL_TRUE.map((c) => `${c} = 1`).join(", ")} WHERE user_id = $id`,
							{
								$id: perm.user_id,
							},
						);
					}
				}

				if (body.mfa_required !== undefined) {
					db.run("UPDATE users SET mfa_required = $v WHERE id = $id", {
						$v: body.mfa_required ? 1 : 0,
						$id: user.id,
					});
					recordAudit(db, {
						actor: master.username,
						action: "admin.mfa_required_changed",
						target: `user:${userId}`,
						ip: clientIp(state, req),
					});
				}

				recordAudit(db, {
					actor: master.username,
					action: "user.updated",
					target: `user:${userId}`,
					ip: clientIp(state, req),
				});
				const updated = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
					$id: userId,
				})!;
				res.json({
					id: updated.id,
					username: updated.username,
					role: updated.role,
					mfa_required: !!updated.mfa_required,
				});
			} catch (err) {
				if (!res.headersSent) {
					res.status(err instanceof HttpError ? err.status : 500).json({
						detail:
							err instanceof HttpError ? err.detail : "internal server error",
					});
				}
			}
		}),
	);

	router.delete(
		"/:userId",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(req, res) => {
			const master = req.currentUser!;
			const userId = Number(req.params.userId);
			if (userId === master.id) {
				res.status(400).json({ detail: "cannot delete yourself" });
				return;
			}
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: userId,
			});
			if (!user) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			if (user.role === "master" && masterCount(db) <= 1) {
				res.status(400).json({ detail: "cannot delete the last master" });
				return;
			}

			const unlinkAfterCommit: Array<string | null> = [];
			let fileCount = 0;
			let dirCount = 0;

			db.transaction(() => {
				const dirIds = db
					.all<IdRow>("SELECT id FROM directories WHERE owner_id = $id", {
						$id: userId,
					})
					.map((r) => r.id);
				const files = db.all<FileRow>(
					"SELECT * FROM files WHERE owner_id = $id",
					{ $id: userId },
				);
				if (dirIds.length) {
					for (const dirId of dirIds) {
						files.push(
							...db.all<FileRow>(
								"SELECT * FROM files WHERE directory_id = $id",
								{ $id: dirId },
							),
						);
					}
				}
				const uniqueFiles = [...new Map(files.map((f) => [f.id, f])).values()];
				fileCount = uniqueFiles.length;
				dirCount = dirIds.length;

				if (uniqueFiles.length) {
					for (const f of uniqueFiles) {
						db.run(
							"UPDATE files SET saved_from_file_id = NULL WHERE saved_from_file_id = $id",
							{ $id: f.id },
						);
						db.run(
							"UPDATE remote_upload_jobs SET file_id = NULL WHERE file_id = $id",
							{ $id: f.id },
						);
					}
				}
				db.run(
					"UPDATE directory_collaborators SET invited_by_id = NULL WHERE invited_by_id = $id",
					{ $id: userId },
				);

				for (const f of uniqueFiles) {
					db.run("DELETE FROM links WHERE file_id = $id", { $id: f.id });
					unlinkAfterCommit.push(releaseBlob(db, f));
					deleteThumbnail(f.id);
					db.run("DELETE FROM files WHERE id = $id", { $id: f.id });
				}

				if (dirIds.length) {
					for (const dirId of dirIds) {
						db.run(
							"DELETE FROM dropbox_upload_links WHERE target_directory_id = $id",
							{ $id: dirId },
						);
						db.run(
							"DELETE FROM directory_collaborators WHERE directory_id = $id",
							{ $id: dirId },
						);
					}
				}
				for (const dirId of dirIds) {
					db.run("DELETE FROM directories WHERE id = $id", { $id: dirId });
				}
				db.run("DELETE FROM directory_collaborators WHERE user_id = $id", {
					$id: userId,
				});
				db.run("DELETE FROM dropbox_upload_links WHERE owner_id = $id", {
					$id: userId,
				});
				db.run("DELETE FROM remote_upload_jobs WHERE owner_id = $id", {
					$id: userId,
				});
				db.run("DELETE FROM api_keys WHERE owner_id = $id", { $id: userId });
				db.run("DELETE FROM sessions WHERE user_id = $id", { $id: userId });
				db.run("DELETE FROM permissions WHERE user_id = $id", { $id: userId });
				// PRAGMA foreign_keys = ON means any of these referencing the user
				// would otherwise throw on the DELETE FROM users below.
				db.run("DELETE FROM credentials WHERE user_id = $id", { $id: userId });
				db.run("DELETE FROM torrent_jobs WHERE owner_id = $id", {
					$id: userId,
				});
				db.run(
					"UPDATE cluster_nodes SET created_by_id = NULL WHERE created_by_id = $id",
					{ $id: userId },
				);

				recordAudit(db, {
					actor: master.username,
					action: "user.deleted",
					target: `user:${userId}`,
					ip: clientIp(state, req),
				});
				log.warning(
					`admin user deleted target_user_id=${userId} actor_id=${master.id} files_removed=${fileCount} directories_removed=${dirCount}`,
				);
				db.run("DELETE FROM users WHERE id = $id", { $id: userId });
			});

			unlinkQueued(unlinkAfterCommit);
			res.json({ status: "deleted" });
		},
	);

	router.post(
		"/:userId/permissions",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(req, res) => {
			const master = req.currentUser!;
			const userId = Number(req.params.userId);
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: userId,
			});
			if (!user) {
				res.status(404).json({ detail: "not found" });
				return;
			}
			ensurePermissions(db, userId, { master: user.role === "master" });
			const body = req.body ?? {};

			try {
				if (body.quota_bytes !== undefined) {
					const quotaBytes = Number(body.quota_bytes);
					const used = usedStorageBytesForUser(db, userId);
					if (quotaBytes < used) {
						res
							.status(400)
							.json({ detail: "quota cannot be below current user storage" });
						return;
					}
					const settings = ensureStorageSettings(db);
					const allocated = allocatedQuotaBytesWithOverride(db, {
						userId,
						quotaBytes,
					});
					if (allocated > settings.global_storage_quota_bytes) {
						res.status(400).json({
							detail: "user quotas would exceed global storage allocation",
						});
						return;
					}
					validateAllocatedQuotaCapacity(allocated);
					db.run(
						"UPDATE permissions SET quota_bytes = $q WHERE user_id = $id",
						{ $q: quotaBytes, $id: userId },
					);
				}

				const fields = BOOL_FLAGS.filter((f) => body[f] !== undefined);
				if (fields.length) {
					db.run(
						`UPDATE permissions SET ${fields.map((f) => `${f} = $${f}`).join(", ")} WHERE user_id = $userId`,
						{
							...Object.fromEntries(
								fields.map((f) => [`$${f}`, body[f] ? 1 : 0]),
							),
							$userId: userId,
						},
					);
				}
				if (body.max_file_bytes !== undefined) {
					db.run(
						"UPDATE permissions SET max_file_bytes = $m WHERE user_id = $id",
						{
							$m: Number(body.max_file_bytes),
							$id: userId,
						},
					);
				}
			} catch (err) {
				if (err instanceof HttpError) {
					res.status(err.status).json({ detail: err.detail });
					return;
				}
				throw err;
			}

			const changedFields = [
				...(body.quota_bytes !== undefined ? ["quota_bytes"] : []),
				...BOOL_FLAGS.filter((f) => body[f] !== undefined),
			];
			recordAudit(db, {
				actor: master.username,
				action: "permissions.updated",
				target: `user:${userId}`,
				ip: clientIp(state, req),
			});
			log.info(
				`admin permissions updated target_user_id=${userId} actor_id=${master.id} fields=${JSON.stringify(changedFields.sort())}`,
			);
			res.json({ status: "updated" });
		},
	);

	return router;
}
