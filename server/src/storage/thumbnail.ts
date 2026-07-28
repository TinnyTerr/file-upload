import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import sharp, { type Sharp } from "sharp";
import { thumbnailRoot, safeJoin } from "./paths.ts";
import { getLogger } from "../logging.ts";

const log = getLogger("app.thumbnail");

/** Cap so og:image always clears Discord/Slack/Twitter's crawler fetch limits (~8MB),
 * regardless of how large the original file is. */
const MAX_DIMENSION = 1200;
const JPEG_QUALITY = 78;
const VIDEO_SEEK_SECONDS = ["00:00:01", "00:00:00"];

function playButtonOverlaySvg(width: number, height: number): Buffer {
  const r = Math.round(Math.min(width, height) * 0.18);
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const t = r * 0.55;
  const p1 = `${cx - t * 0.5},${cy - t}`;
  const p2 = `${cx - t * 0.5},${cy + t}`;
  const p3 = `${cx + t},${cy}`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="black" fill-opacity="0.55"/>` +
      `<polygon points="${p1} ${p2} ${p3}" fill="white"/>` +
      `</svg>`,
  );
}

async function extractVideoFrame(fullPath: string): Promise<Buffer | null> {
  for (const ss of VIDEO_SEEK_SECONDS) {
    const proc = Bun.spawn(
      ["ffmpeg", "-y", "-ss", ss, "-i", fullPath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [buf, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    if (exitCode === 0 && buf.byteLength > 0) return Buffer.from(buf);
  }
  return null;
}

function thumbnailPath(fileId: number): string {
  return safeJoin(thumbnailRoot(), `${fileId}.jpg`);
}

/** Reachable unauthenticated via /file/:slug/thumbnail with no per-file rate
 * limit, so N concurrent requests for the same uncached video/image would
 * otherwise spawn N ffmpeg processes / sharp pipelines. Callers piling on
 * while a generation is already running for `fileId` get the same promise
 * instead of kicking off their own. */
const inFlight = new Map<number, Promise<string | null>>();

async function generateThumbnail(fileId: number, fullPath: string, contentType: string, out: string): Promise<string | null> {
  const isVideo = contentType.startsWith("video/");
  const isImage = contentType.startsWith("image/");
  if (!isVideo && !isImage) return null;

  try {
    let pipeline: Sharp;
    if (isVideo) {
      const frame = await extractVideoFrame(fullPath);
      if (!frame) return null;
      pipeline = sharp(frame);
    } else {
      pipeline = sharp(fullPath);
    }

    const resized = await pipeline
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });

    let finalBuffer: Buffer;
    if (isVideo) {
      const overlay = playButtonOverlaySvg(resized.info.width, resized.info.height);
      finalBuffer = await sharp(resized.data)
        .composite([{ input: overlay, top: 0, left: 0 }])
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
    } else {
      finalBuffer = await sharp(resized.data).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    }

    mkdirSync(thumbnailRoot(), { recursive: true });
    await writeFile(out, finalBuffer);
    return out;
  } catch (err) {
    log.warning(`thumbnail generation failed file_id=${fileId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Generates (and caches on disk) a small JPEG thumbnail for a file, resized to
 * fit within MAX_DIMENSION and re-encoded so it always clears social-preview
 * size limits. Videos get a play-button overlay burned into the extracted frame
 * so the static preview still reads as "this is a video". Returns null if no
 * thumbnail could be produced (unsupported/corrupt media). */
export async function getOrCreateThumbnail(fileId: number, fullPath: string, contentType: string): Promise<string | null> {
  const out = thumbnailPath(fileId);
  if (existsSync(out)) return out;

  const running = inFlight.get(fileId);
  if (running) return running;

  const promise = generateThumbnail(fileId, fullPath, contentType, out).finally(() => {
    inFlight.delete(fileId);
  });
  inFlight.set(fileId, promise);
  return promise;
}

/** Best-effort cleanup when a file row is deleted -- otherwise
 * data/thumbnails/ grows forever. Safe to call even if no thumbnail was ever
 * generated for this file. */
export function deleteThumbnail(fileId: number): void {
  try {
    unlinkSync(thumbnailPath(fileId));
  } catch {
    // no thumbnail existed -- nothing to clean up
  }
}
