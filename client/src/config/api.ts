/**
 * Central HTTP client. Every request is same-origin with the session cookie;
 * mutations carry the CSRF token the backend returned at login. Errors are
 * normalized into ApiError carrying the backend's `detail` payload.
 */

const CSRF_STORAGE_KEY = "fu_csrf_token";

export function getCsrfToken(): string | null {
  return localStorage.getItem(CSRF_STORAGE_KEY);
}

export function setCsrfToken(token: string | null) {
  if (token) localStorage.setItem(CSRF_STORAGE_KEY, token);
  else localStorage.removeItem(CSRF_STORAGE_KEY);
}

export type ErrorDetail = string | Record<string, unknown>;

export class ApiError extends Error {
  status: number;
  detail: ErrorDetail;
  constructor(status: number, detail: ErrorDetail) {
    super(typeof detail === "string" ? detail : (detail?.error as string) ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** JSON body — serialized automatically. */
  json?: unknown;
  /** Raw body (FormData, Blob, ArrayBuffer...) sent as-is. */
  body?: BodyInit | null;
  /** Query parameters appended to the URL. */
  query?: Record<string, string | number | boolean | null | undefined>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseError(res: Response): Promise<ApiError> {
  let detail: ErrorDetail = res.statusText || `HTTP ${res.status}`;
  try {
    const data = await res.json();
    if (data && typeof data === "object" && "detail" in data) detail = data.detail as ErrorDetail;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, detail);
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { json, body, query, headers, ...rest } = opts;
  const finalHeaders = new Headers(headers);

  let finalBody: BodyInit | null | undefined = body;
  if (json !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
    finalBody = JSON.stringify(json);
  }
  if (MUTATING.has(method)) {
    const token = getCsrfToken();
    if (token) finalHeaders.set("X-CSRF-Token", token);
  }

  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: "same-origin",
    headers: finalHeaders,
    body: finalBody,
    ...rest,
  });

  if (!res.ok) throw await parseError(res);

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts),
  post: <T>(path: string, opts?: RequestOptions) => request<T>("POST", path, opts),
  patch: <T>(path: string, opts?: RequestOptions) => request<T>("PATCH", path, opts),
  put: <T>(path: string, opts?: RequestOptions) => request<T>("PUT", path, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, opts),
  raw: request,
};

/** Human-friendly message from any thrown error. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.detail === "string") return err.detail;
    if (err.detail && typeof err.detail === "object") {
      const d = err.detail as Record<string, unknown>;
      if (typeof d.error === "string") return d.error;
      return JSON.stringify(d);
    }
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
