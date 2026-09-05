import type { Response } from "express";
import { Router } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import {
	type ApiKeyRow,
	type DirectoryRow,
	type FileRow,
	type LinkRow,
	nowIso,
	type UserRow,
} from "../db/rows.ts";
import type { Db, SqlParams } from "../db/types.ts";
import { HttpError } from "../httpError.ts";
import {
	archiveFileCore,
	archiveIdleJob,
	deleteIdleJob,
	linkExpiryJob,
	reconcileStaleStates,
	tempExpiryJob,
	unarchiveFileCore,
} from "../jobs/lifecycle.ts";
import { restartBackendWorkers } from "../jobs/scheduler.ts";
import { getLogger, queryBackendLogs } from "../logging.ts";
import { asyncHandler } from "../middleware/asyncHandler.ts";
import { clientIp, requireSession } from "../middleware/auth.ts";
import { requireActiveUser, requireMaster } from "../middleware/deps.ts";
import {
	ensurePermissions,
	getPermissions,
	hasPermission,
} from "../permissions.ts";
import { requireCsrf } from "../security/csrf.ts";
import {
	allocatedQuotaBytes,
	dedupSavedBytes,
	diskUsageBytes,
	ensureStorageSettings,
	setGlobalStorageCap,
	usedStorageBytes,
	usedStorageBytesForUser,
} from "../storage/accounting.ts";
import { releaseBlob, unlinkQueued } from "../storage/blobs.ts";
import { deleteThumbnail } from "../storage/thumbnail.ts";

const log = getLogger("app.routes.admin");

interface CountRow {
	n: number;
}
interface SumRow {
	s: number | null;
}

function pct(part: number, total: number | null | undefined): number {
	if (!total || total <= 0) return 0;
	return Math.round((part / total) * 10000) / 100;
}

function linkStatus(
	link: LinkRow,
	now: string,
): "inactive" | "expired" | "used_up" | "active" {
	if (!link.active) return "inactive";
	if (link.expires_at !== null && link.expires_at <= now) return "expired";
	if (link.max_uses !== null && link.use_count >= link.max_uses)
		return "used_up";
	return "active";
}

function respondError(res: Response, err: unknown): void {
	if (res.headersSent) return;
	if (err instanceof HttpError) {
		res.status(err.status).json({ detail: err.detail });
		return;
	}
	log.error(
		`unhandled route error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
	);
	res.status(500).json({ detail: "internal server error" });
}

// ── storage overview ───────────────────────────────────────────────────────

function storageDetails(db: Db) {
	const settings = ensureStorageSettings(db);
	const used = usedStorageBytes(db);
	const allocated = allocatedQuotaBytes(db);

	const users = db.all<UserRow>("SELECT * FROM users ORDER BY created_at ASC");
	const userRows = users.map((u) => {
		const perm = getPermissions(db, u.id);
		const userUsed = usedStorageBytesForUser(db, u.id);
		const linkCount =
			db.get<CountRow>(
				"SELECT COUNT(*) as n FROM links l JOIN files f ON l.file_id = f.id WHERE f.owner_id = $id",
				{ $id: u.id },
			)?.n ?? 0;
		const fileCount =
			db.get<CountRow>("SELECT COUNT(*) as n FROM files WHERE owner_id = $id", {
				$id: u.id,
			})?.n ?? 0;
		const apiKeyCount =
			db.get<CountRow>(
				"SELECT COUNT(*) as n FROM api_keys WHERE owner_id = $id",
				{ $id: u.id },
			)?.n ?? 0;
		return {
			id: u.id,
			username: u.username,
			role: u.role,
			used_bytes: userUsed,
			quota_bytes: perm ? perm.quota_bytes : null,
			quota_percent: pct(userUsed, perm ? perm.quota_bytes : null),
			file_count: fileCount,
			link_count: linkCount,
			api_key_count: apiKeyCount,
		};
	});

	const lifecycleCounts: Record<string, number> = {};
	for (const row of db.all<{ lifecycle_state: string; n: number }>(
		"SELECT lifecycle_state, COUNT(*) as n FROM files GROUP BY lifecycle_state",
	)) {
		lifecycleCounts[row.lifecycle_state] = row.n;
	}

	const contentTypeCounts = db
		.all<{
			content_type: string | null;
			n: number;
			stored: number | null;
			size: number | null;
		}>(
			`SELECT content_type, COUNT(*) as n, SUM(stored_size_bytes) as stored, SUM(size_bytes) as size
       FROM files GROUP BY content_type ORDER BY n DESC`,
		)
		.map((r) => ({
			content_type: r.content_type || "application/octet-stream",
			count: r.n,
			stored_bytes: r.stored ?? 0,
			size_bytes: r.size ?? 0,
		}));

	const now = nowIso();
	const linkStatusCounts = { active: 0, inactive: 0, expired: 0, used_up: 0 };
	for (const link of db.all<LinkRow>("SELECT * FROM links")) {
		linkStatusCounts[linkStatus(link, now)] += 1;
	}

	const apiKeyStatusCounts = {
		active:
			db.get<CountRow>("SELECT COUNT(*) as n FROM api_keys WHERE active = 1")
				?.n ?? 0,
		inactive: 0,
		revoked:
			db.get<CountRow>("SELECT COUNT(*) as n FROM api_keys WHERE active = 0")
				?.n ?? 0,
		bound:
			db.get<CountRow>(
				"SELECT COUNT(*) as n FROM api_keys WHERE active = 1 AND bound_ip IS NOT NULL",
			)?.n ?? 0,
		unbound:
			db.get<CountRow>(
				"SELECT COUNT(*) as n FROM api_keys WHERE active = 1 AND bound_ip IS NULL",
			)?.n ?? 0,
	};

	const recentAuditCounts = db
		.all<{ action: string; n: number }>(
			"SELECT action, COUNT(*) as n FROM audit_log GROUP BY action ORDER BY n DESC, action ASC LIMIT 12",
		)
		.map((r) => ({ action: r.action, count: r.n }));

	const disk = diskUsageBytes();
	const diskOut = disk
		? {
				total_bytes: disk.total,
				used_bytes: Math.max(0, disk.total - disk.free),
				free_bytes: disk.free,
			}
		: { total_bytes: 0, used_bytes: 0, free_bytes: 0 };

	const dedupSaved = dedupSavedBytes(db);
	const archiveSavedTotal =
		db.get<SumRow>("SELECT SUM(archive_saved_bytes) as s FROM files")?.s ?? 0;

	const topDownloadedFiles = db.all<{
		id: number;
		filename: string;
		owner_id: number;
		downloads: number;
	}>(
		`SELECT f.id as id, f.original_filename as filename, f.owner_id as owner_id,
            COALESCE(SUM(l.use_count), 0) as downloads
     FROM files f LEFT JOIN links l ON l.file_id = f.id
     GROUP BY f.id, f.original_filename, f.owner_id
     ORDER BY downloads DESC, f.id ASC LIMIT 10`,
	);

	const biggestFiles = db
		.all<FileRow>(
			"SELECT * FROM files ORDER BY size_bytes DESC, id ASC LIMIT 10",
		)
		.map((f) => ({
			id: f.id,
			filename: f.original_filename,
			owner_id: f.owner_id,
			size_bytes: f.size_bytes,
			stored_size_bytes: f.stored_size_bytes,
		}));

	const sourceTypeCounts: Record<string, number> = {};
	for (const row of db.all<{ source_type: string | null; n: number }>(
		"SELECT source_type, COUNT(*) as n FROM files GROUP BY source_type",
	)) {
		sourceTypeCounts[row.source_type || "upload"] = row.n;
	}

	const fileTypeCounts: Record<
		string,
		{ count: number; bytes: number; stored_bytes: number }
	> = {};
	for (const row of db.all<{
		content_type: string | null;
		n: number;
		size: number | null;
		stored: number | null;
	}>(
		"SELECT content_type, COUNT(*) as n, SUM(size_bytes) as size, SUM(stored_size_bytes) as stored FROM files GROUP BY content_type",
	)) {
		fileTypeCounts[row.content_type || "application/octet-stream"] = {
			count: row.n,
			bytes: row.size ?? 0,
			stored_bytes: row.stored ?? 0,
		};
	}

	const remoteUploadCounts: Record<string, number> = {};
	for (const row of db.all<{ status: string | null; n: number }>(
		"SELECT status, COUNT(*) as n FROM remote_upload_jobs GROUP BY status",
	)) {
		remoteUploadCounts[row.status || "unknown"] = row.n;
	}

	const collaboratorCount =
		db.get<CountRow>("SELECT COUNT(*) as n FROM directory_collaborators")?.n ??
		0;

	const busiestDirectories = db
		.all<DirectoryRow>(
			"SELECT * FROM directories ORDER BY total_bytes DESC, id ASC LIMIT 10",
		)
		.map((d) => ({
			id: d.id,
			title: d.title,
			owner_id: d.owner_id,
			file_count:
				db.get<CountRow>(
					"SELECT COUNT(*) as n FROM files WHERE directory_id = $id",
					{ $id: d.id },
				)?.n ?? 0,
			total_bytes: d.total_bytes,
		}));

	const totalFiles =
		db.get<CountRow>("SELECT COUNT(*) as n FROM files")?.n ?? 0;
	const totalLinks =
		db.get<CountRow>("SELECT COUNT(*) as n FROM links")?.n ?? 0;
	const activeLinks =
		db.get<CountRow>("SELECT COUNT(*) as n FROM links WHERE active = 1")?.n ??
		0;
	const totalApiKeys =
		db.get<CountRow>("SELECT COUNT(*) as n FROM api_keys")?.n ?? 0;

	return {
		global_storage_quota_bytes: settings.global_storage_quota_bytes,
		used_bytes: used,
		allocated_quota_bytes: allocated,
		storage_summary: {
			used_percent: pct(used, settings.global_storage_quota_bytes),
			allocated_percent: pct(allocated, settings.global_storage_quota_bytes),
			free_under_cap_bytes: Math.max(
				0,
				settings.global_storage_quota_bytes - used,
			),
			unallocated_quota_bytes: Math.max(
				0,
				settings.global_storage_quota_bytes - allocated,
			),
		},
		disk: diskOut,
		archive_saved_bytes: archiveSavedTotal,
		dedup_saved_bytes: dedupSaved,
		total_files: totalFiles,
		total_links: totalLinks,
		active_links: activeLinks,
		total_api_keys: totalApiKeys,
		users: userRows,
		lifecycle_counts: lifecycleCounts,
		content_type_counts: contentTypeCounts,
		link_status_counts: linkStatusCounts,
		api_key_status_counts: apiKeyStatusCounts,
		recent_audit_counts: recentAuditCounts,
		fun_stats: {
			dedup_saved_bytes: dedupSaved,
			archive_saved_bytes: archiveSavedTotal,
			top_downloaded_files: topDownloadedFiles,
			top_storage_users: [...userRows]
				.sort((a, b) => b.used_bytes - a.used_bytes)
				.slice(0, 10),
			biggest_files: biggestFiles,
			file_type_counts: fileTypeCounts,
			source_type_counts: sourceTypeCounts,
			remote_upload_counts: remoteUploadCounts,
			dropbox_upload_count: sourceTypeCounts["dropbox"] ?? 0,
			remote_upload_count: sourceTypeCounts["remote"] ?? 0,
			collaborator_count: collaboratorCount,
			busiest_directories: busiestDirectories,
		},
	};
}

// ── bulk actions ────────────────────────────────────────────────────────────

type BulkCandidate =
	| { kind: "api_key"; row: ApiKeyRow }
	| { kind: "link"; row: LinkRow }
	| { kind: "file"; row: FileRow }
	| { kind: "directory"; row: DirectoryRow }
	| { kind: "job"; label: string };

const BULK_ACTION_PERMISSIONS: Record<string, string> = {
	delete_api_keys: "can_manage_api_keys",
	reset_api_key_ips: "can_manage_api_keys",
	delete_inactive_links: "can_delete_links",
	delete_files: "can_manage_storage",
	delete_directories: "can_manage_storage",
	archive_files: "can_manage_lifecycle",
	unarchive_files: "can_manage_lifecycle",
	run_cleanup_jobs: "can_manage_lifecycle",
};

function bulkActionPermission(action: string): string {
	const flag = BULK_ACTION_PERMISSIONS[action];
	if (!flag) throw new HttpError(400, "unknown bulk action");
	return flag;
}

/**
 * Actions whose gating flag is an ordinary, default-on user capability. Holding
 * `can_delete_links` means "may delete *your* links", not everyone's -- so for
 * a non-master these are pinned to the caller's own rows unless they also hold
 * `can_manage_storage`, the flag that actually means "other people's data".
 * Without this, `can_view_admin` alone let a user archive every file on the
 * server. `can_manage_api_keys` / `can_manage_storage` are admin-grade (default
 * off, granted deliberately) and keep their system-wide reach.
 */
const OWNER_SCOPED_ACTIONS = new Set([
	"delete_inactive_links",
	"archive_files",
	"unarchive_files",
]);

/** Checks the action flag and returns the `owner_id` the candidate query must
 * use: the caller's own id when the action is owner-scoped for them, else the
 * one they asked for. */
function requireBulkPermission(
	db: Db,
	action: string,
	user: UserRow,
	requestedOwnerId: number | null,
): number | null {
	if (user.role === "master") return requestedOwnerId;
	const flag = bulkActionPermission(action);
	const perm = ensurePermissions(db, user.id, { master: false });
	if (!perm.can_view_admin || !hasPermission(perm, flag)) {
		throw new HttpError(403, "permission denied");
	}
	if (hasPermission(perm, "can_manage_storage")) return requestedOwnerId;
	if (action === "run_cleanup_jobs") {
		// The sweeps touch every owner's rows; there is no per-owner form.
		throw new HttpError(
			403,
			"running cleanup jobs requires can_manage_storage",
		);
	}
	if (!OWNER_SCOPED_ACTIONS.has(action)) return requestedOwnerId;
	if (requestedOwnerId !== null && requestedOwnerId !== user.id) {
		throw new HttpError(
			403,
			"bulk actions on other users' data require can_manage_storage",
		);
	}
	return user.id;
}

function dedupeIds(ids: number[]): number[] {
	const seen = new Set<number>();
	const out: number[] = [];
	for (const raw of ids) {
		if (raw > 0 && !seen.has(raw)) {
			seen.add(raw);
			out.push(raw);
		}
	}
	return out;
}

function inClause(
	prefix: string,
	ids: number[],
): { clause: string; params: Record<string, number> } {
	const params: Record<string, number> = {};
	ids.forEach((id, i) => {
		params[`$${prefix}${i}`] = id;
	});
	return { clause: ids.map((_, i) => `$${prefix}${i}`).join(","), params };
}

function bulkCandidates(
	db: Db,
	action: string,
	ids: number[],
	ownerId: number | null,
): BulkCandidate[] {
	bulkActionPermission(action);

	if (action === "delete_api_keys" || action === "reset_api_key_ips") {
		const clauses: string[] = [];
		const params: SqlParams = {};
		if (action === "reset_api_key_ips") clauses.push("bound_ip IS NOT NULL");
		if (ids.length) {
			const { clause, params: p } = inClause("id", ids);
			clauses.push(`id IN (${clause})`);
			Object.assign(params, p);
		}
		if (ownerId !== null) {
			clauses.push("owner_id = $ownerId");
			params.$ownerId = ownerId;
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db.all<ApiKeyRow>(
			`SELECT * FROM api_keys ${where} ORDER BY owner_id ASC, user_key_number ASC, id ASC`,
			params,
		);
		return rows.map((row) => ({ kind: "api_key", row }));
	}

	if (action === "delete_inactive_links") {
		const clauses: string[] = [];
		const params: SqlParams = {};
		if (ids.length) {
			const { clause, params: p } = inClause("id", ids);
			clauses.push(`l.id IN (${clause})`);
			Object.assign(params, p);
		}
		if (ownerId !== null) {
			clauses.push("f.owner_id = $ownerId");
			params.$ownerId = ownerId;
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db.all<LinkRow>(
			`SELECT l.* FROM links l JOIN files f ON l.file_id = f.id ${where} ORDER BY l.id ASC`,
			params,
		);
		const now = nowIso();
		return rows
			.filter((row) => linkStatus(row, now) !== "active")
			.map((row) => ({ kind: "link", row }));
	}

	if (
		action === "delete_files" ||
		action === "archive_files" ||
		action === "unarchive_files"
	) {
		const clauses: string[] = [];
		const params: SqlParams = {};
		if (ids.length) {
			const { clause, params: p } = inClause("id", ids);
			clauses.push(`id IN (${clause})`);
			Object.assign(params, p);
		}
		if (ownerId !== null) {
			clauses.push("owner_id = $ownerId");
			params.$ownerId = ownerId;
		}
		if (action === "archive_files")
			clauses.push(
				"archived = 0 AND encryption_mode NOT IN ('client', 'sealed')",
			);
		else if (action === "unarchive_files") clauses.push("archived = 1");
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db.all<FileRow>(
			`SELECT * FROM files ${where} ORDER BY id ASC`,
			params,
		);
		return rows.map((row) => ({ kind: "file", row }));
	}

	if (action === "delete_directories") {
		const clauses: string[] = [];
		const params: SqlParams = {};
		if (ids.length) {
			const { clause, params: p } = inClause("id", ids);
			clauses.push(`id IN (${clause})`);
			Object.assign(params, p);
		}
		if (ownerId !== null) {
			clauses.push("owner_id = $ownerId");
			params.$ownerId = ownerId;
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db.all<DirectoryRow>(
			`SELECT * FROM directories ${where} ORDER BY id ASC`,
			params,
		);
		return rows.map((row) => ({ kind: "directory", row }));
	}

	if (action === "run_cleanup_jobs") {
		return ["temp-expiry", "idle-delete", "link-expiry", "reconcile"].map(
			(label) => ({ kind: "job", label }),
		);
	}

	throw new HttpError(400, "unknown bulk action");
}

function candidateId(c: BulkCandidate, idx: number): number | string {
	if (c.kind === "job") return idx + 1;
	return c.row.id;
}

function candidateLabel(c: BulkCandidate): string {
	switch (c.kind) {
		case "api_key":
			return `API key #${c.row.user_key_number || c.row.id}`;
		case "link":
			return `link:${c.row.id}`;
		case "file":
			return c.row.original_filename;
		case "directory":
			return c.row.title || `folder:${c.row.id}`;
		case "job":
			return c.label;
	}
}

function bulkPreviewPayload(action: string, candidates: BulkCandidate[]) {
	const count = candidates.length;
	return {
		action,
		affected_count: count,
		confirmation_phrase: `CONFIRM ${count}`,
		items: candidates
			.slice(0, 50)
			.map((c, idx) => ({ id: candidateId(c, idx), label: candidateLabel(c) })),
	};
}

/** Admin-flavored file delete: unlike jobs/lifecycle.ts's deleteFileForJob,
 * this adjusts the parent directory's total_bytes. Mirrors
 * app/routes/admin.py::_queue_file_delete. */
function queueFileDelete(db: Db, f: FileRow): string | null {
	db.run("DELETE FROM links WHERE file_id = $id", { $id: f.id });
	if (f.directory_id !== null) {
		db.run(
			"UPDATE directories SET total_bytes = MAX(0, COALESCE(total_bytes, 0) - $dec) WHERE id = $id",
			{
				$dec: f.size_bytes ?? 0,
				$id: f.directory_id,
			},
		);
	}
	const path = releaseBlob(db, f);
	db.run("DELETE FROM files WHERE id = $id", { $id: f.id });
	deleteThumbnail(f.id);
	return path;
}

/** Mirrors app/routes/admin.py -- Storage/backend-logs/lifecycle/bulk-action
 * tabs of the admin panel. Users/keys/audit/files admin panels live in their
 * own routers (users.ts, keys.ts, audit.ts, files.ts); this file covers only
 * what's left over. Mount at /admin. */
export function adminRouter(state: AppState): Router {
	const router = Router();
	const { db, settings } = state;

	router.get("/storage", requireMaster(state), (_req, res) => {
		res.json(storageDetails(db));
	});

	router.patch(
		"/storage",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(req, res) => {
			const master = req.currentUser!;
			const body = req.body ?? {};
			const raw = body.global_storage_quota_bytes;
			if (
				typeof raw !== "number" ||
				!Number.isFinite(raw) ||
				!Number.isInteger(raw) ||
				raw < 0
			) {
				res.status(400).json({
					detail: "global_storage_quota_bytes must be a non-negative integer",
				});
				return;
			}
			try {
				const updated = setGlobalStorageCap(db, raw);
				recordAudit(db, {
					actor: master.username,
					action: "storage.global_quota_updated",
					target: "storage:global",
					ip: clientIp(state, req),
				});
				log.warning(
					`global storage cap updated actor_id=${master.id} cap_bytes=${raw}`,
				);
				res.json({
					global_storage_quota_bytes: updated.global_storage_quota_bytes,
					used_bytes: usedStorageBytes(db),
					allocated_quota_bytes: allocatedQuotaBytes(db),
				});
			} catch (err) {
				respondError(res, err);
			}
		},
	);

	// Backend logs live in this process's own ring buffer (never replicated).
	// Cross-node proxying is part of the deferred cluster runtime -- until
	// that lands, a `server` param naming a peer 404s instead of proxying.
	router.get("/backend/logs", requireMaster(state), (req, res) => {
		const q =
			typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
		const level =
			typeof req.query.level === "string"
				? req.query.level.slice(0, 16)
				: undefined;
		const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
		const server =
			typeof req.query.server === "string" ? req.query.server : undefined;
		const servers = [
			{ node_id: settings.nodeId, node_name: settings.nodeName },
		];

		if (server && server !== settings.nodeId) {
			res.status(404).json({ detail: "unknown or unreachable server" });
			return;
		}

		const result = queryBackendLogs({ q, level, limit });
		res.json({ ...result, servers, server: settings.nodeId });
	});

	router.post(
		"/backend/restart-workers",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(req, res) => {
			const master = req.currentUser!;
			log.warning(`backend worker restart requested actor_id=${master.id}`);
			const result = restartBackendWorkers(state);
			log.warning(
				`backend worker restart completed actor_id=${master.id} jobs=${result.jobs.join(",")}`,
			);
			res.json(result);
		},
	);

	function getFileOr404(res: Response, fileId: number): FileRow | null {
		const f = db.get<FileRow>("SELECT * FROM files WHERE id = $id", {
			$id: fileId,
		});
		if (!f) {
			res.status(404).json({ detail: "not found" });
			return null;
		}
		return f;
	}

	router.post(
		"/files/:fileId(\\d+)/archive",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		asyncHandler(async (req, res) => {
			const master = req.currentUser!;
			const f = getFileOr404(res, Number(req.params.fileId));
			if (!f) return;
			try {
				const result = await archiveFileCore(db, {
					actor: master.username,
					ip: clientIp(state, req),
					file: f,
				});
				res.json(result);
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	router.post(
		"/files/:fileId(\\d+)/unarchive",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		asyncHandler(async (req, res) => {
			const master = req.currentUser!;
			const f = getFileOr404(res, Number(req.params.fileId));
			if (!f) return;
			try {
				const result = await unarchiveFileCore(db, {
					actor: master.username,
					ip: clientIp(state, req),
					file: f,
				});
				res.json(result);
			} catch (err) {
				respondError(res, err);
			}
		}),
	);

	router.post(
		"/lifecycle/temp-expiry",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(_req, res) => {
			log.info("manual lifecycle temp expiry started");
			const processed = tempExpiryJob(db);
			log.info(`manual lifecycle temp expiry completed processed=${processed}`);
			res.json({ processed });
		},
	);

	router.post(
		"/lifecycle/link-expiry",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(_req, res) => {
			log.info("manual lifecycle link expiry started");
			const processed = linkExpiryJob(db);
			log.info(`manual lifecycle link expiry completed processed=${processed}`);
			res.json({ processed });
		},
	);

	router.post(
		"/lifecycle/reconcile",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		(_req, res) => {
			log.info("manual lifecycle reconcile started");
			const processed = reconcileStaleStates(db);
			log.info(`manual lifecycle reconcile completed processed=${processed}`);
			res.json({ processed });
		},
	);

	router.post(
		"/lifecycle/archive-idle",
		requireSession(state),
		requireCsrf,
		requireMaster(state),
		asyncHandler(async (_req, res) => {
			log.info("manual lifecycle archive idle scan started");
			const processed = await archiveIdleJob(db);
			log.info(
				`manual lifecycle archive idle scan completed processed=${processed}`,
			);
			res.json({ processed });
		}),
	);

	router.post(
		"/bulk/preview",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		(req, res) => {
			const user = req.currentUser!;
			const body = req.body ?? {};
			const action = String(body.action ?? "");
			const ids = dedupeIds(
				Array.isArray(body.ids) ? body.ids.map(Number) : [],
			);
			const requestedOwnerId =
				body.owner_id != null ? Number(body.owner_id) : null;
			try {
				const ownerId = requireBulkPermission(
					db,
					action,
					user,
					requestedOwnerId,
				);
				const candidates = bulkCandidates(db, action, ids, ownerId);
				log.info(
					`bulk preview action=${action} actor_id=${user.id} candidate_count=${candidates.length} explicit_ids=${ids.length} owner_id=${ownerId}`,
				);
				res.json(bulkPreviewPayload(action, candidates));
			} catch (err) {
				respondError(res, err);
			}
		},
	);

	router.post(
		"/bulk/run",
		requireSession(state),
		requireCsrf,
		requireActiveUser(state),
		asyncHandler(async (req, res) => {
			const user = req.currentUser!;
			const body = req.body ?? {};
			const action = String(body.action ?? "");
			const ids = dedupeIds(
				Array.isArray(body.ids) ? body.ids.map(Number) : [],
			);
			const requestedOwnerId =
				body.owner_id != null ? Number(body.owner_id) : null;
			const confirm = typeof body.confirm === "string" ? body.confirm : null;

			let candidates: BulkCandidate[];
			let ownerId: number | null;
			try {
				ownerId = requireBulkPermission(db, action, user, requestedOwnerId);
				candidates = bulkCandidates(db, action, ids, ownerId);
			} catch (err) {
				respondError(res, err);
				return;
			}
			log.warning(
				`bulk run requested action=${action} actor_id=${user.id} candidate_count=${candidates.length} explicit_ids=${ids.length} owner_id=${ownerId}`,
			);
			const expected = `CONFIRM ${candidates.length}`;
			if (confirm !== expected) {
				log.warning(
					`bulk run rejected confirmation action=${action} actor_id=${user.id}`,
				);
				res.status(400).json({ detail: `type "${expected}" to confirm` });
				return;
			}

			let processed = 0;
			const unlinkAfterCommit: Array<string | null> = [];
			const ip = clientIp(state, req);

			try {
				if (action === "delete_api_keys") {
					for (const c of candidates) {
						if (c.kind !== "api_key") continue;
						db.run("DELETE FROM api_keys WHERE id = $id", { $id: c.row.id });
						processed++;
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.apikeys_deleted",
							target: `api_keys:${processed}`,
							ip,
						});
					}
				} else if (action === "reset_api_key_ips") {
					for (const c of candidates) {
						if (c.kind !== "api_key") continue;
						db.run("UPDATE api_keys SET bound_ip = NULL WHERE id = $id", {
							$id: c.row.id,
						});
						processed++;
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.apikey_ips_reset",
							target: `api_keys:${processed}`,
							ip,
						});
					}
				} else if (action === "delete_inactive_links") {
					for (const c of candidates) {
						if (c.kind !== "link") continue;
						db.run("DELETE FROM links WHERE id = $id", { $id: c.row.id });
						processed++;
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.links_deleted",
							target: `links:${processed}`,
							ip,
						});
					}
				} else if (action === "delete_files") {
					for (const c of candidates) {
						if (c.kind !== "file") continue;
						unlinkAfterCommit.push(queueFileDelete(db, c.row));
						processed++;
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.files_deleted",
							target: `files:${processed}`,
							ip,
						});
					}
					unlinkQueued(unlinkAfterCommit);
				} else if (action === "delete_directories") {
					for (const c of candidates) {
						if (c.kind !== "directory") continue;
						const members = db.all<FileRow>(
							"SELECT * FROM files WHERE directory_id = $id",
							{ $id: c.row.id },
						);
						for (const member of members)
							unlinkAfterCommit.push(queueFileDelete(db, member));
						db.run(
							"DELETE FROM dropbox_upload_links WHERE target_directory_id = $id",
							{ $id: c.row.id },
						);
						db.run(
							"DELETE FROM directory_collaborators WHERE directory_id = $id",
							{ $id: c.row.id },
						);
						db.run("DELETE FROM directories WHERE id = $id", { $id: c.row.id });
						processed++;
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.directories_deleted",
							target: `directories:${processed}`,
							ip,
						});
					}
					unlinkQueued(unlinkAfterCommit);
				} else if (action === "archive_files") {
					for (const c of candidates) {
						if (c.kind !== "file") continue;
						await archiveFileCore(db, {
							actor: user.username,
							ip,
							file: c.row,
						});
						processed++;
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.files_archived",
							target: `files:${processed}`,
							ip,
						});
					}
				} else if (action === "unarchive_files") {
					for (const c of candidates) {
						if (c.kind !== "file") continue;
						try {
							await unarchiveFileCore(db, {
								actor: user.username,
								ip,
								file: c.row,
							});
							processed++;
						} catch (err) {
							if (err instanceof HttpError) continue; // skip files that can't be unarchived in bulk
							throw err;
						}
					}
					if (processed) {
						recordAudit(db, {
							actor: user.username,
							action: "bulk.files_unarchived",
							target: `files:${processed}`,
							ip,
						});
					}
				} else if (action === "run_cleanup_jobs") {
					processed =
						tempExpiryJob(db) +
						deleteIdleJob(db) +
						linkExpiryJob(db) +
						reconcileStaleStates(db);
					recordAudit(db, {
						actor: user.username,
						action: "bulk.cleanup_ran",
						target: `jobs:${processed}`,
						ip,
					});
				} else {
					throw new HttpError(400, "unknown bulk action");
				}
			} catch (err) {
				respondError(res, err);
				return;
			}

			log.warning(
				`bulk run completed action=${action} actor_id=${user.id} processed=${processed} affected=${candidates.length}`,
			);
			res.json({
				action,
				processed_count: processed,
				affected_count: candidates.length,
			});
		}),
	);

	return router;
}
