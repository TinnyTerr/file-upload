import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppState } from "../appState.ts";
import type { Settings } from "../config.ts";
import { nowIso, type TorrentJobRow, type UserRow } from "../db/rows.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";
import { ensurePermissions } from "../permissions.ts";
import { debridRoot, safeJoin } from "../storage/paths.ts";
import {
	addTorrent as qbitAddTorrent,
	isConfigured as qbitConfigured,
} from "./qbittorrent.ts";
import * as rd from "./realdebrid.ts";

const log = getLogger("app.torrents.debrid");

/** Abort a Real-Debrid file transfer that goes this long without a byte. A
 * fixed overall timeout is useless here -- a legitimate transfer can run for
 * hours -- so idleness is what we police. */
const STALL_TIMEOUT_MS = 120_000;
/** Throttle for progress writes during a transfer; one row update per second
 * is plenty for a UI that polls every five. */
const PROGRESS_INTERVAL_MS = 1000;

export type Provider = "debrid" | "qbittorrent";

export interface TorrentSource {
	/** Magnet URI. Mutually exclusive with `file`. */
	magnet?: string;
	file?: { filename: string; bytes: Buffer };
}

// ── uploaded .torrent stash ────────────────────────────────────────────────
// A magnet lives in `torrent_jobs.source` and can be replayed at any time, but
// an uploaded .torrent's bytes would otherwise be gone the moment the request
// ends -- leaving a mid-flight Real-Debrid failure with nothing to hand
// qBittorrent. Stashing the metainfo (<= MAX_TORRENT_FILE_BYTES) keeps the
// fallback path symmetric for both source kinds.

function sourceStashPath(tag: string): string {
	return safeJoin(join(debridRoot(), "_sources"), `${tag}.torrent`);
}

/** Sentinel marking "every byte of this torrent reached the staging dir".
 * Kept outside the job directory so the importer never sees it as content.
 * Without it a retry cannot tell a complete transfer that failed to *import*
 * (quota) from a half-written one, and would import truncated files. */
function completeMarkerPath(tag: string): string {
	return safeJoin(join(debridRoot(), "_sources"), `${tag}.complete`);
}

export function markTransferComplete(tag: string): void {
	try {
		const path = completeMarkerPath(tag);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, nowIso());
	} catch (err) {
		log.warning(`could not mark transfer complete for ${tag}: ${errText(err)}`);
	}
}

export function isTransferComplete(tag: string): boolean {
	try {
		return existsSync(completeMarkerPath(tag));
	} catch {
		return false;
	}
}

function stashSource(tag: string, bytes: Buffer): void {
	try {
		const path = sourceStashPath(tag);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes, { mode: 0o600 });
	} catch (err) {
		log.warning(
			`could not stash .torrent for ${tag}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function readStashedSource(tag: string): Buffer | null {
	try {
		return readFileSync(sourceStashPath(tag));
	} catch {
		return null;
	}
}

export function clearStashedSource(tag: string): void {
	try {
		rmSync(sourceStashPath(tag), { force: true });
		rmSync(completeMarkerPath(tag), { force: true });
	} catch {
		// best-effort
	}
}

// ── dispatch ───────────────────────────────────────────────────────────────

export interface DispatchResult {
	provider: Provider;
	/** Real-Debrid torrent id, when provider = "debrid". */
	debridId: string | null;
	/** Download location handed to qBittorrent, or our staging dir for debrid. */
	savePath: string;
	/** Populated only when Real-Debrid was configured but could not take the job. */
	fallbackReason: string | null;
}

function qbitSavePath(settings: Settings, tag: string): string {
	return join(settings.qbittorrentSavePath, tag);
}

async function sendToQbittorrent(
	settings: Settings,
	source: TorrentSource,
	tag: string,
): Promise<string> {
	const savePath = qbitSavePath(settings, tag);
	await qbitAddTorrent(settings, {
		url: source.magnet,
		file: source.file,
		savePath,
		tag,
	});
	return savePath;
}

/** Hands a torrent to Real-Debrid, falling back to qBittorrent on any failure.
 *
 * Real-Debrid downloads a torrent it has never seen just as happily as a
 * cached one, so there is deliberately no `instantAvailability` pre-check
 * here: when debrid is configured, *every* torrent goes through it and only a
 * genuine failure (missing/invalid token, non-premium account, exhausted
 * traffic, Real-Debrid outage) demotes the job to qBittorrent. */
export async function dispatchTorrent(
	state: AppState,
	source: TorrentSource,
	tag: string,
): Promise<DispatchResult> {
	const { settings } = state;

	if (rd.isConfigured(settings)) {
		try {
			const added = source.magnet
				? await rd.addMagnet(settings.realDebridApiKey, source.magnet)
				: await rd.addTorrentFile(
						settings.realDebridApiKey,
						source.file!.bytes,
					);
			// A freshly added torrent sits in `waiting_files_selection` until told
			// what to take; a magnet passes through `magnet_conversion` first and
			// rejects the call until it has metadata, so the poller retries there.
			try {
				await rd.selectAllFiles(settings.realDebridApiKey, added.id);
			} catch (err) {
				log.info(
					`Real-Debrid file selection deferred to the poller for ${added.id}: ${errText(err)}`,
				);
			}
			if (source.file) stashSource(tag, source.file.bytes);
			return {
				provider: "debrid",
				debridId: added.id,
				savePath: join(debridRoot(), tag),
				fallbackReason: null,
			};
		} catch (err) {
			const reason = errText(err);
			if (!qbitConfigured(settings)) {
				throw new HttpError(
					502,
					`Real-Debrid rejected the torrent and no qBittorrent fallback is configured: ${reason}`,
				);
			}
			log.warning(
				`Real-Debrid add failed, falling back to qBittorrent: ${reason}`,
			);
			const savePath = await sendToQbittorrent(settings, source, tag);
			return {
				provider: "qbittorrent",
				debridId: null,
				savePath,
				fallbackReason: reason.slice(0, 500),
			};
		}
	}

	if (!qbitConfigured(settings)) {
		throw new HttpError(503, "torrenting is not configured on this server");
	}
	const savePath = await sendToQbittorrent(settings, source, tag);
	return {
		provider: "qbittorrent",
		debridId: null,
		savePath,
		fallbackReason: null,
	};
}

/** Moves a Real-Debrid job that died mid-flight over to qBittorrent, restarting
 * the download from scratch. Returns false when there is nothing to fall back
 * to (no qBittorrent, or an uploaded .torrent whose stash is gone), in which
 * case the caller fails the job outright. */
export async function fallbackToQbittorrent(
	state: AppState,
	job: TorrentJobRow,
	reason: string,
): Promise<boolean> {
	const { db, settings } = state;
	if (!qbitConfigured(settings)) return false;

	const source: TorrentSource = {};
	if (job.source.startsWith("magnet:")) {
		source.magnet = job.source;
	} else {
		const bytes = readStashedSource(job.tag);
		if (!bytes) return false;
		source.file = { filename: `${job.tag}.torrent`, bytes };
	}

	let savePath: string;
	try {
		savePath = await sendToQbittorrent(settings, source, job.tag);
	} catch (err) {
		log.warning(
			`qBittorrent fallback failed job_id=${job.id}: ${errText(err)}`,
		);
		return false;
	}

	if (job.debrid_id)
		await rd.deleteTorrent(settings.realDebridApiKey, job.debrid_id);
	cleanupDebridDir(job.tag);
	clearStashedSource(job.tag);

	// created_at is deliberately reset: it is what the poller's MISSING_GRACE_MS
	// window is measured from, and this torrent has only just been handed to
	// qBittorrent no matter how long it sat on Real-Debrid first.
	db.run(
		`UPDATE torrent_jobs SET provider = 'qbittorrent', debrid_id = NULL, save_path = $savePath,
       fallback_reason = $reason, status = 'queued', progress = 0, downloaded_bytes = 0, dl_speed = 0,
       eta_seconds = NULL, error = NULL, created_at = $now, updated_at = $now
     WHERE id = $id`,
		{
			$savePath: savePath,
			$reason: reason.slice(0, 500),
			$now: nowIso(),
			$id: job.id,
		},
	);
	log.info(`torrent job fell back to qBittorrent job_id=${job.id}: ${reason}`);
	return true;
}

// ── polling ────────────────────────────────────────────────────────────────

/** Real-Debrid states that still need our attention on the next tick, mapped
 * to the job status the UI shows. */
function localStatusFor(debridStatus: string): "queued" | "downloading" {
	return debridStatus === "downloading" ||
		debridStatus === "compressing" ||
		debridStatus === "uploading"
		? "downloading"
		: "queued";
}

/** Advances one Real-Debrid job by a single tick. Returns "fetch" when the
 * torrent is complete on Real-Debrid's side and the caller should kick off the
 * transfer, "dead" when it failed there, and "wait" otherwise. */
export async function pollDebridJob(
	state: AppState,
	job: TorrentJobRow,
): Promise<"wait" | "fetch" | "dead"> {
	const { db, settings } = state;
	if (!job.debrid_id) return "dead";

	const info = await rd.torrentInfo(settings.realDebridApiKey, job.debrid_id);

	// Real-Debrid refuses selectFiles until a magnet has resolved its metadata,
	// so the add-time attempt can legitimately have been a no-op.
	if (info.status === "waiting_files_selection") {
		await rd
			.selectAllFiles(settings.realDebridApiKey, job.debrid_id)
			.catch((err) => {
				log.warning(
					`Real-Debrid file selection failed job_id=${job.id}: ${errText(err)}`,
				);
			});
	}

	db.run(
		`UPDATE torrent_jobs SET status = $status, debrid_status = $debridStatus, name = $name, info_hash = $hash,
       progress = $progress, size_bytes = $size, downloaded_bytes = $done, dl_speed = $speed,
       eta_seconds = $eta, updated_at = $now
     WHERE id = $id`,
		{
			$status: localStatusFor(info.status),
			$debridStatus: info.status,
			$name: info.filename || job.name,
			$hash: (info.hash || job.info_hash || "").toLowerCase() || null,
			// Real-Debrid reports the torrent leg as 0..100; ours is 0..1, and the
			// transfer leg re-uses the same field for its own 0..1 progress.
			$progress: Math.min(1, Math.max(0, (info.progress ?? 0) / 100)),
			$size: info.bytes ?? job.size_bytes,
			$done: Math.round(((info.progress ?? 0) / 100) * (info.bytes ?? 0)),
			$speed: info.speed ?? 0,
			$eta: etaFrom(info.bytes ?? 0, info.progress ?? 0, info.speed ?? 0),
			$now: nowIso(),
			$id: job.id,
		},
	);

	if (rd.isDebridDead(info.status)) return "dead";
	if (rd.isDebridReady(info.status)) return "fetch";
	return "wait";
}

function etaFrom(
	totalBytes: number,
	progressPercent: number,
	speed: number,
): number | null {
	if (!speed || speed <= 0 || !totalBytes) return null;
	const remaining =
		totalBytes * (1 - Math.min(1, Math.max(0, progressPercent / 100)));
	const eta = Math.round(remaining / speed);
	return eta > 0 && eta < 86_400 * 100 ? eta : null;
}

// ── transfer ───────────────────────────────────────────────────────────────

/** Filesystem-hostile characters in a torrent-supplied path segment. Traversal
 * is separately blocked by safeJoin; this is about Windows-illegal names and
 * control characters. */
function sanitizeSegment(segment: string): string {
	const cleaned = segment
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters out of an attacker-supplied path segment is the whole point.
		.replace(/[\u0000-\u001f<>:"|?*\\]/g, "_")
		.replace(/[. ]+$/, "");
	return cleaned || "_";
}

/** Turns a Real-Debrid `files[].path` ("/Show/S01/ep1.mkv") into a relative
 * path safe to create under the job directory. */
function relPathFor(debridPath: string): string {
	const segments = debridPath
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s && s !== "." && s !== "..")
		.map(sanitizeSegment);
	return segments.length ? segments.join("/") : "download.bin";
}

interface PlannedFile {
	link: string;
	relPath: string;
	bytes: number;
}

/** Pairs each restricted link with the file it belongs to.
 *
 * `links[]` holds one entry per *selected* file, in file order. When the two
 * lengths disagree -- Real-Debrid packs very large torrents into split RAR
 * volumes, which are links without a matching `files` entry -- the mapping is
 * abandoned and each link is named from its own unrestrict response instead. */
function planFiles(info: rd.DebridTorrentInfo): PlannedFile[] | null {
	const links = info.links ?? [];
	if (!links.length) return null;
	const selected = (info.files ?? []).filter((f) => f.selected === 1);
	if (selected.length !== links.length) return null;
	return links.map((link, i) => ({
		link,
		relPath: relPathFor(selected[i]!.path),
		bytes: selected[i]!.bytes ?? 0,
	}));
}

/** Streams one unrestricted URL to disk, reporting bytes as they land.
 *
 * `pipeline` over an async generator gives backpressure for free, so a
 * multi-GB file never accumulates in memory, and tears the write stream down
 * on any failure. The stall timer is the only timeout: a legitimate transfer
 * can run for hours, so idleness is what gets policed, not duration. */
async function streamToFile(
	url: string,
	destination: string,
	onBytes: (delta: number) => void,
): Promise<number> {
	mkdirSync(dirname(destination), { recursive: true });

	const controller = new AbortController();
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	let stalled = false;
	const resetStall = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			stalled = true;
			controller.abort();
		}, STALL_TIMEOUT_MS);
	};
	const failure = (err: unknown) =>
		new HttpError(
			502,
			stalled
				? "Real-Debrid transfer stalled"
				: `Real-Debrid transfer failed: ${errText(err)}`,
		);

	let written = 0;
	resetStall();
	try {
		let res: Response;
		try {
			res = await fetch(url, { signal: controller.signal, redirect: "follow" });
		} catch (err) {
			throw failure(err);
		}
		if (!res.ok || !res.body) {
			throw new HttpError(
				502,
				`Real-Debrid transfer failed with HTTP ${res.status}`,
			);
		}

		const reader = res.body.getReader();
		async function* chunks(): AsyncGenerator<Uint8Array> {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				if (!value?.length) continue;
				resetStall();
				written += value.length;
				onBytes(value.length);
				yield value;
			}
		}

		try {
			await pipeline(Readable.from(chunks()), createWriteStream(destination));
		} catch (err) {
			throw failure(err);
		}
	} finally {
		if (stallTimer) clearTimeout(stallTimer);
		controller.abort();
	}
	return written;
}

/** Pulls every file of a finished Real-Debrid torrent into this server's
 * staging directory, mirroring transfer progress onto the job row. On return
 * the job dir looks exactly like a finished qBittorrent download, so the
 * regular importer takes it from there unchanged. */
export async function fetchDebridFiles(
	state: AppState,
	job: TorrentJobRow,
): Promise<void> {
	const { db, settings } = state;
	if (!job.debrid_id) throw new HttpError(500, "job has no Real-Debrid id");

	const info = await rd.torrentInfo(settings.realDebridApiKey, job.debrid_id);
	if (!rd.isDebridReady(info.status)) {
		throw new HttpError(
			409,
			`Real-Debrid torrent is not ready (status "${info.status}")`,
		);
	}

	const plan = planFiles(info);
	const links = info.links ?? [];
	if (!links.length)
		throw new HttpError(
			502,
			"Real-Debrid finished the torrent but returned no links",
		);

	// Checked before pulling gigabytes across the wire rather than after, unlike
	// the qBittorrent path where the bytes are already on the host's disk.
	const owner = db.get<UserRow>("SELECT * FROM users WHERE id = $id", {
		$id: job.owner_id,
	});
	if (!owner) throw new HttpError(404, "torrent owner no longer exists");
	const perm = ensurePermissions(db, owner.id, {
		master: owner.role === "master",
	});
	const totalBytes =
		info.bytes ?? plan?.reduce((sum, f) => sum + f.bytes, 0) ?? 0;
	const used =
		db.get<{ total: number | null }>(
			"SELECT SUM(size_bytes) as total FROM files WHERE owner_id = $id",
			{
				$id: owner.id,
			},
		)?.total ?? 0;
	if (totalBytes && used + totalBytes > perm.quota_bytes) {
		throw new HttpError(413, "torrent would exceed your storage quota");
	}
	const oversized = plan?.find((f) => f.bytes > perm.max_file_bytes);
	if (oversized)
		throw new HttpError(
			413,
			`"${oversized.relPath}" exceeds your max file size`,
		);

	const jobDir = join(debridRoot(), job.tag);
	// A retry re-downloads from scratch: a half-written file from an aborted
	// attempt is indistinguishable from a complete one on disk.
	cleanupDebridDir(job.tag);
	rmSync(completeMarkerPath(job.tag), { force: true });
	mkdirSync(jobDir, { recursive: true });

	let fetched = 0;
	let lastWrite = 0;
	let windowStart = Date.now();
	let windowBytes = 0;
	let speed = 0;

	const publish = (force: boolean) => {
		const now = Date.now();
		if (!force && now - lastWrite < PROGRESS_INTERVAL_MS) return;
		const elapsed = now - windowStart;
		if (elapsed >= PROGRESS_INTERVAL_MS) {
			speed = Math.round((windowBytes / elapsed) * 1000);
			windowStart = now;
			windowBytes = 0;
		}
		lastWrite = now;
		db.run(
			`UPDATE torrent_jobs SET status = 'fetching', progress = $progress, downloaded_bytes = $done,
         size_bytes = $size, dl_speed = $speed, eta_seconds = $eta, updated_at = $now
       WHERE id = $id`,
			{
				$progress: totalBytes ? Math.min(1, fetched / totalBytes) : 0,
				$done: fetched,
				$size: totalBytes || job.size_bytes,
				$speed: speed,
				$eta:
					speed > 0 && totalBytes > fetched
						? Math.round((totalBytes - fetched) / speed)
						: null,
				$now: nowIso(),
				$id: job.id,
			},
		);
	};
	publish(true);

	for (let i = 0; i < links.length; i++) {
		const link = links[i]!;
		// Unrestricted URLs are short-lived, so each one is minted immediately
		// before its own transfer rather than all up front.
		const direct = await rd.unrestrict(settings.realDebridApiKey, link);
		const relPath = plan
			? plan[i]!.relPath
			: relPathFor(direct.filename || `part-${i + 1}.bin`);
		const destination = safeJoin(jobDir, relPath);
		await streamToFile(direct.download, destination, (delta) => {
			fetched += delta;
			windowBytes += delta;
			publish(false);
		});
		publish(true);
	}

	markTransferComplete(job.tag);
	log.info(
		`Real-Debrid transfer finished job_id=${job.id} files=${links.length} bytes=${fetched}`,
	);
}

/** Removes a Real-Debrid job's staging directory. Best-effort. */
export function cleanupDebridDir(tag: string): void {
	if (!tag) return;
	try {
		rmSync(join(debridRoot(), tag), { recursive: true, force: true });
	} catch (err) {
		log.warning(
			`debrid cleanup failed tag=${tag}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Drops the torrent from the Real-Debrid account and clears local staging. */
export async function releaseDebridJob(
	state: AppState,
	job: TorrentJobRow,
): Promise<void> {
	if (job.debrid_id && rd.hasApiKey(state.settings)) {
		await rd.deleteTorrent(state.settings.realDebridApiKey, job.debrid_id);
	}
	cleanupDebridDir(job.tag);
	clearStashedSource(job.tag);
}

export function errText(err: unknown): string {
	if (err instanceof HttpError) return String(err.detail);
	return err instanceof Error ? err.message : String(err);
}
