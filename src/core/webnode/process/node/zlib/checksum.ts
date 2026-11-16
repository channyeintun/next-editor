// The checksums the zlib formats carry: CRC-32 (gzip trailers, `zlib.crc32`)
// and Adler-32 (zlib trailers and preset-dictionary ids).

const CRC_TABLES: Uint32Array[] = (() => {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tables[0][n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[0][n];
    for (let t = 1; t < 8; t++) {
      c = tables[0][c & 0xff] ^ (c >>> 8);
      tables[t][n] = c >>> 0;
    }
  }
  return tables;
})();

/** Continues the CRC-32 `crc` (0 to start) over `data`; unsigned. */
export function crc32Update(crc: number, data: Uint8Array): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  let c = ~crc >>> 0;
  let i = 0;
  const n = data.length;
  const fast = n - (n % 8);
  for (; i < fast; i += 8) {
    const a =
      (c ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))) >>> 0;
    c =
      t7[a & 0xff] ^
      t6[(a >>> 8) & 0xff] ^
      t5[(a >>> 16) & 0xff] ^
      t4[a >>> 24] ^
      t3[data[i + 4]] ^
      t2[data[i + 5]] ^
      t1[data[i + 6]] ^
      t0[data[i + 7]];
  }
  for (; i < n; i++) {
    c = t0[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** Continues the Adler-32 `adler` (1 to start) over `data`; unsigned. */
export function adler32Update(adler: number, data: Uint8Array): number {
  let a = adler & 0xffff;
  let b = (adler >>> 16) & 0xffff;
  let i = 0;
  const n = data.length;
  while (i < n) {
    const end = Math.min(n, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
