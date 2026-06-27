// Base64url codec + share-URL builders. Ported from app/static/js/files.js.
//
// Encryption key transport — preserved exactly from the original:
//   · client mode → "#ek=" URL *fragment*  (never sent to the server)
//   · server mode → "?ek=" query credential (the server's access gate)

export type EncMode = "none" | "client" | "server" | string;

export function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function b64urlDecodeBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Extract the raw ek value from a pasted full URL, "#ek=..." or bare key. */
export function extractEk(value: string): string {
  const text = (value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.hash.startsWith("#ek=")) return decodeURIComponent(url.hash.slice(4));
  } catch {
    /* not a URL */
  }
  const match = text.match(/(?:^|[#?&])ek=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : text.replace(/^#?ek=/, "");
}

/** Decode + validate a 32-byte client key from a pasted value; null if invalid. */
export function decodeKeyBytes(value: string): Uint8Array | null {
  try {
    const key = b64urlDecodeBytes(extractEk(value));
    if (key.length !== 32) return null;
    return key;
  } catch {
    return null;
  }
}

export interface UploadResult {
  url?: string;
  share_url?: string;
  access_key?: string;
  slug?: string;
  encryption_mode?: EncMode;
  original_filename?: string;
  [k: string]: unknown;
}

/** Complete shareable URL for a single uploaded file, including its key. */
export function fullShareUrl(
  result: UploadResult,
  encMode: EncMode,
  clientKeyBytes?: Uint8Array | null,
): string {
  let url = result.url || result.share_url || "";
  if (encMode === "client" && clientKeyBytes) {
    url += "#ek=" + b64urlEncode(clientKeyBytes);
  } else if (encMode === "server" && result.access_key) {
    url += "?ek=" + encodeURIComponent(result.access_key);
  }
  return url;
}

export interface DirShare {
  url: string;
  access_key?: string;
}

/** Complete shareable URL for a directory, including its key. */
export function directoryShareUrl(
  dir: DirShare,
  encMode: EncMode,
  sharedKeyBytes?: Uint8Array | null,
): string {
  let url = dir.url;
  if (encMode === "client" && sharedKeyBytes) url += "#ek=" + b64urlEncode(sharedKeyBytes);
  else if (encMode === "server" && dir.access_key)
    url += "?ek=" + encodeURIComponent(dir.access_key);
  return url;
}

/** Full share URL for a link row. Server-mode keys are recoverable (?ek=); client
 *  keys are not, so the base URL is returned. */
export function linkUrlWithKey(
  slug: string,
  f?: { encryption_mode?: EncMode; access_key?: string } | null,
): string {
  const base = `${location.origin}/file/${slug}`;
  if (f && f.encryption_mode === "server" && f.access_key) {
    return base + "?ek=" + encodeURIComponent(f.access_key);
  }
  return base;
}
