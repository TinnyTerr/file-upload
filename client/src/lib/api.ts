// Core API client + storage helpers. Ported from app/static/js/api.js
// (DOM/toast/dialog helpers moved into React providers).

const CSRF_KEY = "fu_csrf";
const USER_KEY = "fu_user";

export interface User {
  id?: number;
  username: string;
  role: "master" | "user" | string;
  must_change_credentials?: boolean;
  can_upload?: boolean;
  can_upload_client_encrypted?: boolean;
  can_regenerate_links?: boolean;
  can_use_api_keys?: boolean;
  can_delete?: boolean;
  can_delete_links?: boolean;
  can_create_directories?: boolean;
  can_manage_lifecycle?: boolean;
  can_use_p2p?: boolean;
  can_view_admin?: boolean;
  can_manage_users?: boolean;
  can_manage_storage?: boolean;
  can_manage_api_keys?: boolean;
  quota_bytes?: number | null;
  max_file_bytes?: number | null;
  [k: string]: unknown;
}

export const csrf = {
  get: (): string => localStorage.getItem(CSRF_KEY) || "",
  set: (t: string) => localStorage.setItem(CSRF_KEY, t),
  clear: () => localStorage.removeItem(CSRF_KEY),
};

export const user = {
  get: (): User | null => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  },
  set: (u: User) => localStorage.setItem(USER_KEY, JSON.stringify(u)),
  clear: () => localStorage.removeItem(USER_KEY),
};

export function isLoggedIn(): boolean {
  return !!csrf.get();
}

export interface ApiOpts extends Omit<RequestInit, "body"> {
  json?: unknown;
  body?: BodyInit | null;
}

/** Error carrying the HTTP status so callers can branch on 401/409/429 etc. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Pull a FastAPI `{detail}` message off a failed response, falling back. */
export async function readDetail(resp: Response, fallback = "Request failed."): Promise<string> {
  try {
    const d = await resp.json();
    return (d && (d.detail as string)) || fallback;
  } catch {
    return fallback;
  }
}

/** Throw an {@link ApiError} when a response is not ok. */
export async function ensureOk(resp: Response, fallback?: string): Promise<Response> {
  if (!resp.ok) throw new ApiError(resp.status, await readDetail(resp, fallback));
  return resp;
}

export async function apiFetch(url: string, opts: ApiOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const token = csrf.get();
    if (token) headers["X-CSRF-Token"] = token;
  }
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const { json: _json, ...rest } = opts;
  void _json;
  return fetch(url, { ...rest, method, headers, body, credentials: "same-origin" });
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString();
}

/** Parse "10GB", "500 MB", "2.5tb" → bytes, or null on failure */
export function parseSize(str: string | null | undefined): number | null {
  if (!str || !str.trim()) return null;
  const s = str.trim().toUpperCase().replace(/\s+/g, "").replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n) || n < 0) return null;
  const mult: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1048576,
    GB: 1073741824,
    TB: 1099511627776,
  };
  return Math.round(n * (mult[m[2] || "B"] || 1));
}

/** Parse "30s", "5m", "24h", "7d", "2w", or plain number (seconds) → seconds, or null */
export function parseDuration(str: string | null | undefined): number | null {
  if (!str || !str.trim()) return null;
  const s = str.trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^([\d.]+)(s|m|h|d|w)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n) || n <= 0) return null;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.round(n * mult[m[2]]);
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  csrf.clear();
  user.clear();
}
