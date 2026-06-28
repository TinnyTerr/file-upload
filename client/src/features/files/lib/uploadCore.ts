import { encryptBlob } from "@/workers/aeadClient";
import { randomKey, bytesToBase64Url } from "@/lib/base64url";
import { filesService } from "../services/filesService";
import type { UploadOptions, UploadResult } from "../types";

/** Switch to the resumable chunked endpoint above this ciphertext size. */
const CHUNKED_THRESHOLD = 80 * 1024 * 1024; // 80 MiB
const MAX_CONCURRENT_CHUNKS = 2;
const CHUNK_RETRIES = 3;

export type UploadPhase = "encrypting" | "uploading" | "finalizing";
export interface UploadProgress {
  phase: UploadPhase;
  percent: number;
}

export interface UploadOutcome {
  result: UploadResult;
  /** base64url client key (client mode only) for building the #ek= share URL. */
  clientKeyB64: string | null;
}

interface PerformArgs {
  file: File;
  options: UploadOptions;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** Reuse a fixed client key (e.g. one key for a whole folder bundle). */
  presetKey?: Uint8Array;
}

/**
 * End-to-end upload of a single file: optional client-side encryption, then a
 * single-shot or resumable chunked transfer depending on size.
 */
export async function performUpload({ file, options, onProgress, signal, presetKey }: PerformArgs): Promise<UploadOutcome> {
  let payload: Blob = file;
  let clientKeyB64: string | null = null;

  if (options.encryption_mode === "client") {
    const key = presetKey ?? randomKey();
    payload = await encryptBlob(file, key, (percent) => onProgress?.({ phase: "encrypting", percent }));
    clientKeyB64 = bytesToBase64Url(key);
  }

  const result =
    payload.size >= CHUNKED_THRESHOLD
      ? await chunkedUpload(payload, file, options, onProgress, signal)
      : await filesService.uploadSingle(payload, file.name, options, (percent) => onProgress?.({ phase: "uploading", percent }), signal);

  return { result, clientKeyB64 };
}

async function chunkedUpload(
  payload: Blob,
  file: File,
  options: UploadOptions,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const init = await filesService.chunkedInit(file.name, payload.size, file.type || undefined, options);
  const { upload_id, chunk_size, num_chunks } = init;
  const done = new Set<number>(init.received ?? []);

  const report = () => onProgress?.({ phase: "uploading", percent: Math.round((done.size / num_chunks) * 100) });
  report();

  const pending = Array.from({ length: num_chunks }, (_, i) => i).filter((i) => !done.has(i));
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const index = pending[cursor++];
      const start = index * chunk_size;
      const chunk = payload.slice(start, Math.min(start + chunk_size, payload.size));
      let attempt = 0;
      for (;;) {
        try {
          await filesService.chunkedSend(upload_id, index, chunk, signal);
          break;
        } catch (err) {
          if (signal?.aborted) throw err;
          if (++attempt >= CHUNK_RETRIES) throw err;
          await delay(300 * attempt);
        }
      }
      done.add(index);
      report();
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CHUNKS, pending.length) }, worker));
    onProgress?.({ phase: "finalizing", percent: 100 });
    return await filesService.chunkedFinalize(upload_id);
  } catch (err) {
    // Best-effort cleanup of the partial session unless we were cancelled.
    if (!signal?.aborted) filesService.chunkedAbort(upload_id).catch(() => {});
    throw err;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
