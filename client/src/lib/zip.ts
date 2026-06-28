/**
 * Minimal store-only (no compression) ZIP writer. Used to bundle
 * client-side-decrypted folder members into a single download in the browser.
 * Mirrors the server's store-only ZIP behavior (app side streams the same).
 *
 * Supports filenames via UTF-8 (general-purpose bit 11). Not ZIP64 — intended
 * for collections under 4 GiB total / per file.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

interface CentralRecord {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  utf8: boolean;
}

export function createZip(entries: ZipEntry[]): Blob {
  const parts: BlobPart[] = [];
  const central: CentralRecord[] = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const utf8 = nameBytes.some((b) => b > 0x7f);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const header = new ArrayBuffer(30);
    const dv = new DataView(header);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, utf8 ? 0x0800 : 0, true); // flags (bit 11 = UTF-8)
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true); // compressed size
    dv.setUint32(22, size, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra length

    parts.push(header, nameBytes as BlobPart, entry.data as BlobPart);
    central.push({ nameBytes, crc, size, offset, utf8 });
    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const rec of central) {
    const header = new ArrayBuffer(46);
    const dv = new DataView(header);
    dv.setUint32(0, 0x02014b50, true); // central dir signature
    dv.setUint16(4, 20, true); // version made by
    dv.setUint16(6, 20, true); // version needed
    dv.setUint16(8, rec.utf8 ? 0x0800 : 0, true); // flags
    dv.setUint16(10, 0, true); // method: store
    dv.setUint16(12, 0, true); // mod time
    dv.setUint16(14, 0, true); // mod date
    dv.setUint32(16, rec.crc, true);
    dv.setUint32(20, rec.size, true);
    dv.setUint32(24, rec.size, true);
    dv.setUint16(28, rec.nameBytes.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk number
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, rec.offset, true); // local header offset

    parts.push(header, rec.nameBytes as BlobPart);
    centralSize += 46 + rec.nameBytes.length;
  }

  const eocd = new ArrayBuffer(22);
  const dv = new DataView(eocd);
  dv.setUint32(0, 0x06054b50, true); // end of central dir signature
  dv.setUint16(4, 0, true); // disk number
  dv.setUint16(6, 0, true); // disk with central dir
  dv.setUint16(8, central.length, true); // entries on this disk
  dv.setUint16(10, central.length, true); // total entries
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, centralStart, true);
  dv.setUint16(20, 0, true); // comment length
  parts.push(eocd);

  return new Blob(parts, { type: "application/zip" });
}
