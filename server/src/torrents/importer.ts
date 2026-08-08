import type { Dirent } from "node:fs";
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { Request } from "express";
import type { AppState } from "../appState.ts";
import { recordAudit } from "../audit.ts";
import { resolveDirectoryEncryption } from "../crypto/effectiveEncryption.ts";
import type { DirectoryRow, TorrentJobRow, UserRow } from "../db/rows.ts";
import { nowIso } from "../db/rows.ts";
import {
	depthOf,
	getDirectory,
	isEditor,
	MAX_DEPTH,
} from "../directoryTree.ts";
import { HttpError } from "../httpError.ts";
import { newSlug } from "../links.ts";
import { getLogger } from "../logging.ts";
import { ensurePermissions } from "../permissions.ts";
import {
	commitQuota,
	releaseQuota,
	renewQuota,
	reserveQuota,
} from "../cluster/quota.ts";
import { finalizeStoredFile } from "../routes/files.ts";
import {
	debridRoot,
	newInternalRelPath,
	storageRoot,
} from "../storage/paths.ts";

const log = getLogger("app.torrents.importer");

/** Partial-file suffixes qBittorrent leaves behind; never importable. */
const SKIP_SUFFIXES = [".!qB", ".parts", ".unwanted"];

export interface DiscoveredFile {
	/** Absolute path on this server's filesystem. */
	path: string;
	/** Path relative to the torrent root, used as the display filename. */
	rel: string;
	size: number;
}

/** The per-job download directory as *this server* sees it.
 *
 * Real-Debrid jobs are fetched by this process into our own staging root, so
 * the path is unambiguous. For qBittorrent jobs, `save_path` on the row is the
 * directory as *qBittorrent* sees it -- the two differ when qBittorrent runs
 * in a container (see TORRENT_CONTENT_PATH). */
export function localJobDir(state: AppState, job: TorrentJobRow): string {
	if (job.provider === "debrid") return join(debridRoot(), job.tag);
	return join(
		state.settings.torrentContentPath || state.settings.qbittorrentSavePath,
		job.tag,
	);
}

/** The per-job dir holds exactly one entry: the torrent's own file or folder.
 * Descending into a lone folder keeps imported filenames free of a redundant
 * "<torrent name>/" prefix while preserving deeper subdirectory paths. */
function torrentRoot(jobDir: string): string {
	const entries = readdirSync(jobDir, { withFileTypes: true });
	if (entries.length === 1 && entries[0]!.isDirectory())
		return join(jobDir, entries[0]!.name);
	return jobDir;
}

export function discoverFiles(root: string): DiscoveredFile[] {
	const out: DiscoveredFile[] = [];
	const walk = (dir: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
			let size: number;
			try {
				size = statSync(full).size;
			} catch {
				continue;
			}
			out.push({
				path: full,
				rel: relative(root, full).split(sep).join("/"),
				size,
			});
		}
	};
	const stat = statSync(root);
	if (stat.isFile())
		return [{ path: root, rel: basename(root), size: stat.size }];
	walk(root);
	return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Minimal stand-in Request for finalizeStoredFile, which only reads the client
 * IP (audit row) and the host (returned share URL) off it. Imports happen on a
 * scheduler tick, so there is no real request to carry through. */
function backgroundRequest(state: AppState): Request {
	const nodeUrl = state.settings.nodeUrl || "";
	const host =
		nodeUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "") || "localhost:8000";
	return {
		protocol:
			nodeUrl.startsWith("https://") || state.settings.appEnv !== "dev"
				? "https"
				: "http",
		socket: { remoteAddress: "127.0.0.1" },
		header: () => undefined,
		get: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
	} as unknown as Request;
}

function createDirectory(
	state: AppState,
	user: UserRow,
	title: string,
	req: Request,
	parent: DirectoryRow | null,
): DirectoryRow {
	const { db } = state;
	const slug = newSlug();
	// A child always inherits (`encryption_overridden = 0`) with its key columns
	// left NULL -- the single copy of the key material lives on the break point
	// above it, exactly as POST /directories does it. `encryption_mode` is the
	// denormalized mirror the plain SQL filters elsewhere rely on.
	const inheritedMode = parent
		? resolveDirectoryEncryption(db, parent).mode
		: "none";
	db.run(
		`INSERT INTO directories (owner_id, slug, title, parent_directory_id, encryption_mode,
       encryption_overridden, total_bytes, created_at)
     VALUES ($ownerId, $slug, $title, $parentId, $mode, $overridden, 0, $now)`,
		{
			$ownerId: user.id,
			$slug: slug,
			$title: title.slice(0, 512) || "Torrent",
			$parentId: parent ? parent.id : null,
			$mode: inheritedMode,
			$overridden: parent ? 0 : 1,
			$now: nowIso(),
		},
	);
	const dir = db.get<DirectoryRow>(
		"SELECT * FROM directories WHERE id = last_insert_rowid()",
	)!;
	db.run(
		"INSERT INTO directory_links (directory_id, slug, use_count, active, created_at) VALUES ($dirId, $slug, 0, 1, $now)",
		{ $dirId: dir.id, $slug: slug, $now: nowIso() },
	);
	recordAudit(db, {
		actor: user.username,
		action: "directory.created",
		target: `directory:${dir.id}`,
	});
	return dir;
}

export interface ImportResult {
	fileCount: number;
	directoryId: number | null;
	totalBytes: number;
}

/** Copies every completed file of `job` into the owner's storage, reusing the
 * regular upload finalize pipeline (quota accounting, blob attach, share link,
 * cluster replication). Multi-file torrents land in a new folder named after
 * the torrent; single-file torrents become a plain file. */
export async function importCompletedTorrent(
	state: AppState,
	job: TorrentJobRow,
): Promise<ImportResult> {
	const { db } = state;
	const user = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: job.owner_id,
	});
	if (!user) throw new HttpError(404, "torrent owner no longer exists");
	const perm = ensurePermissions(db, user.id, {
		master: user.role === "master",
	});
	const req = backgroundRequest(state);

	const root = localJobDir(state, job);
	let files: DiscoveredFile[];
	try {
		files = discoverFiles(torrentRoot(root));
	} catch (err) {
		throw new HttpError(
			500,
			`downloaded content is not readable at ${root}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!files.length)
		throw new HttpError(
			500,
			"torrent finished but no files were found on disk",
		);

	const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
	const oversized = files.find((f) => f.size > perm.max_file_bytes);
	if (oversized) {
		throw new HttpError(413, `"${oversized.rel}" exceeds your max file size`);
	}
	// One reservation for the whole import, held across every file in it (§5.9).
	//
	// This is the authoritative quota decision for a torrent, and it happens
	// *here* rather than at dispatch for a plain reason: a magnet is a promise,
	// not a size. You cannot reserve against bytes you do not know, and the true
	// content length only exists once metadata has resolved. `debrid.ts` keeps a
	// local advisory check at dispatch so a user who obviously cannot fit the
	// torrent is told in seconds instead of after a 40 GB download — but it is a
	// courtesy, not the gate.
	const reservation = await reserveQuota(state, {
		user,
		bytes: totalBytes,
		kind: "torrent",
	});

	// Where the requester asked for it. Everything about that folder is
	// re-checked here rather than trusted from queue time: a torrent can run for
	// hours, and the folder may since have been deleted, moved deeper, had its
	// encryption changed, or had the requester's rights revoked. Any of those
	// means the import lands at the root instead of failing outright — the bytes
	// are already downloaded, and losing them to a placement problem would be
	// the worse outcome.
	let target =
		job.target_directory_id !== null
			? getDirectory(db, job.target_directory_id)
			: null;
	if (target) {
		const mode = resolveDirectoryEncryption(db, target).mode;
		if (
			mode === "client" ||
			mode === "sealed" ||
			!isEditor(db, target, user) ||
			depthOf(db, target.id) + 1 > MAX_DEPTH
		) {
			log.warning(
				`torrent target folder no longer usable job_id=${job.id} directory_id=${target.id}; importing to the root instead`,
			);
			target = null;
		}
	}
	const directory =
		files.length > 1
			? createDirectory(state, user, job.name, req, target)
			: target;

	let imported = 0;
	try {
		for (const file of files) {
			const relPath = newInternalRelPath();
			const work = `${join(storageRoot(), relPath)}.torrent.work`;
			mkdirSync(join(work, ".."), { recursive: true });
			// Async copy: a multi-GB torrent must not block the event loop, and the
			// import runs on a scheduler tick alongside live requests.
			await copyFile(file.path, work);
			try {
				await finalizeStoredFile({
					state,
					req,
					user,
					perm,
					directory,
					workPath: work,
					relPath,
					stored: file.size,
					contentType: Bun.file(file.path).type || "application/octet-stream",
					encryptionMode: "none",
					compress: false,
					randomizeFilename: false,
					originalFilename: directory ? file.rel : basename(file.rel),
					isPermanent: true,
					tempDays: null,
					deleteIfIdleDays: null,
					archiveAfterIdleDays: null,
					autoUnarchiveOnDownload: true,
					maxUses: null,
					expiresInSeconds: null,
					sourceType: "torrent",
					// The whole import rides one reservation, so a 40-file torrent
					// makes one call to the master rather than 40 — and, more to the
					// point, a per-file reservation could be refused halfway and leave
					// the torrent partly imported.
					reservationUid: reservation.uid,
				});
				imported += 1;
			} catch (err) {
				try {
					unlinkSync(work);
				} catch {
					// best-effort
				}
				throw err;
			}
			// The import itself is the heartbeat (D-16). A very large torrent can
			// take longer to copy into blob storage than the reservation's
			// inactivity window, and an import that expired its own reservation
			// half way through would have the rest of its files land unadmitted.
			await renewQuota(state, reservation.uid);
		}
	} catch (err) {
		await releaseQuota(state, reservation.uid);
		throw err;
	}
	// Settled once, with what actually landed. An over-reservation (a torrent
	// whose files turned out smaller) costs nothing: the reservation stops
	// counting the moment it is settled, and the real bytes are in `files`.
	await commitQuota(state, reservation.uid, totalBytes);

	log.info(
		`torrent imported job_id=${job.id} owner_id=${user.id} files=${imported} bytes=${totalBytes} directory_id=${directory?.id ?? "none"}`,
	);
	return {
		fileCount: imported,
		directoryId: directory ? directory.id : null,
		totalBytes,
	};
}

/** Removes the per-job download directory from disk. Best-effort. */
export function cleanupJobDir(state: AppState, job: TorrentJobRow): void {
	const root = localJobDir(state, job);
	if (!root || !job.tag) return;
	try {
		rmSync(root, { recursive: true, force: true });
	} catch (err) {
		log.warning(
			`torrent cleanup failed job_id=${job.id} path=${root}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
