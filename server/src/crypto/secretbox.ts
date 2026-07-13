import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Mirrors app/security/secretbox.py: AES-256-GCM with a fresh 12-byte IV per
 * call, blob layout iv || ciphertext || tag. Used for enc_key_blob /
 * enc_access_blob fields and sealed chunk/dropbox upload tokens. */

export const IV_LEN = 12;
const TAG_LEN = 16;

export function seal(key: Buffer, plaintext: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad.length) cipher.setAAD(aad);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function openBox(key: Buffer, blob: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("invalid box");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
