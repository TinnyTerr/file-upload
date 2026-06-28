import { test, expect, describe } from "bun:test";
import {
  FUPL,
  encryptBytes,
  decryptBytes,
  totalChunks,
  parseHeader,
  buildHeader,
  u32be,
} from "../src/workers/fuplCore";

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, n)));
  return buf;
}

describe("FUPL header", () => {
  test("u32be is big-endian", () => {
    expect(Array.from(u32be(1))).toEqual([0, 0, 0, 1]);
    expect(Array.from(u32be(0x01020304))).toEqual([1, 2, 3, 4]);
  });
  test("build/parse round-trip", () => {
    const nonce = randomBytes(12);
    const header = buildHeader(nonce, 7);
    expect(header.length).toBe(FUPL.HEADER_SIZE);
    expect(Array.from(header.slice(0, 4))).toEqual([0x46, 0x55, 0x50, 0x4c]); // "FUPL"
    expect(header[4]).toBe(0x01);
    const parsed = parseHeader(header);
    expect(parsed.total).toBe(7);
    expect(parsed.baseNonce).toEqual(nonce);
  });
  test("rejects bad magic and zero count", () => {
    const bad = buildHeader(randomBytes(12), 1);
    bad[0] = 0;
    expect(() => parseHeader(bad)).toThrow();
    const zero = buildHeader(randomBytes(12), 0);
    expect(() => parseHeader(zero)).toThrow();
  });
});

describe("totalChunks", () => {
  test("empty input still has one chunk", () => {
    expect(totalChunks(0)).toBe(1);
  });
  test("chunk boundaries", () => {
    expect(totalChunks(FUPL.PLAINTEXT_CHUNK)).toBe(1);
    expect(totalChunks(FUPL.PLAINTEXT_CHUNK + 1)).toBe(2);
    expect(totalChunks(FUPL.PLAINTEXT_CHUNK * 3)).toBe(3);
  });
});

describe("encrypt/decrypt round-trip", () => {
  const key = randomBytes(32);
  const cases: Record<string, Uint8Array> = {
    empty: new Uint8Array(0),
    small: new TextEncoder().encode("the quick brown fox 🦊"),
    "1MiB": randomBytes(1024 * 1024),
    "exact-2MiB": randomBytes(FUPL.PLAINTEXT_CHUNK),
    multi: randomBytes(FUPL.PLAINTEXT_CHUNK * 2 + 777),
  };

  for (const [name, plaintext] of Object.entries(cases)) {
    test(`round-trips ${name}`, async () => {
      const ct = await encryptBytes(key, plaintext);
      // header + at least one tag
      expect(ct.length).toBeGreaterThanOrEqual(FUPL.HEADER_SIZE + FUPL.TAG_SIZE);
      const pt = await decryptBytes(key, ct);
      expect(pt).toEqual(plaintext);
    });
  }

  test("wrong key fails to decrypt", async () => {
    const ct = await encryptBytes(key, new TextEncoder().encode("secret"));
    const wrong = randomBytes(32);
    await expect(decryptBytes(wrong, ct)).rejects.toBeDefined();
  });

  test("ciphertext differs from plaintext", async () => {
    const pt = new TextEncoder().encode("hello hello hello");
    const ct = await encryptBytes(key, pt);
    expect(ct.slice(FUPL.HEADER_SIZE)).not.toEqual(pt);
  });
});
