import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Single-shot AES-256-GCM for small secrets (TOTP seeds, ~20 bytes) --
 * unlike aead.ts this isn't chunked/streamed, since these blobs are tiny.
 * Layout: version(1B) | nonce(12B) | ciphertext | tag(16B). */

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export function sealSecret(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, tag]);
}

export function openSecret(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < 1 + NONCE_LEN + TAG_LEN || blob[0] !== VERSION) {
    throw new Error("invalid secret blob");
  }
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(1 + NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
