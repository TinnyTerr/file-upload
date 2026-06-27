// Upload engine — ported from app/static/js/files.js (single-shot + chunked with
// localStorage resume + client-side encryption). Framework-agnostic so the React
// page just drives it and renders progress.

import { csrf } from "../../lib/api";
import { clientEncrypt } from "../../lib/crypto";
import { fullShareUrl, type EncMode, type UploadResult } from "../../lib/keys";

export type QueueStatus = "queued" | "uploading" | "done" | "error";

export interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  progress: number;
  result: (UploadResult & { _share_full?: string }) | null;
  error: string | null;
}

export interface UploadOpts {
  maxUsesRaw: string;
  expiresInSec: number | null;
  randomize: boolean;
  encMode: EncMode;
  compress: boolean;
  tempDays: string;
  archDays: string;
  delDays: string;
  directoryId?: number | null;
  sharedClientKey?: Uint8Array | null;
  /** "folder" mode uses webkitRelativePath as the filename. */
  folderMode?: boolean;
}

export function qId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Files at/above this size are uploaded in pieces (Cloudflare rejects bodies over
// ~100 MB before they reach the origin).
const CHUNK_THRESHOLD = 80 * 1024 * 1024; // 80 MiB
const CHUNK_CONCURRENCY = 2;
const CHUNK_RETRIES = 4;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const CHUNK_RESUME_KEY = "fu.chunked.v1";

interface Fields {
  original_filename: string;
  randomize_filename: boolean;
  encryption_mode: EncMode;
  compress: boolean;
  is_permanent: boolean;
  directory_id?: number;
  max_uses?: number;
  expires_in_seconds?: number;
  temp_days?: number;
  archive_after_idle_days?: number;
  delete_if_idle_days?: number;
}

const csrfHeader = (): Record<string, string> => {
  const t = csrf.get();
  return t ? { "X-CSRF-Token": t } : {};
};

async function uploadErr(res: Response): Promise<Error> {
  try {
    const j = await res.json();
    return new Error(j.detail || `Upload failed (${res.status})`);
  } catch {
    return new Error(`Upload failed (${res.status})`);
  }
}

// ── Resumable session bookkeeping (localStorage) ───────────────────────────
function resumeKey(item: QueueItem, fields: Fields): string {
  const f = item.file;
  return [
    fields.original_filename,
    f.size || 0,
    f.lastModified || 0,
    fields.encryption_mode,
    fields.directory_id ?? "",
  ].join("|");
}
function resumeStore(): Record<string, { upload_id: string; total: number; chunk_size: number }> {
  try {
    return JSON.parse(localStorage.getItem(CHUNK_RESUME_KEY) || "null") || {};
  } catch {
    return {};
  }
}
function resumeSave(key: string, session: { upload_id: string; total: number; chunk_size: number }) {
  try {
    const m = resumeStore();
    m[key] = session;
    localStorage.setItem(CHUNK_RESUME_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}
function resumeDrop(key: string) {
  try {
    const m = resumeStore();
    delete m[key];
    localStorage.setItem(CHUNK_RESUME_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (it: T) => Promise<void>) {
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

type OnProgress = (percent: number) => void;

// Whole-file upload in a single multipart POST (small files).
function singleUpload(uploadFile: Blob, fields: Fields, onProgress: OnProgress): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("file", uploadFile, fields.original_filename);
  fd.append("original_filename", fields.original_filename);
  fd.append("randomize_filename", fields.randomize_filename ? "true" : "false");
  fd.append("encryption_mode", String(fields.encryption_mode));
  fd.append("compress", fields.compress ? "true" : "false");
  fd.append("is_permanent", fields.is_permanent ? "true" : "false");
  if (fields.directory_id != null) fd.append("directory_id", String(fields.directory_id));
  if (fields.max_uses) fd.append("max_uses", String(fields.max_uses));
  if (fields.expires_in_seconds) fd.append("expires_in_seconds", String(fields.expires_in_seconds));
  if (fields.temp_days) fd.append("temp_days", String(fields.temp_days));
  if (fields.archive_after_idle_days)
    fd.append("archive_after_idle_days", String(fields.archive_after_idle_days));
  if (fields.delete_if_idle_days) fd.append("delete_if_idle_days", String(fields.delete_if_idle_days));

  const token = csrf.get();
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/files/upload");
    if (token) x.setRequestHeader("X-CSRF-Token", token);
    x.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    x.addEventListener("load", () => {
      if (x.status >= 400) {
        let detail = "Upload failed.";
        try {
          detail = JSON.parse(x.responseText).detail || detail;
        } catch {
          /* ignore */
        }
        return reject(new Error(detail));
      }
      try {
        resolve(JSON.parse(x.responseText));
      } catch {
        resolve({} as UploadResult);
      }
    });
    x.addEventListener("error", () => reject(new Error("Network error.")));
    x.send(fd);
  });
}

// Chunked upload: init (or resume) → upload missing slices in parallel → finalize.
async function chunkedUpload(
  blob: Blob,
  fields: Fields,
  item: QueueItem,
  onProgress: OnProgress,
): Promise<UploadResult> {
  const jsonHeaders = { "Content-Type": "application/json", ...csrfHeader() };
  const canResume = fields.encryption_mode !== "client";
  const key = resumeKey(item, fields);

  let upload_id: string | null = null;
  let chunk_size = 0;
  let num_chunks = 0;
  let received = new Set<number>();

  const saved = canResume ? resumeStore()[key] : null;
  if (saved && saved.upload_id && saved.total === blob.size) {
    try {
      const st = await fetch(
        "/files/upload/status?upload_id=" + encodeURIComponent(saved.upload_id),
        { headers: csrfHeader() },
      );
      if (st.ok) {
        const s = await st.json();
        upload_id = saved.upload_id;
        chunk_size = s.chunk_size;
        num_chunks = s.num_chunks;
        received = new Set(s.received);
      }
    } catch {
      /* ignore */
    }
    if (!upload_id) resumeDrop(key);
  }

  if (!upload_id) {
    const initRes = await fetch("/files/upload/init", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        ...fields,
        total_size: blob.size,
        content_type: blob.type || "application/octet-stream",
      }),
    });
    if (!initRes.ok) throw await uploadErr(initRes);
    const info = await initRes.json();
    upload_id = info.upload_id;
    chunk_size = info.chunk_size;
    num_chunks = info.num_chunks;
    received = new Set(info.received || []);
    if (canResume) resumeSave(key, { upload_id: upload_id!, total: blob.size, chunk_size });
  }

  const chunkLen = (i: number) => Math.min(chunk_size, blob.size - i * chunk_size);
  let doneBytes = 0;
  received.forEach((i) => {
    doneBytes += chunkLen(i);
  });
  const bump = () => onProgress(Math.min(100, Math.round((doneBytes / blob.size) * 100)));
  bump();

  const pending: number[] = [];
  for (let i = 0; i < num_chunks; i++) if (!received.has(i)) pending.push(i);

  const sendChunk = async (i: number) => {
    const slice = blob.slice(i * chunk_size, i * chunk_size + chunkLen(i));
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      try {
        const res = await fetch(
          "/files/upload/chunk?upload_id=" + encodeURIComponent(upload_id!) + "&index=" + i,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", ...csrfHeader() },
            body: slice,
            signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
          },
        );
        if (res.ok) {
          doneBytes += chunkLen(i);
          bump();
          return;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw await uploadErr(res);
        lastErr = await uploadErr(res);
      } catch (e) {
        lastErr = e as Error;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastErr || new Error("Chunk " + i + " failed.");
  };

  await runPool(pending, CHUNK_CONCURRENCY, sendChunk);

  const finRes = await fetch("/files/upload/finalize", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ upload_id }),
  });
  if (!finRes.ok) throw await uploadErr(finRes);
  if (canResume) resumeDrop(key);
  return finRes.json();
}

export interface UploadOutcome {
  result: UploadResult & { _share_full?: string };
  /** True when this is a standalone upload that should pop the success modal. */
  standalone: boolean;
  encMode: EncMode;
  clientKeyBytes: Uint8Array | null;
}

/** Encrypt (if needed), pick single vs chunked, and upload one queue item. */
export async function uploadOne(
  item: QueueItem,
  opts: UploadOpts,
  onProgress: OnProgress,
): Promise<UploadOutcome> {
  let filename = item.file.name;
  if (opts.folderMode && item.file.webkitRelativePath) filename = item.file.webkitRelativePath;

  let uploadFile: Blob = item.file;
  let clientKeyBytes: Uint8Array | null = null;

  if (opts.encMode === "client") {
    const { ciphertext, keyBytes } = await clientEncrypt(item.file, opts.sharedClientKey ?? null);
    uploadFile = new Blob([ciphertext], { type: "application/octet-stream" });
    clientKeyBytes = keyBytes;
  }

  const directoryId = opts.directoryId ?? null;
  const fields: Fields = {
    original_filename: filename,
    randomize_filename: directoryId == null && opts.randomize,
    encryption_mode: opts.encMode,
    compress: !!opts.compress,
    is_permanent: opts.tempDays ? false : true,
  };
  if (directoryId != null) fields.directory_id = Number(directoryId);
  if (opts.maxUsesRaw) fields.max_uses = Number(opts.maxUsesRaw);
  if (opts.expiresInSec) fields.expires_in_seconds = Number(opts.expiresInSec);
  if (opts.tempDays) fields.temp_days = Number(opts.tempDays);
  if (opts.archDays) fields.archive_after_idle_days = Number(opts.archDays);
  if (opts.delDays) fields.delete_if_idle_days = Number(opts.delDays);

  const result: UploadResult & { _share_full?: string } =
    uploadFile.size > CHUNK_THRESHOLD
      ? await chunkedUpload(uploadFile, fields, item, onProgress)
      : await singleUpload(uploadFile, fields, onProgress);

  result._share_full = fullShareUrl(result, opts.encMode, clientKeyBytes);
  return { result, standalone: directoryId == null, encMode: opts.encMode, clientKeyBytes };
}
