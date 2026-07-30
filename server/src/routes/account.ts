import busboy from "busboy";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import type { FileRow, UserRow } from "../db/rows.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireActiveUser } from "../middleware/deps.ts";
import { ensurePermissions } from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";
import { releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";

interface SumRow {
	total: number | null;
}
interface IdRow {
	id: number;
}

const ALLOWED_AVATAR_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

function sniffImageType(data: Buffer): string {
	if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
		return "image/jpeg";
	if (
		data
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	)
		return "image/png";
	const gifHeader = data.subarray(0, 6).toString("ascii");
	if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
	if (
		data.subarray(0, 4).toString("ascii") === "RIFF" &&
		data.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return "application/octet-stream";
}

/** Purges every file, directory, link, and API key owned by userId. Returns
 * physical paths to unlink after the surrounding transaction commits.
 * Mirrors app/routes/account.py::_purge_user_data. */
function purgeUserData(state: AppState, userId: number): Array<string | null> {
	const { db } = state;
	const paths: Array<string | null> = [];

	const dirIds = db
		.all<IdRow>("SELECT id FROM directories WHERE owner_id = $id", {
			$id: userId,
		})
		.map((r) => r.id);
	const files = db.all<FileRow>("SELECT * FROM files WHERE owner_id = $id", {
		$id: userId,
	});
	for (const dirId of dirIds) {
		files.push(
			...db.all<FileRow>("SELECT * FROM files WHERE directory_id = $id", {
				$id: dirId,
			}),
		);
	}
	const uniqueFiles = [...new Map(files.map((f) => [f.id, f])).values()];

	for (const f of uniqueFiles) {
		db.run(
			"UPDATE files SET saved_from_file_id = NULL WHERE saved_from_file_id = $id",
			{ $id: f.id },
		);
		db.run("UPDATE remote_upload_jobs SET file_id = NULL WHERE file_id = $id", {
			$id: f.id,
		});
		db.run("DELETE FROM links WHERE file_id = $id", { $id: f.id });
	}
	for (const f of uniqueFiles) {
		paths.push(releaseBlob(db, f));
		deleteThumbnail(f.id);
		db.run("DELETE FROM files WHERE id = $id", { $id: f.id });
	}

	for (const dirId of dirIds) {
		db.run("DELETE FROM dropbox_upload_links WHERE target_directory_id = $id", {
			$id: dirId,
		});
		db.run("DELETE FROM directory_collaborators WHERE directory_id = $id", {
			$id: dirId,
		});
		db.run("DELETE FROM directories WHERE id = $id", { $id: dirId });
	}

	db.run("DELETE FROM dropbox_upload_links WHERE owner_id = $id", {
		$id: userId,
	});
	db.run("DELETE FROM directory_collaborators WHERE user_id = $id", {
		$id: userId,
	});
	db.run("DELETE FROM remote_upload_jobs WHERE owner_id = $id", {
		$id: userId,
	});
	db.run("DELETE FROM api_keys WHERE owner_id = $id", { $id: userId });
	// Torrent jobs are user data like everything else above, so this runs for
	// both /account/reset and account deletion. Unlike credentials/permissions
	// (see callers), there's no reason to keep it around across a reset.
	db.run("DELETE FROM torrent_jobs WHERE owner_id = $id", { $id: userId });
	// Play keys point at files that no longer exist after this, and they FK to
	// users, so they have to go before the account row can be deleted.
	db.run("DELETE FROM media_play_keys WHERE user_id = $id", { $id: userId });

	return paths;
}

/** Mirrors app/routes/account.py -- mounted at /account. */
export function accountRouter(state: AppState): Router {
	const router = Router();
	const { db } = state;

	router.post(
		"/change-credentials",
		requireSession(state),
		requireCsrf,
		asyncHandler(async (req, res) => {
			const {
				new_username: newUsername,
				current_password: currentPassword,
				new_password: newPassword,
			} = req.body ?? {};
			if (typeof newPassword !== "string" || newPassword.length < 12) {
				res.status(400).json({ detail: "new password too short" });
				return;
			}
			// A missing/blank username would otherwise hit db.get/db.run with
			// `undefined` (bun:sqlite throws) or silently rename the account to "".
			const username =
				typeof newUsername === "string" ? newUsername.trim() : "";
			if (!username) {
				res.status(400).json({ detail: "new username is required" });
				return;
			}
			const sessionRow = req.sessionRow!;
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: sessionRow.user_id,
			});
			if (
				!user ||
				typeof currentPassword !== "string" ||
				!(await verifyPassword(currentPassword, user.password_hash))
			) {
				res.status(401).json({ detail: "invalid current password" });
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
			const actor = user.username;
			const newHash = await hashPassword(newPassword);
			db.run(
				"UPDATE users SET username = $u, password_hash = $h, must_change_credentials = 0 WHERE id = $id",
				{
					$u: username,
					$h: newHash,
					$id: user.id,
				},
			);
			db.run("DELETE FROM sessions WHERE user_id = $id AND id != $sid", {
				$id: user.id,
				$sid: sessionRow.id,
			});
			recordAudit(db, {
				actor,
				action: "account.credentials_changed",
				target: `user:${user.id}`,
				ip: clientIp(state, req),
			});
			res.json({ status: "updated" });
		}),
	);

	router.get("/me", requireActiveUser(state), (req, res) => {
		const user = req.currentUser!;
		const perm = ensurePermissions(db, user.id, {
			master: user.role === "master",
		});
		const used =
			db.get<SumRow>(
				"SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id",
				{ $id: user.id },
			)?.total ?? 0;
		res.json({
			id: user.id,
			username: user.username,
			role: user.role,
			has_avatar: user.avatar_data !== null,
			quota_bytes: perm.quota_bytes,
			max_file_bytes: perm.max_file_bytes,
			used_bytes: used,
			can_upload: !!perm.can_upload,
			can_use_api_keys: !!perm.can_use_api_keys,
			can_upload_client_encrypted: !!perm.can_upload_client_encrypted,
			can_delete: !!perm.can_delete,
			can_regenerate_links: !!perm.can_regenerate_links,
			can_delete_links: !!perm.can_delete_links,
			can_create_directories: !!perm.can_create_directories,
			can_manage_lifecycle: !!perm.can_manage_lifecycle,
			can_view_admin: !!perm.can_view_admin,
			can_manage_users: !!perm.can_manage_users,
			can_manage_storage: !!perm.can_manage_storage,
			can_manage_api_keys: !!perm.can_manage_api_keys,
			can_manage_cluster: !!perm.can_manage_cluster,
			can_use_torrents: !!perm.can_use_torrents,
			can_watch_media: !!perm.can_watch_media,
		});
	});

	router.post("/avatar", requireSession(state), requireCsrf, (req, res) => {
		const bb = busboy({
			headers: req.headers,
			limits: { fileSize: AVATAR_MAX_BYTES + 1, files: 1 },
		});
		let handled = false;
		let sawFile = false;

		bb.on("file", (_name, stream, info) => {
			sawFile = true;
			const ct = (info.mimeType || "").toLowerCase().split(";")[0]!.trim();
			if (!ALLOWED_AVATAR_TYPES.has(ct)) {
				handled = true;
				res.status(415).json({
					detail: `unsupported image type: ${ct}. Allowed: jpeg, png, gif, webp`,
				});
				stream.resume();
				req.unpipe(bb);
				return;
			}
			const chunks: Buffer[] = [];
			let truncated = false;
			stream.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			});
			stream.on("limit", () => {
				truncated = true;
			});
			stream.on("end", () => {
				if (handled) return;
				if (truncated) {
					handled = true;
					res.status(413).json({ detail: "avatar must be ≤ 2 MiB" });
					return;
				}
				const data = Buffer.concat(chunks);
				if (data.length === 0) {
					handled = true;
					res.status(400).json({ detail: "empty file" });
					return;
				}
				const detected = sniffImageType(data);
				if (!ALLOWED_AVATAR_TYPES.has(detected)) {
					handled = true;
					res
						.status(415)
						.json({ detail: "file does not match a supported image format" });
					return;
				}
				const sessionRow = req.sessionRow!;
				const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
					$id: sessionRow.user_id,
				});
				if (!user) {
					handled = true;
					res.status(401).json({ detail: "not authenticated" });
					return;
				}
				db.run(
					"UPDATE users SET avatar_data = $data, avatar_content_type = $ct WHERE id = $id",
					{
						$data: data,
						$ct: detected,
						$id: user.id,
					},
				);
				recordAudit(db, {
					actor: user.username,
					action: "account.avatar_updated",
					target: `user:${user.id}`,
					ip: clientIp(state, req),
				});
				handled = true;
				res.json({ status: "updated" });
			});
		});
		bb.on("close", () => {
			if (!handled && !sawFile) {
				res.status(400).json({ detail: "no file uploaded" });
			}
		});
		req.pipe(bb);
	});

	router.delete("/avatar", requireSession(state), requireCsrf, (req, res) => {
		const sessionRow = req.sessionRow!;
		const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: sessionRow.user_id,
		});
		if (!user) {
			res.status(401).json({ detail: "not authenticated" });
			return;
		}
		db.run(
			"UPDATE users SET avatar_data = NULL, avatar_content_type = NULL WHERE id = $id",
			{ $id: user.id },
		);
		recordAudit(db, {
			actor: user.username,
			action: "account.avatar_removed",
			target: `user:${user.id}`,
			ip: clientIp(state, req),
		});
		res.json({ status: "removed" });
	});

	router.get("/avatar/:userId", (req, res) => {
		const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
			$id: req.params.userId,
		});
		if (!user || user.avatar_data === null) {
			res.status(404).json({ detail: "no avatar" });
			return;
		}
		res.set("Cache-Control", "private, max-age=60");
		res.type(user.avatar_content_type ?? "image/jpeg");
		res.send(Buffer.from(user.avatar_data));
	});

	router.post(
		"/reset",
		requireSession(state),
		requireCsrf,
		asyncHandler(async (req, res) => {
			const { current_password: currentPassword } = req.body ?? {};
			const sessionRow = req.sessionRow!;
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: sessionRow.user_id,
			});
			if (
				!user ||
				typeof currentPassword !== "string" ||
				!(await verifyPassword(currentPassword, user.password_hash))
			) {
				res.status(401).json({ detail: "invalid password" });
				return;
			}
			let paths: Array<string | null> = [];
			db.transaction(() => {
				paths = purgeUserData(state, user.id);
				recordAudit(db, {
					actor: user.username,
					action: "account.reset",
					target: `user:${user.id}`,
					ip: clientIp(state, req),
				});
			});
			unlinkQueued(paths);
			res.json({ status: "reset" });
		}),
	);

	router.delete(
		"/",
		requireSession(state),
		requireCsrf,
		asyncHandler(async (req, res) => {
			const { current_password: currentPassword } = req.body ?? {};
			const sessionRow = req.sessionRow!;
			const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
				$id: sessionRow.user_id,
			});
			if (
				!user ||
				typeof currentPassword !== "string" ||
				!(await verifyPassword(currentPassword, user.password_hash))
			) {
				res.status(401).json({ detail: "invalid password" });
				return;
			}
			if (user.role === "master") {
				const masterCount = db.get<{ n: number }>(
					"SELECT COUNT(*) as n FROM users WHERE role = 'master'",
				)!.n;
				if (masterCount <= 1) {
					res.status(409).json({
						detail:
							"cannot delete the only master account — promote another user first",
					});
					return;
				}
			}
			let paths: Array<string | null> = [];
			db.transaction(() => {
				paths = purgeUserData(state, user.id);
				db.run("DELETE FROM sessions WHERE user_id = $id", { $id: user.id });
				db.run("DELETE FROM permissions WHERE user_id = $id", { $id: user.id });
				// Unlike a reset, the account is actually going away -- unenroll MFA
				// and detach any cluster nodes this user registered so the
				// PRAGMA foreign_keys = ON DELETE FROM users below doesn't throw.
				db.run("DELETE FROM credentials WHERE user_id = $id", { $id: user.id });
				db.run(
					"UPDATE cluster_nodes SET created_by_id = NULL WHERE created_by_id = $id",
					{ $id: user.id },
				);
				recordAudit(db, {
					actor: user.username,
					action: "account.deleted",
					target: `user:${user.id}`,
					ip: clientIp(state, req),
				});
				db.run("DELETE FROM users WHERE id = $id", { $id: user.id });
			});
			unlinkQueued(paths);
			res.clearCookie("fu_session", { path: "/" });
			res.json({ status: "deleted" });
		}),
	);

	return router;
}
