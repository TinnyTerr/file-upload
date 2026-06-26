// Minimal store-only (no compression) ZIP writer — enough to bundle already-
// encrypted/arbitrary files in the browser without a third-party dependency
// (keeps the directory page within its strict `script-src 'self'` CSP).
'use strict';

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a ZIP Blob from entries.
 * @param {{name: string, data: Uint8Array}[]} entries
 * @returns {Blob}
 */
export function buildZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const crc = crc32(data);
    const size = data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);  // local file header signature
    dv.setUint16(4, 20, true);          // version needed to extract
    dv.setUint16(6, 0x0800, true);      // flag: UTF-8 filename
    dv.setUint16(8, 0, true);           // compression method: 0 = store
    dv.setUint16(10, DOS_TIME, true);
    dv.setUint16(12, DOS_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);       // compressed size
    dv.setUint32(22, size, true);       // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);          // extra field length
    lh.set(nameBytes, 30);
    parts.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central directory header signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);      // flag: UTF-8
    cv.setUint16(10, 0, true);          // method: store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);          // extra
    cv.setUint16(32, 0, true);          // comment
    cv.setUint16(34, 0, true);          // disk number start
    cv.setUint16(36, 0, true);          // internal attributes
    cv.setUint32(38, 0, true);          // external attributes
    cv.setUint32(42, offset, true);     // relative offset of local header
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { parts.push(c); centralSize += c.length; }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);    // end of central directory signature
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}
