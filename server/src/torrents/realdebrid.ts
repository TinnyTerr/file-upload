import type { Settings } from "../config.ts";
import { getLogger } from "../logging.ts";

const log = getLogger("app.torrents.realdebrid");

/** Real-Debrid REST API 1.0 client (https://api.real-debrid.com/).
 *
 * Real-Debrid is the *preferred* torrent backend: a magnet handed to
 * `addMagnet` is downloaded by Real-Debrid's own seedbox whether or not it is
 * already cached there, and this server then pulls the finished files over
 * plain HTTPS. qBittorrent is only the fallback for when there is no token,
 * the token is rejected, or a job dies on Real-Debrid's side.
 *
 * Every failure surfaces as a `RealDebridError`, which callers use to decide
 * between "fall back to qBittorrent" and "tell the user". */

const API_BASE = "https://api.real-debrid.com/rest/1.0";
const TIMEOUT_MS = 30_000;

/** Torrent lifecycle values Real-Debrid reports on GET /torrents/info/{id}. */
export type DebridTorrentStatus =
  | "magnet_error"
  | "magnet_conversion"
  | "waiting_files_selection"
  | "queued"
  | "downloading"
  | "downloaded"
  | "error"
  | "virus"
  | "compressing"
  | "uploading"
  | "dead";

/** Terminal Real-Debrid states that mean the job will never produce files. */
const DEAD_STATUSES = new Set<string>(["magnet_error", "error", "virus", "dead"]);

/** States where the torrent is finished on Real-Debrid's side and `links` is
 * populated. `uploading`/`compressing` are Real-Debrid packaging the result --
 * still "in progress" for us. */
export function isDebridDead(status: string): boolean {
  return DEAD_STATUSES.has(status);
}

export function isDebridReady(status: string): boolean {
  return status === "downloaded";
}

export interface DebridTorrentFile {
  id: number;
  /** Path inside the torrent, always leading-slash prefixed, e.g. "/Show/ep1.mkv". */
  path: string;
  bytes: number;
  /** 1 when the file is part of the download. */
  selected: number;
}

export interface DebridTorrentInfo {
  id: string;
  filename: string;
  original_filename?: string;
  hash: string;
  bytes: number;
  original_bytes?: number;
  host?: string;
  split?: number;
  /** 0..100. */
  progress: number;
  status: DebridTorrentStatus | string;
  added?: string;
  files?: DebridTorrentFile[];
  /** One restricted link per *selected* file, in file order. */
  links?: string[];
  ended?: string;
  /** Bytes/second, only present while downloading. */
  speed?: number;
  seeders?: number;
}

export interface DebridUser {
  id: number;
  username: string;
  email?: string;
  points?: number;
  locale?: string;
  avatar?: string;
  /** "premium" | "free" */
  type: string;
  /** Seconds of premium left. */
  premium: number;
  expiration?: string;
}

export interface DebridUnrestricted {
  id: string;
  filename: string;
  filesize: number;
  /** The original restricted link. */
  link: string;
  host?: string;
  chunks?: number;
  crc?: number;
  /** The direct, fetchable URL. */
  download: string;
  mimeType?: string;
  streamable?: number;
}

/** A Real-Debrid API or transport failure.
 *
 * `authFailed` marks the "your token is no good" family (HTTP 401, or the
 * `bad token` / `permission denied` error codes), which the admin panel
 * reports as an invalid key rather than a transient outage. */
export class RealDebridError extends Error {
  readonly status: number;
  readonly errorCode: number | null;
  readonly authFailed: boolean;

  constructor(message: string, status: number, errorCode: number | null) {
    super(message);
    this.name = "RealDebridError";
    this.status = status;
    this.errorCode = errorCode;
    // 8 = bad token, 9 = permission denied, 12 = login failure, 13 = too many
    // sessions, 14 = account locked, 22 = IP not allowed.
    this.authFailed = status === 401 || (errorCode !== null && [8, 9, 12, 13, 14, 22].includes(errorCode));
  }
}

/** Real-Debrid's documented error_code table, for the codes worth naming. */
const ERROR_MESSAGES: Record<number, string> = {
  [-1]: "internal error",
  1: "missing parameter",
  2: "bad parameter value",
  3: "unknown method",
  4: "method not allowed",
  5: "slow down — too many requests",
  7: "unknown resource",
  8: "bad token (expired or invalid)",
  9: "permission denied",
  11: "action already done",
  14: "account locked",
  20: "torrent too big",
  21: "torrent file invalid",
  22: "action already done",
  23: "traffic exhausted",
  24: "file unavailable",
  25: "service unavailable",
  32: "infringing file",
  33: "fair-usage limit reached",
  34: "disabled endpoint",
  35: "torrent not found",
  36: "fair-usage limit",
  37: "disabled endpoint",
};

export function isConfigured(settings: Settings): boolean {
  return settings.realDebridEnabled && !!settings.realDebridApiKey;
}

/** Whether a token is present at all, ignoring the enable toggle. */
export function hasApiKey(settings: Settings): boolean {
  return !!settings.realDebridApiKey;
}

interface CallOpts {
  method?: string;
  /** Form-encoded POST body. */
  form?: Record<string, string>;
  /** Raw request body (PUT /torrents/addTorrent takes the metainfo verbatim). */
  raw?: Uint8Array;
  timeoutMs?: number;
}

/** Issues an authenticated request and normalizes every failure mode --
 * network, non-2xx, and Real-Debrid's `{error, error_code}` envelope -- into
 * `RealDebridError`. Returns `null` for 204/empty bodies. */
async function call<T>(apiKey: string, path: string, opts: CallOpts = {}): Promise<T | null> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: string | ArrayBuffer | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.raw) {
    headers["Content-Type"] = "application/x-bittorrent";
    // Copy into a fresh ArrayBuffer-backed view: a Buffer slice can be a view
    // onto a larger pooled allocation, which fetch would send in full.
    body = new Uint8Array(opts.raw).buffer as ArrayBuffer;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    throw new RealDebridError(
      `could not reach Real-Debrid: ${err instanceof Error ? err.message : String(err)}`,
      502,
      null,
    );
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const envelope = (parsed ?? {}) as { error?: string; error_code?: number; error_details?: string };
    const code = typeof envelope.error_code === "number" ? envelope.error_code : null;
    const detail =
      (code !== null ? ERROR_MESSAGES[code] : undefined) ??
      envelope.error ??
      envelope.error_details ??
      text.slice(0, 200) ??
      "";
    throw new RealDebridError(
      `Real-Debrid returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      code,
    );
  }

  return (parsed as T) ?? null;
}

/** Account probe -- the admin panel's key validation and status card. */
export async function user(apiKey: string): Promise<DebridUser> {
  const result = await call<DebridUser>(apiKey, "/user");
  if (!result) throw new RealDebridError("Real-Debrid returned an empty account response", 502, null);
  return result;
}

export interface DebridAdded {
  id: string;
  uri: string;
}

export async function addMagnet(apiKey: string, magnet: string): Promise<DebridAdded> {
  const result = await call<DebridAdded>(apiKey, "/torrents/addMagnet", { form: { magnet } });
  if (!result?.id) throw new RealDebridError("Real-Debrid did not return a torrent id", 502, null);
  return result;
}

/** PUT /torrents/addTorrent takes the .torrent metainfo as the raw body. */
export async function addTorrentFile(apiKey: string, bytes: Uint8Array): Promise<DebridAdded> {
  const result = await call<DebridAdded>(apiKey, "/torrents/addTorrent", { method: "PUT", raw: bytes });
  if (!result?.id) throw new RealDebridError("Real-Debrid did not return a torrent id", 502, null);
  return result;
}

/** Selects every file in the torrent. Real-Debrid parks a freshly added
 * torrent in `waiting_files_selection` and does not start downloading until
 * this lands. 202 ("already done") is not an error for us. */
export async function selectAllFiles(apiKey: string, torrentId: string): Promise<void> {
  try {
    await call(apiKey, `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, { form: { files: "all" } });
  } catch (err) {
    if (err instanceof RealDebridError && (err.status === 202 || err.errorCode === 11)) return;
    throw err;
  }
}

export async function torrentInfo(apiKey: string, torrentId: string): Promise<DebridTorrentInfo> {
  const result = await call<DebridTorrentInfo>(apiKey, `/torrents/info/${encodeURIComponent(torrentId)}`);
  if (!result) throw new RealDebridError("Real-Debrid returned an empty torrent info response", 502, null);
  return result;
}

/** Removes the torrent from the account. Best-effort: an orphaned Real-Debrid
 * entry is cosmetic, and the job outcome must not hinge on cleanup. */
export async function deleteTorrent(apiKey: string, torrentId: string): Promise<void> {
  try {
    await call(apiKey, `/torrents/delete/${encodeURIComponent(torrentId)}`, { method: "DELETE" });
  } catch (err) {
    log.warning(`Real-Debrid delete failed id=${torrentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Turns one of `info.links[]` into a direct, fetchable URL. The restricted
 * link is not downloadable on its own -- it has to be unrestricted first, and
 * the resulting URL is short-lived, so this runs immediately before the fetch. */
export async function unrestrict(apiKey: string, link: string): Promise<DebridUnrestricted> {
  const result = await call<DebridUnrestricted>(apiKey, "/unrestrict/link", { form: { link } });
  if (!result?.download) throw new RealDebridError("Real-Debrid did not return a download URL", 502, null);
  return result;
}
