// Key derivation for the crypto builtin: pbkdf2, scrypt and hkdf (sync and
// callback forms) on @noble/hashes, with Node's argument validation and
// OpenSSL's scrypt parameter checks.
import { expand, extract } from "@noble/hashes/hkdf.js";
import { pbkdf2 as noblePbkdf2, pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scrypt as nobleScrypt, scryptAsync } from "@noble/hashes/scrypt.js";
import type { Buffer } from "buffer/";
import { byteSource, toBuffer } from "./encoding";
import {
  codedError,
  invalidArgType,
  outOfRange,
  validateFunction,
  validateInt32,
  validateInteger,
  validateString,
  validateUint32,
} from "./errors";
import type { Digest } from "./digests";
import { digestForMac } from "./hash";

type Callback<T> = (error: Error | null, result?: T) => void;

/** Runs `fn` on a later task, the way Node finishes a crypto job off the main thread. */
function later(fn: () => void): void {
  setTimeout(fn, 0);
}

// --- pbkdf2 ---------------------------------------------------------------

interface Pbkdf2Params {
  password: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  keylen: number;
  digest: string;
}

function checkPbkdf2(
  password: unknown,
  salt: unknown,
  iterations: unknown,
  keylen: unknown,
  digest: unknown,
): Pbkdf2Params {
  validateString(digest, "digest");
  const passwordBytes = byteSource(password, "password");
  const saltBytes = byteSource(salt, "salt");
  validateInt32(iterations, "iterations", 1);
  validateInt32(keylen, "keylen", 0);
  return { password: passwordBytes, salt: saltBytes, iterations, keylen, digest };
}

/** `crypto.pbkdf2Sync(password, salt, iterations, keylen, digest)`. */
export function pbkdf2Sync(
  password: unknown,
  salt: unknown,
  iterations: unknown,
  keylen: unknown,
  digest: unknown,
): Buffer {
  const params = checkPbkdf2(password, salt, iterations, keylen, digest);
  const hash = digestForMac(params.digest).hash;
  if (params.keylen === 0) {
    return toBuffer(new Uint8Array(0));
  }
  return toBuffer(
    noblePbkdf2(hash, params.password, params.salt, { c: params.iterations, dkLen: params.keylen }),
  );
}

/** `crypto.pbkdf2(password, salt, iterations, keylen, digest, callback)`. */
export function pbkdf2(
  password: unknown,
  salt: unknown,
  iterations: unknown,
  keylen: unknown,
  digest: unknown,
  callback?: unknown,
): void {
  if (typeof digest === "function") {
    callback = digest;
    digest = undefined;
  }
  const params = checkPbkdf2(password, salt, iterations, keylen, digest);
  validateFunction(callback, "callback");
  const done = callback as Callback<Buffer>;
  const hash = digestForMac(params.digest).hash;
  if (params.keylen === 0) {
    later(() => done(null, toBuffer(new Uint8Array(0))));
    return;
  }
  pbkdf2Async(hash, params.password, params.salt, {
    c: params.iterations,
    dkLen: params.keylen,
  }).then(
    (key) => done(null, toBuffer(key)),
    (error: unknown) => done(error as Error),
  );
}

// --- scrypt ---------------------------------------------------------------

/** Options for `scrypt` / `scryptSync`, under either spelling Node accepts. */
export interface ScryptOptions {
  N?: number;
  cost?: number;
  r?: number;
  blockSize?: number;
  p?: number;
  parallelization?: number;
  maxmem?: number;
}

const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, maxmem: 32 << 20 };

interface ScryptParams {
  password: Uint8Array;
  salt: Uint8Array;
  keylen: number;
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

function incompatible(a: string, b: string): Error {
  return codedError(
    TypeError,
    "ERR_INCOMPATIBLE_OPTION_PAIR",
    `Option "${a}" cannot be used in combination with option "${b}"`,
  );
}

function invalidScryptParams(memory: boolean): Error {
  const message = memory
    ? "Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded"
    : "Invalid scrypt params";
  return codedError(RangeError, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", message);
}

/** OpenSSL's `EVP_PBE_scrypt` parameter checks, as Node reports them. */
function checkScryptLimits(N: number, r: number, p: number, maxmem: number): void {
  if (r === 0 || p === 0 || N < 2 || (N & (N - 1)) !== 0) {
    throw invalidScryptParams(false);
  }
  const bigN = BigInt(N);
  const bigR = BigInt(r);
  const bigP = BigInt(p);
  if (bigP > BigInt((1 << 30) - 1) / bigR) {
    throw invalidScryptParams(true);
  }
  if (16n * bigR <= 63n && bigN >= 1n << (16n * bigR)) {
    throw invalidScryptParams(true);
  }
  const blen = bigP * 128n * bigR;
  if (blen > 2147483647n) {
    throw invalidScryptParams(true);
  }
  const vlen = 32n * bigR * (bigN + 2n) * 4n;
  if (blen + vlen > BigInt(maxmem)) {
    throw invalidScryptParams(true);
  }
}

function checkScrypt(
  password: unknown,
  salt: unknown,
  keylen: unknown,
  options: unknown,
): ScryptParams {
  const passwordBytes = byteSource(password, "password");
  const saltBytes = byteSource(salt, "salt");
  validateInt32(keylen, "keylen", 0);
  let { N, r, p, maxmem } = SCRYPT_DEFAULTS;
  if (options !== null && options !== undefined && options !== SCRYPT_DEFAULTS) {
    const o = options as ScryptOptions;
    const hasN = o.N !== undefined;
    if (hasN) {
      validateUint32(o.N, "N");
      N = o.N;
    }
    if (o.cost !== undefined) {
      if (hasN) {
        throw incompatible("N", "cost");
      }
      validateUint32(o.cost, "cost");
      N = o.cost;
    }
    const hasR = o.r !== undefined;
    if (hasR) {
      validateUint32(o.r, "r");
      r = o.r;
    }
    if (o.blockSize !== undefined) {
      if (hasR) {
        throw incompatible("r", "blockSize");
      }
      validateUint32(o.blockSize, "blockSize");
      r = o.blockSize;
    }
    const hasP = o.p !== undefined;
    if (hasP) {
      validateUint32(o.p, "p");
      p = o.p;
    }
    if (o.parallelization !== undefined) {
      if (hasP) {
        throw incompatible("p", "parallelization");
      }
      validateUint32(o.parallelization, "parallelization");
      p = o.parallelization;
    }
    if (o.maxmem !== undefined) {
      validateInteger(o.maxmem, "maxmem", 0);
      maxmem = o.maxmem;
    }
    if (N === 0) N = SCRYPT_DEFAULTS.N;
    if (r === 0) r = SCRYPT_DEFAULTS.r;
    if (p === 0) p = SCRYPT_DEFAULTS.p;
    if (maxmem === 0) maxmem = SCRYPT_DEFAULTS.maxmem;
  }
  checkScryptLimits(N, r, p, maxmem);
  return { password: passwordBytes, salt: saltBytes, keylen, N, r, p, maxmem };
}

function nobleScryptOptions(params: ScryptParams) {
  // The OpenSSL limits above already ran; give noble a budget that never refuses
  // what they allow (its own estimate is smaller than OpenSSL's).
  const budget = 128 * params.r * (params.N + params.p + 2) + 1024;
  return { N: params.N, r: params.r, p: params.p, dkLen: params.keylen, maxmem: budget };
}

/** `crypto.scryptSync(password, salt, keylen[, options])`. */
export function scryptSync(
  password: unknown,
  salt: unknown,
  keylen: unknown,
  options?: unknown,
): Buffer {
  const params = checkScrypt(password, salt, keylen, options);
  if (params.keylen === 0) {
    return toBuffer(new Uint8Array(0));
  }
  return toBuffer(nobleScrypt(params.password, params.salt, nobleScryptOptions(params)));
}

/** `crypto.scrypt(password, salt, keylen[, options], callback)`. */
export function scrypt(
  password: unknown,
  salt: unknown,
  keylen: unknown,
  options: unknown,
  callback?: unknown,
): void {
  if (callback === undefined) {
    callback = options;
    options = SCRYPT_DEFAULTS;
  }
  const params = checkScrypt(password, salt, keylen, options);
  validateFunction(callback, "callback");
  const done = callback as Callback<Buffer>;
  if (params.keylen === 0) {
    later(() => done(null, toBuffer(new Uint8Array(0))));
    return;
  }
  scryptAsync(params.password, params.salt, nobleScryptOptions(params)).then(
    (key) => done(null, toBuffer(key)),
    (error: unknown) => done(error as Error),
  );
}

// --- hkdf -----------------------------------------------------------------

/** Node's `validateByteSource`: a string, ArrayBuffer or ArrayBufferView. */
function byteSourceStrict(value: unknown, name: string): Uint8Array {
  if (typeof value === "string" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return byteSource(value, name);
  }
  throw invalidArgType(
    name,
    "of type string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer",
    value,
  );
}

/** Node's hkdf `prepareKey`: the input keying material as bytes. */
function hkdfKey(ikm: unknown): Uint8Array {
  if (typeof ikm === "string" || ArrayBuffer.isView(ikm) || ikm instanceof ArrayBuffer) {
    return byteSource(ikm, "ikm");
  }
  throw invalidArgType(
    "ikm",
    "of type string or an instance of SecretKeyObject, ArrayBuffer, TypedArray, DataView, or Buffer",
    ikm,
  );
}

interface HkdfParams {
  digest: string;
  key: Uint8Array;
  salt: Uint8Array;
  info: Uint8Array;
  keylen: number;
}

function checkHkdf(
  digest: unknown,
  ikm: unknown,
  salt: unknown,
  info: unknown,
  keylen: unknown,
): HkdfParams {
  validateString(digest, "digest");
  const key = hkdfKey(ikm);
  const saltBytes = byteSourceStrict(salt, "salt");
  const infoBytes = byteSourceStrict(info, "info");
  validateInteger(keylen, "length", 0);
  if (infoBytes.byteLength > 1024) {
    throw outOfRange("info", "must not contain more than 1024 bytes", infoBytes.byteLength);
  }
  return { digest, key, salt: saltBytes, info: infoBytes, keylen };
}

/** The digest for `params`, after the checks Node runs synchronously (digest, key length). */
function prepareHkdf(params: HkdfParams): Digest {
  const digest = digestForMac(params.digest);
  if (params.keylen > 255 * digest.outputLength) {
    throw codedError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
  }
  return digest;
}

function deriveHkdf(params: HkdfParams, digest: Digest): ArrayBuffer {
  if (params.keylen === 0) {
    return new ArrayBuffer(0);
  }
  // RFC 5869: an empty salt is a string of HashLen zeros, which noble also uses for undefined.
  const prk = extract(digest.hash, params.key, params.salt.length ? params.salt : undefined);
  const okm = expand(digest.hash, prk, params.info, params.keylen);
  return okm.buffer.slice(okm.byteOffset, okm.byteOffset + okm.byteLength) as ArrayBuffer;
}

/** `crypto.hkdfSync(digest, ikm, salt, info, keylen)`: the key as an ArrayBuffer. */
export function hkdfSync(
  digest: unknown,
  ikm: unknown,
  salt: unknown,
  info: unknown,
  keylen: unknown,
): ArrayBuffer {
  const params = checkHkdf(digest, ikm, salt, info, keylen);
  return deriveHkdf(params, prepareHkdf(params));
}

/** `crypto.hkdf(digest, ikm, salt, info, keylen, callback)`. */
export function hkdf(
  digest: unknown,
  ikm: unknown,
  salt: unknown,
  info: unknown,
  keylen: unknown,
  callback: unknown,
): void {
  const params = checkHkdf(digest, ikm, salt, info, keylen);
  validateFunction(callback, "callback");
  const done = callback as Callback<ArrayBuffer>;
  const hash = prepareHkdf(params);
  later(() => done(null, deriveHkdf(params, hash)));
}
