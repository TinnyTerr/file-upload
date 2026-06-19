// FUPL chunked AEAD worker — same wire format as app/crypto/aead.py
//
// Message protocol (encrypt):
//   postMessage({ type: "encrypt", plaintext: ArrayBuffer, key: Uint8Array | null })
//   → { type: "progress", percent: number }  (zero or more)
//   → { type: "encrypted", ciphertext: ArrayBuffer, keyBytes: Uint8Array }
//
// Message protocol (decrypt):
//   postMessage({ type: "decrypt", ciphertext: ArrayBuffer, key: Uint8Array })
//   → { type: "progress", percent: number }  (zero or more)
//   → { type: "decrypted", plaintext: ArrayBuffer }
//     or { type: "error", message: string }
//
// Wire format (FUPL v1):
//   Header (21 bytes): b"FUPL" (4) | version 0x01 (1) | base_nonce (12) | total_chunk_count uint32_be (4)
//   Per chunk:         ciphertext || 16-byte GCM tag
//   Plaintext chunk size: 2 MiB
//   Per-chunk nonce:  base_nonce XOR (0x00×7 || uint32_be(idx) || flag_byte)
//   Per-chunk AAD:    0x00×16 || uint32_be(idx) || flag_byte  (21 bytes)
//   flag_byte: 0x00 for non-last chunks, 0x01 for last chunk
'use strict';

const MAGIC = new Uint8Array([0x46, 0x55, 0x50, 0x4C]); // b"FUPL"
const VERSION = 0x01;
const PLAINTEXT_CHUNK = 2 * 1024 * 1024; // 2 MiB

/**
 * Compute per-chunk nonce: base_nonce XOR (0x00×7 || uint32_be(idx) || flag_byte)
 * Matches Python: delta = b"\x00" * 7 + struct.pack(">I", idx) + bytes([flag])
 *
 * @param {Uint8Array} base - 12-byte base nonce
 * @param {number} idx      - chunk index (0-based)
 * @param {boolean} isLast  - whether this is the final chunk
 * @returns {Uint8Array} 12-byte per-chunk nonce
 */
function xorNonce(base, idx, isLast) {
  const result = new Uint8Array(12);
  // delta is all zeros except bytes 7-10 (uint32_be idx) and byte 11 (flag)
  const delta = new Uint8Array(12); // initialised to zero
  const view = new DataView(delta.buffer);
  view.setUint32(7, idx, false); // big-endian at offset 7 → bytes [7,8,9,10]
  delta[11] = isLast ? 0x01 : 0x00;
  for (let i = 0; i < 12; i++) {
    result[i] = base[i] ^ delta[i];
  }
  return result;
}

/**
 * Build per-chunk AAD: 0x00×16 || uint32_be(idx) || flag_byte  (21 bytes total)
 * Matches Python: b"\x00" * 16 + struct.pack(">I", idx) + bytes([flag])
 *
 * @param {number} idx     - chunk index (0-based)
 * @param {boolean} isLast - whether this is the final chunk
 * @returns {Uint8Array} 21-byte AAD
 */
function makeAAD(idx, isLast) {
  const aad = new Uint8Array(21); // 16 zero bytes + 4-byte idx + 1-byte flag
  const view = new DataView(aad.buffer);
  view.setUint32(16, idx, false); // big-endian at offset 16 → bytes [16,17,18,19]
  aad[20] = isLast ? 0x01 : 0x00;
  return aad;
}

/**
 * Import raw AES-256-GCM key bytes into a CryptoKey.
 *
 * @param {Uint8Array} keyBytes - 32-byte raw key
 * @returns {Promise<CryptoKey>}
 */
async function importKey(keyBytes) {
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false, // not extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext using FUPL v1 wire format.
 * If keyBytes is null a random 32-byte key is generated.
 *
 * Matches Python encrypt_file():
 *   - Writes header with placeholder chunk count (0x00000000)
 *   - Encrypts each PLAINTEXT_CHUNK-sized slice
 *   - Handles empty input: produces one chunk of empty ciphertext
 *   - Overwrites chunk count at offset 17 after all chunks are known
 *
 * @param {ArrayBuffer} plaintext
 * @param {Uint8Array|null} keyBytes
 * @returns {Promise<{ciphertext: ArrayBuffer, keyBytes: Uint8Array}>}
 */
async function encryptData(plaintext, keyBytes) {
  if (!keyBytes) {
    keyBytes = crypto.getRandomValues(new Uint8Array(32));
  }
  const key = await importKey(keyBytes);
  const baseNonce = crypto.getRandomValues(new Uint8Array(12));
  const buf = new Uint8Array(plaintext);

  // Split plaintext into PLAINTEXT_CHUNK-sized slices.
  // Empty input → one zero-length chunk (matches Python's "if total == 0" branch).
  const chunks = [];
  let offset = 0;
  // The condition `chunks.length === 0` ensures we always produce at least one chunk.
  while (offset < buf.length || chunks.length === 0) {
    chunks.push(buf.slice(offset, offset + PLAINTEXT_CHUNK));
    offset += PLAINTEXT_CHUNK;
    if (offset >= buf.length) break;
  }
  const total = chunks.length;

  // Encrypt all chunks, accumulating ciphertext ArrayBuffers.
  const encryptedChunks = [];
  let totalCipherSize = 21; // header is always 21 bytes
  for (let idx = 0; idx < total; idx++) {
    const isLast = idx === total - 1;
    const nonce = xorNonce(baseNonce, idx, isLast);
    const aad = makeAAD(idx, isLast);
    // AES-GCM produces: ciphertext || 16-byte authentication tag
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      chunks[idx]
    );
    encryptedChunks.push(new Uint8Array(ct));
    totalCipherSize += ct.byteLength;

    // Report progress after each chunk.
    self.postMessage({ type: 'progress', percent: Math.round(((idx + 1) / total) * 100) });
  }

  // Assemble output buffer: header + all encrypted chunks.
  const out = new Uint8Array(totalCipherSize);
  let pos = 0;

  // Magic: b"FUPL"
  out.set(MAGIC, pos); pos += 4;

  // Version: 0x01
  out[pos++] = VERSION;

  // Base nonce: 12 bytes
  out.set(baseNonce, pos); pos += 12;

  // total_chunk_count at offset 17 (4 bytes big-endian).
  // Python writes placeholder 0x00000000 then seeks back to offset 17 to overwrite —
  // we write the final value directly since we already know it.
  const countView = new DataView(out.buffer, pos, 4);
  countView.setUint32(0, total, false); // big-endian
  pos += 4;

  // Encrypted chunks
  for (const chunk of encryptedChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }

  return { ciphertext: out.buffer, keyBytes };
}

/**
 * Decrypt a FUPL v1 ciphertext buffer.
 * Matches Python decrypt_stream():
 *   - Validates magic + version
 *   - Reads base_nonce and total_chunk_count from header
 *   - For non-last chunks reads exactly PLAINTEXT_CHUNK + 16 bytes (plaintext + GCM tag)
 *   - For last chunk reads remaining bytes
 *
 * @param {ArrayBuffer} ciphertext
 * @param {Uint8Array} keyBytes - 32-byte raw key
 * @returns {Promise<ArrayBuffer>}
 */
async function decryptData(ciphertext, keyBytes) {
  const buf = new Uint8Array(ciphertext);
  let pos = 0;

  // Validate magic b"FUPL"
  for (let i = 0; i < 4; i++) {
    if (buf[pos + i] !== MAGIC[i]) throw new Error('not a FUPL file');
  }
  pos += 4;

  // Validate version 0x01
  if (buf[pos++] !== VERSION) throw new Error('unsupported version');

  // Read base nonce (12 bytes)
  const baseNonce = buf.slice(pos, pos + 12); pos += 12;

  // Read total chunk count (uint32 big-endian)
  const total = new DataView(buf.buffer, pos, 4).getUint32(0, false); pos += 4;

  const key = await importKey(keyBytes);
  const plaintextChunks = [];
  const encChunkSize = PLAINTEXT_CHUNK + 16; // plaintext_chunk + GCM tag

  for (let idx = 0; idx < total; idx++) {
    const isLast = idx === total - 1;
    // Last chunk gets all remaining bytes (handles variable-length final chunk).
    // Non-last chunks are always exactly PLAINTEXT_CHUNK + 16 bytes.
    const ctChunk = isLast ? buf.slice(pos) : buf.slice(pos, pos + encChunkSize);
    pos += ctChunk.length;

    const nonce = xorNonce(baseNonce, idx, isLast);
    const aad = makeAAD(idx, isLast);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      ctChunk
    );
    plaintextChunks.push(new Uint8Array(pt));

    // Report progress after each chunk.
    self.postMessage({ type: 'progress', percent: Math.round(((idx + 1) / total) * 100) });
  }

  // Concatenate all plaintext chunks into a single output buffer.
  const totalLen = plaintextChunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let outPos = 0;
  for (const c of plaintextChunks) {
    out.set(c, outPos);
    outPos += c.length;
  }
  return out.buffer;
}

/**
 * Worker message handler.
 *
 * encrypt:
 *   in:  { type: "encrypt", plaintext: ArrayBuffer, key: Uint8Array | null }
 *   out: { type: "encrypted", ciphertext: ArrayBuffer, keyBytes: Uint8Array }
 *
 * decrypt:
 *   in:  { type: "decrypt", ciphertext: ArrayBuffer, key: Uint8Array }
 *   out: { type: "decrypted", plaintext: ArrayBuffer }
 *
 * errors always post: { type: "error", message: string }
 */
self.onmessage = async (e) => {
  const { type, plaintext, ciphertext, key } = e.data;
  try {
    if (type === 'encrypt') {
      const result = await encryptData(plaintext, key || null);
      // Transfer ciphertext ArrayBuffer to avoid copying.
      self.postMessage(
        { type: 'encrypted', ciphertext: result.ciphertext, keyBytes: result.keyBytes },
        [result.ciphertext]
      );
    } else if (type === 'decrypt') {
      const pt = await decryptData(ciphertext, key);
      // Transfer plaintext ArrayBuffer to avoid copying.
      self.postMessage(
        { type: 'decrypted', plaintext: pt },
        [pt]
      );
    } else {
      self.postMessage({ type: 'error', message: `unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
