/**
 * Fills in `content_blobs.media_width/height/duration_seconds`.
 *
 * The columns have existed since the Python lineage but nothing on the upload
 * path ever wrote them, so every row read NULL. The media library is the first
 * consumer that actually needs them (runtimes and resolutions in the collection
 * view), so the probe runs at publish time rather than on every upload: only
 * files someone deliberately put in the library pay for it, and an install
 * without ffmpeg simply gets the old NULLs back.
 *
 * Values live on the *blob*, not the file, so a deduplicated re-upload of the
 * same content inherits the probe for free.
 */

import { existsSync } from "node:fs";
import type { FileRow } from "../db/rows.ts";
import type { Db } from "../db/types.ts";
import { getLogger } from "../logging.ts";
import { safeJoin, storageRoot } from "./paths.ts";

const log = getLogger("app.storage.mediaProbe");

/** ffprobe occasionally hangs on a truncated file; a probe is never worth
 * holding a request open for. */
const PROBE_TIMEOUT_MS = 10_000;

export interface MediaInfo {
	width: number | null;
	height: number | null;
	durationSeconds: number | null;
}

interface FfprobeStream {
	width?: number;
	height?: number;
	duration?: string;
}
interface FfprobeOutput {
	streams?: FfprobeStream[];
	format?: { duration?: string };
}

/** Runs ffprobe. Returns null when the binary is absent or the file isn't
 * media -- ffmpeg is an optional dependency here, same as for thumbnails. */
export async function probeMedia(fullPath: string): Promise<MediaInfo | null> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(
			[
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"stream=width,height,duration:format=duration",
				"-of",
				"json",
				fullPath,
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
	} catch {
		return null; // ffprobe not installed
	}

	const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
	let parsed: FfprobeOutput;
	try {
		const [text, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		if (exitCode !== 0 || !text.trim()) return null;
		parsed = JSON.parse(text) as FfprobeOutput;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}

	// The video stream carries the dimensions; duration can live on either the
	// stream or the container, and audio-only files only have the latter.
	const visual = parsed.streams?.find((s) => s.width && s.height);
	const durationRaw =
		parsed.format?.duration ??
		visual?.duration ??
		parsed.streams?.find((s) => s.duration)?.duration;
	const duration = durationRaw ? Number(durationRaw) : Number.NaN;

	return {
		width: visual?.width ?? null,
		height: visual?.height ?? null,
		durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
	};
}

/** Probes any of `files` whose blob has no media metadata yet, and writes the
 * result to `content_blobs`. Best-effort: a failed probe just leaves NULLs, and
 * an already-probed blob is skipped so republishing is cheap. */
export async function backfillMediaInfo(
	db: Db,
	files: FileRow[],
): Promise<number> {
	let probed = 0;
	for (const f of files) {
		if (!f.blob_id) continue;
		// Only untransformed bytes on disk are probe-able; an encrypted or
		// compressed blob would have to be fully reproduced first, which isn't
		// worth doing inline on a publish request.
		if (f.encryption_mode !== "none" || f.compressed || f.archived) continue;

		const blob = db.get<{ media_duration_seconds: number | null }>(
			"SELECT media_duration_seconds FROM content_blobs WHERE id = $id",
			{ $id: f.blob_id },
		);
		if (!blob || blob.media_duration_seconds !== null) continue;

		let fullPath: string;
		try {
			fullPath = safeJoin(storageRoot(), f.storage_path);
		} catch {
			continue;
		}
		if (!existsSync(fullPath)) continue;

		const info = await probeMedia(fullPath);
		if (!info || info.durationSeconds === null) continue;

		db.run(
			`UPDATE content_blobs
         SET media_width = $w, media_height = $h, media_duration_seconds = $d
       WHERE id = $id`,
			{
				$w: info.width,
				$h: info.height,
				$d: info.durationSeconds,
				$id: f.blob_id,
			},
		);
		probed++;
	}
	if (probed) log.info(`probed media metadata for ${probed} blob(s)`);
	return probed;
}
