import type { Settings } from "../config.ts";
import { HttpError } from "../httpError.ts";
import { getLogger } from "../logging.ts";

const log = getLogger("app.torrents.qbittorrent");

/** Minimal qBittorrent WebUI API v2 client (qBittorrent >= 4.1).
 * Auth is a session cookie (SID) obtained from /api/v2/auth/login; it is
 * cached in-process and silently re-established when the server expires it. */

export interface QbitTorrent {
  hash: string;
  name: string;
  /** downloading | stalledDL | metaDL | uploading | stalledUP | pausedUP | error | ... */
  state: string;
  progress: number;
  size: number;
  completed: number;
  dlspeed: number;
  eta: number;
  /** Path to the torrent's root file/folder, as qBittorrent sees it. */
  content_path: string;
  save_path: string;
  tags: string;
}

/** qBittorrent states that mean "all wanted data is on disk". */
const DONE_STATES = new Set([
  "uploading",
  "stalledUP",
  "pausedUP",
  "stoppedUP",
  "queuedUP",
  "forcedUP",
  "checkingUP",
]);

const ERROR_STATES = new Set(["error", "missingFiles"]);

export function isDoneState(state: string): boolean {
  return DONE_STATES.has(state);
}

export function isErrorState(state: string): boolean {
  return ERROR_STATES.has(state);
}

export function isConfigured(settings: Settings): boolean {
  return !!settings.qbittorrentUrl && !!settings.qbittorrentSavePath;
}

/** Throws the 503 the routes surface when the host has no qBittorrent wired up. */
export function requireConfigured(settings: Settings): void {
  if (!isConfigured(settings)) {
    throw new HttpError(503, "torrenting is not configured on this server");
  }
}

let sid: string | null = null;
let sidUrl = "";

async function login(settings: Settings): Promise<string> {
  const body = new URLSearchParams({
    username: settings.qbittorrentUsername,
    password: settings.qbittorrentPassword,
  });
  let res: Response;
  try {
    res = await fetch(`${settings.qbittorrentUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: settings.qbittorrentUrl },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new HttpError(502, `could not reach qBittorrent: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = (await res.text()).trim();
  if (!res.ok || text.toLowerCase().startsWith("fails")) {
    throw new HttpError(502, "qBittorrent rejected the configured credentials");
  }
  // qBittorrent skips the cookie entirely when the client IP is whitelisted
  // for bypassed auth -- an empty SID is fine there, requests just work.
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /SID=([^;]+)/.exec(setCookie);
  sid = match ? match[1]! : "";
  sidUrl = settings.qbittorrentUrl;
  return sid;
}

async function currentSid(settings: Settings): Promise<string> {
  if (sid !== null && sidUrl === settings.qbittorrentUrl) return sid;
  return login(settings);
}

/** Issues a request with the cached SID, re-logging-in once on 401/403. */
async function call(settings: Settings, path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  requireConfigured(settings);
  const token = await currentSid(settings);
  const headers = new Headers(init.headers);
  headers.set("Referer", settings.qbittorrentUrl);
  if (token) headers.set("Cookie", `SID=${token}`);

  let res: Response;
  try {
    res = await fetch(`${settings.qbittorrentUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new HttpError(502, `could not reach qBittorrent: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ((res.status === 401 || res.status === 403) && retry) {
    sid = null;
    return call(settings, path, init, false);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new HttpError(502, `qBittorrent returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

/** Version probe -- used by the admin connectivity check. */
export async function appVersion(settings: Settings): Promise<string> {
  const res = await call(settings, "/api/v2/app/version");
  return (await res.text()).trim();
}

export interface AddTorrentOpts {
  /** Magnet URI or http(s) .torrent URL. Mutually exclusive with `file`. */
  url?: string;
  /** Raw .torrent bytes. */
  file?: { filename: string; bytes: Buffer };
  /** Download location, as qBittorrent sees it. */
  savePath: string;
  /** Per-job tag the poller uses to find this torrent again. */
  tag: string;
}

export async function addTorrent(settings: Settings, opts: AddTorrentOpts): Promise<void> {
  const form = new FormData();
  if (opts.url) form.append("urls", opts.url);
  if (opts.file) {
    form.append("torrents", new Blob([new Uint8Array(opts.file.bytes)], { type: "application/x-bittorrent" }), opts.file.filename);
  }
  form.append("savepath", opts.savePath);
  form.append("tags", opts.tag);
  // Explicit save path only works with automatic torrent management off.
  form.append("autoTMM", "false");
  form.append("paused", "false");
  form.append("stopped", "false");

  const res = await call(settings, "/api/v2/torrents/add", { method: "POST", body: form });
  const text = (await res.text()).trim();
  if (text && text.toLowerCase() !== "ok.") {
    throw new HttpError(400, `qBittorrent rejected the torrent: ${text.slice(0, 200)}`);
  }
}

/** Every torrent qBittorrent knows about, in one request. The poller groups
 * these by tag itself rather than issuing one tag-filtered request per job. */
export async function allTorrents(settings: Settings): Promise<QbitTorrent[]> {
  const res = await call(settings, "/api/v2/torrents/info");
  return (await res.json()) as QbitTorrent[];
}

/** Maps each `fu-` job tag to its torrent, from a single list fetch. */
export function byTag(torrents: QbitTorrent[]): Map<string, QbitTorrent> {
  const out = new Map<string, QbitTorrent>();
  for (const t of torrents) {
    for (const raw of (t.tags ?? "").split(",")) {
      const tag = raw.trim();
      if (tag) out.set(tag, t);
    }
  }
  return out;
}

export async function deleteTorrent(settings: Settings, hash: string, deleteFiles: boolean): Promise<void> {
  const body = new URLSearchParams({ hashes: hash, deleteFiles: deleteFiles ? "true" : "false" });
  await call(settings, "/api/v2/torrents/delete", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }).catch((err) => {
    // Cleanup is best-effort: the job outcome shouldn't hinge on it.
    log.warning(`qBittorrent delete failed hash=${hash}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Extracts the v1 info hash from a magnet URI, if present. */
export function infoHashFromMagnet(magnet: string): string | null {
  const match = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet);
  return match ? match[1]!.toLowerCase() : null;
}
