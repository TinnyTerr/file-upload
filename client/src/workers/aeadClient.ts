import type { AeadRequest, AeadResponse } from "./aeadTypes";

/**
 * Main-thread client for the AEAD worker. Keeps a single worker alive and
 * multiplexes requests by id, surfacing per-operation progress.
 */

type Pending = {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
  onProgress?: (percent: number) => void;
};

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let counter = 0;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./aead.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<AeadResponse>) => {
    const msg = e.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === "progress") {
      entry.onProgress?.(msg.percent);
    } else if (msg.type === "result") {
      pending.delete(msg.id);
      entry.resolve(msg.blob);
    } else {
      pending.delete(msg.id);
      entry.reject(new Error(msg.message));
    }
  };
  worker.onerror = (e) => {
    for (const [, entry] of pending) entry.reject(new Error(e.message || "worker error"));
    pending.clear();
  };
  return worker;
}

function run(
  type: AeadRequest["type"],
  blob: Blob,
  key: Uint8Array,
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const w = ensureWorker();
  const id = ++counter;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ type, id, blob, key } satisfies AeadRequest);
  });
}

/** Encrypt a blob into FUPL v1 ciphertext. */
export function encryptBlob(blob: Blob, key: Uint8Array, onProgress?: (p: number) => void) {
  return run("encrypt", blob, key, onProgress);
}

/** Decrypt a FUPL v1 blob back to plaintext. */
export function decryptBlob(blob: Blob, key: Uint8Array, onProgress?: (p: number) => void) {
  return run("decrypt", blob, key, onProgress);
}
