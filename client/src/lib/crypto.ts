// Thin Promise wrapper around the FUPL AEAD worker. The worker (verbatim from the
// original) does AES-256-GCM chunked encrypt/decrypt off the main thread.

import AeadWorker from "../workers/aead-worker.js?worker";

type ProgressCb = (percent: number) => void;

function spawn(): Worker {
  // Vite bundles the worker; the script uses global `self`, no ES imports.
  return new AeadWorker();
}

export interface EncryptResult {
  ciphertext: ArrayBuffer;
  keyBytes: Uint8Array;
}

/**
 * Encrypt a File/Blob client-side. A provided `key` encrypts every member of a
 * folder bundle with one shared key; omit it for a fresh per-file key.
 */
export function clientEncrypt(
  file: Blob,
  key: Uint8Array | null = null,
  onProgress?: ProgressCb,
): Promise<EncryptResult> {
  return new Promise((resolve, reject) => {
    const worker = spawn();
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "encryption worker error"));
    };
    const reader = new FileReader();
    reader.onerror = () => {
      worker.terminate();
      reject(new Error("could not read file for encryption"));
    };
    reader.onload = (e) => {
      const buf = e.target!.result as ArrayBuffer;
      worker.postMessage({ type: "encrypt", plaintext: buf, key }, [buf]);
    };
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === "progress") onProgress?.(d.percent);
      else if (d.type === "encrypted") {
        resolve({ ciphertext: d.ciphertext, keyBytes: d.keyBytes });
        worker.terminate();
      } else if (d.type === "error") {
        reject(new Error(d.message));
        worker.terminate();
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Decrypt a FUPL ciphertext buffer with a 32-byte key. */
export function clientDecrypt(
  ciphertext: ArrayBuffer,
  keyBytes: Uint8Array,
  onProgress?: ProgressCb,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = spawn();
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "decryption worker error"));
    };
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === "progress") onProgress?.(d.percent);
      else if (d.type === "decrypted") {
        resolve(d.plaintext);
        worker.terminate();
      } else if (d.type === "error") {
        reject(new Error(d.message));
        worker.terminate();
      }
    };
    worker.postMessage({ type: "decrypt", ciphertext, key: keyBytes }, [ciphertext]);
  });
}

/** Trigger a browser download of a Blob (anchor must be in DOM for Firefox). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
