// The AES block cipher (FIPS-197) for 128/192/256-bit keys, table-driven, plus
// the GHASH multiply GCM needs. Pure and synchronous; the modes live in
// cipher.ts.

// --- tables ---------------------------------------------------------------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const TE0 = new Uint32Array(256);
const TE1 = new Uint32Array(256);
const TE2 = new Uint32Array(256);
const TE3 = new Uint32Array(256);
const TD0 = new Uint32Array(256);
const TD1 = new Uint32Array(256);
const TD2 = new Uint32Array(256);
const TD3 = new Uint32Array(256);

function xtime(x: number): number {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

function gfMul(a: number, b: number): number {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) {
      result ^= a;
    }
    a = xtime(a);
    b >>= 1;
  }
  return result;
}

(function buildTables() {
  // Multiplicative inverse via exponentiation tables over generator 3.
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= xtime(x);
  }
  for (let i = 0; i < 256; i++) {
    const inverse = i === 0 ? 0 : exp[(255 - log[i]) % 255];
    let s = inverse;
    let rotated = inverse;
    for (let k = 0; k < 4; k++) {
      rotated = ((rotated << 1) | (rotated >> 7)) & 0xff;
      s ^= rotated;
    }
    s ^= 0x63;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const e = ((gfMul(s, 2) << 24) | (s << 16) | (s << 8) | gfMul(s, 3)) >>> 0;
    TE0[i] = e;
    TE1[i] = ((e >>> 8) | (e << 24)) >>> 0;
    TE2[i] = ((e >>> 16) | (e << 16)) >>> 0;
    TE3[i] = ((e >>> 24) | (e << 8)) >>> 0;
    const v = INV_SBOX[i];
    const d =
      ((gfMul(v, 14) << 24) | (gfMul(v, 9) << 16) | (gfMul(v, 13) << 8) | gfMul(v, 11)) >>> 0;
    TD0[i] = d;
    TD1[i] = ((d >>> 8) | (d << 24)) >>> 0;
    TD2[i] = ((d >>> 16) | (d << 16)) >>> 0;
    TD3[i] = ((d >>> 24) | (d << 8)) >>> 0;
  }
})();

function subWord(w: number): number {
  return (
    ((SBOX[w >>> 24] << 24) |
      (SBOX[(w >>> 16) & 0xff] << 16) |
      (SBOX[(w >>> 8) & 0xff] << 8) |
      SBOX[w & 0xff]) >>>
    0
  );
}

function readWord(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeWord(bytes: Uint8Array, offset: number, word: number): void {
  bytes[offset] = word >>> 24;
  bytes[offset + 1] = word >>> 16;
  bytes[offset + 2] = word >>> 8;
  bytes[offset + 3] = word;
}

// --- block cipher ---------------------------------------------------------

/** An expanded AES key: encrypts and decrypts single 16-byte blocks. */
export class AesKey {
  readonly rounds: number;
  #encKey: Uint32Array;
  #decKey: Uint32Array;

  /** `key` must be 16, 24 or 32 bytes. */
  constructor(key: Uint8Array) {
    const nk = key.length / 4;
    if (nk !== 4 && nk !== 6 && nk !== 8) {
      throw new RangeError(`AES key must be 16, 24 or 32 bytes, got ${key.length}`);
    }
    this.rounds = nk + 6;
    const total = 4 * (this.rounds + 1);
    const w = new Uint32Array(total);
    for (let i = 0; i < nk; i++) {
      w[i] = readWord(key, 4 * i);
    }
    let rcon = 1;
    for (let i = nk; i < total; i++) {
      let t = w[i - 1];
      if (i % nk === 0) {
        t = subWord(((t << 8) | (t >>> 24)) >>> 0) ^ (rcon << 24);
        rcon = xtime(rcon);
      } else if (nk > 6 && i % nk === 4) {
        t = subWord(t);
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    this.#encKey = w;
    // Equivalent inverse cipher: reversed round keys, InvMixColumns on the inner ones.
    const d = new Uint32Array(total);
    for (let round = 0; round <= this.rounds; round++) {
      for (let c = 0; c < 4; c++) {
        const word = w[4 * (this.rounds - round) + c];
        if (round === 0 || round === this.rounds) {
          d[4 * round + c] = word;
        } else {
          d[4 * round + c] =
            (TD0[SBOX[word >>> 24]] ^
              TD1[SBOX[(word >>> 16) & 0xff]] ^
              TD2[SBOX[(word >>> 8) & 0xff]] ^
              TD3[SBOX[word & 0xff]]) >>>
            0;
        }
      }
    }
    this.#decKey = d;
  }

  /** Encrypts the block at `input[inOffset..+16]` into `output[outOffset..+16]`. */
  encryptBlock(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number): void {
    const k = this.#encKey;
    let s0 = readWord(input, inOffset) ^ k[0];
    let s1 = readWord(input, inOffset + 4) ^ k[1];
    let s2 = readWord(input, inOffset + 8) ^ k[2];
    let s3 = readWord(input, inOffset + 12) ^ k[3];
    let ki = 4;
    for (let round = 1; round < this.rounds; round++) {
      const t0 =
        TE0[s0 >>> 24] ^ TE1[(s1 >>> 16) & 0xff] ^ TE2[(s2 >>> 8) & 0xff] ^ TE3[s3 & 0xff] ^ k[ki];
      const t1 =
        TE0[s1 >>> 24] ^
        TE1[(s2 >>> 16) & 0xff] ^
        TE2[(s3 >>> 8) & 0xff] ^
        TE3[s0 & 0xff] ^
        k[ki + 1];
      const t2 =
        TE0[s2 >>> 24] ^
        TE1[(s3 >>> 16) & 0xff] ^
        TE2[(s0 >>> 8) & 0xff] ^
        TE3[s1 & 0xff] ^
        k[ki + 2];
      const t3 =
        TE0[s3 >>> 24] ^
        TE1[(s0 >>> 16) & 0xff] ^
        TE2[(s1 >>> 8) & 0xff] ^
        TE3[s2 & 0xff] ^
        k[ki + 3];
      s0 = t0;
      s1 = t1;
      s2 = t2;
      s3 = t3;
      ki += 4;
    }
    const sub = (a: number, b: number, c: number, d: number, key: number) =>
      ((SBOX[a >>> 24] << 24) |
        (SBOX[(b >>> 16) & 0xff] << 16) |
        (SBOX[(c >>> 8) & 0xff] << 8) |
        SBOX[d & 0xff]) ^
      key;
    writeWord(output, outOffset, sub(s0, s1, s2, s3, k[ki]));
    writeWord(output, outOffset + 4, sub(s1, s2, s3, s0, k[ki + 1]));
    writeWord(output, outOffset + 8, sub(s2, s3, s0, s1, k[ki + 2]));
    writeWord(output, outOffset + 12, sub(s3, s0, s1, s2, k[ki + 3]));
  }

  /** Decrypts the block at `input[inOffset..+16]` into `output[outOffset..+16]`. */
  decryptBlock(input: Uint8Array, inOffset: number, output: Uint8Array, outOffset: number): void {
    const k = this.#decKey;
    let s0 = readWord(input, inOffset) ^ k[0];
    let s1 = readWord(input, inOffset + 4) ^ k[1];
    let s2 = readWord(input, inOffset + 8) ^ k[2];
    let s3 = readWord(input, inOffset + 12) ^ k[3];
    let ki = 4;
    for (let round = 1; round < this.rounds; round++) {
      const t0 =
        TD0[s0 >>> 24] ^ TD1[(s3 >>> 16) & 0xff] ^ TD2[(s2 >>> 8) & 0xff] ^ TD3[s1 & 0xff] ^ k[ki];
      const t1 =
        TD0[s1 >>> 24] ^
        TD1[(s0 >>> 16) & 0xff] ^
        TD2[(s3 >>> 8) & 0xff] ^
        TD3[s2 & 0xff] ^
        k[ki + 1];
      const t2 =
        TD0[s2 >>> 24] ^
        TD1[(s1 >>> 16) & 0xff] ^
        TD2[(s0 >>> 8) & 0xff] ^
        TD3[s3 & 0xff] ^
        k[ki + 2];
      const t3 =
        TD0[s3 >>> 24] ^
        TD1[(s2 >>> 16) & 0xff] ^
        TD2[(s1 >>> 8) & 0xff] ^
        TD3[s0 & 0xff] ^
        k[ki + 3];
      s0 = t0;
      s1 = t1;
      s2 = t2;
      s3 = t3;
      ki += 4;
    }
    const inv = (a: number, b: number, c: number, d: number, key: number) =>
      ((INV_SBOX[a >>> 24] << 24) |
        (INV_SBOX[(b >>> 16) & 0xff] << 16) |
        (INV_SBOX[(c >>> 8) & 0xff] << 8) |
        INV_SBOX[d & 0xff]) ^
      key;
    writeWord(output, outOffset, inv(s0, s3, s2, s1, k[ki]));
    writeWord(output, outOffset + 4, inv(s1, s0, s3, s2, k[ki + 1]));
    writeWord(output, outOffset + 8, inv(s2, s1, s0, s3, k[ki + 2]));
    writeWord(output, outOffset + 12, inv(s3, s2, s1, s0, k[ki + 3]));
  }
}

// --- GHASH ----------------------------------------------------------------

/**
 * GHASH (NIST SP 800-38D) over the hash subkey `h`, with a 4-bit table
 * (Shoup's method). Absorb whole 16-byte blocks; the caller pads.
 */
export class Ghash {
  // 16 table entries, each 4 big-endian 32-bit words.
  #table = new Uint32Array(64);
  #y = new Uint32Array(4);

  constructor(h: Uint8Array) {
    const v = [readWord(h, 0), readWord(h, 4), readWord(h, 8), readWord(h, 12)];
    // table[8] = H, table[4] = H·x, table[2] = H·x², table[1] = H·x³ (bit-reflected order).
    const set = (index: number, words: number[]) => {
      for (let i = 0; i < 4; i++) {
        this.#table[4 * index + i] = words[i] >>> 0;
      }
    };
    set(8, v);
    let cur = v;
    for (const index of [4, 2, 1]) {
      cur = shiftRightOne(cur);
      set(index, cur);
    }
    for (const base of [2, 4, 8]) {
      for (let j = 1; j < base; j++) {
        const words: number[] = [];
        for (let i = 0; i < 4; i++) {
          words.push(this.#table[4 * base + i] ^ this.#table[4 * j + i]);
        }
        set(base + j, words);
      }
    }
  }

  /** Absorbs the 16-byte block at `block[offset..+16]`. */
  update(block: Uint8Array, offset: number): void {
    const y = this.#y;
    y[0] ^= readWord(block, offset);
    y[1] ^= readWord(block, offset + 4);
    y[2] ^= readWord(block, offset + 8);
    y[3] ^= readWord(block, offset + 12);
    this.#multiply();
  }

  /** The current GHASH value, as 16 bytes. */
  digest(): Uint8Array {
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      writeWord(out, 4 * i, this.#y[i]);
    }
    return out;
  }

  // y = y · H in GF(2^128), processing y four bits at a time from the last byte.
  #multiply(): void {
    const y = this.#y;
    const t = this.#table;
    let z0 = 0;
    let z1 = 0;
    let z2 = 0;
    let z3 = 0;
    for (let i = 15; i >= 0; i--) {
      const byte = (y[i >>> 2] >>> (8 * (3 - (i & 3)))) & 0xff;
      for (const nibble of [byte & 0x0f, byte >>> 4]) {
        // z = z · x⁴ (shift right by 4 with reduction), then z ^= table[nibble].
        const rem = z3 & 0x0f;
        z3 = (z3 >>> 4) | (z2 << 28);
        z2 = (z2 >>> 4) | (z1 << 28);
        z1 = (z1 >>> 4) | (z0 << 28);
        z0 = (z0 >>> 4) ^ REDUCE4[rem];
        z0 ^= t[4 * nibble];
        z1 ^= t[4 * nibble + 1];
        z2 ^= t[4 * nibble + 2];
        z3 ^= t[4 * nibble + 3];
      }
    }
    y[0] = z0;
    y[1] = z1;
    y[2] = z2;
    y[3] = z3;
  }
}

/** v · x in GF(2^128) (GCM's bit order): shift right one, reduce by 0xe1 << 120. */
function shiftRightOne(v: number[]): number[] {
  const carry = v[3] & 1;
  const out = [
    v[0] >>> 1,
    ((v[1] >>> 1) | (v[0] << 31)) >>> 0,
    ((v[2] >>> 1) | (v[1] << 31)) >>> 0,
    ((v[3] >>> 1) | (v[2] << 31)) >>> 0,
  ];
  if (carry) {
    out[0] = (out[0] ^ 0xe1000000) >>> 0;
  }
  return out;
}

/** The reduction words for the 4 bits shifted out of `z` by a 4-bit right shift. */
const REDUCE4 = (() => {
  const table = new Uint32Array(16);
  for (let rem = 0; rem < 16; rem++) {
    // Each shifted-out bit b (value 2^b, b=0 is the last bit out) folds back as 0xe1 << 120 shifted right by (3 - b).
    let r = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (rem & (1 << bit)) {
        r ^= 0xe1000000 >>> (3 - bit);
      }
    }
    table[rem] = r >>> 0;
  }
  return table;
})();
