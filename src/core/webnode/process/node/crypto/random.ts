// Randomness for the crypto builtin, over the platform CSPRNG
// (`globalThis.crypto.getRandomValues`, filled in 65536-byte chunks):
// randomBytes, randomFill(Sync), randomInt and randomUUID, with Node's checks.
import { Buffer } from "buffer/";
import { bytesOf, isAnyArrayBuffer } from "./encoding";
import {
  invalidArgType,
  outOfRange,
  validateBoolean,
  validateFunction,
  validateNumber,
  validateObject,
} from "./errors";

const MAX_POSSIBLE_LENGTH = 2147483647;
const GET_RANDOM_VALUES_LIMIT = 65536;
/** `randomInt`'s range limit: 48 bits. */
const RAND_MAX = 0xffff_ffff_ffff;

type Callback<T> = (error: Error | null, result?: T) => void;

// The browser's Web Crypto, captured now: a program may replace
// `globalThis.crypto` with an object built on this module (Go's WebAssembly
// runtime does), and the two must not call each other for ever.
const nativeCrypto: Crypto | undefined = globalThis.crypto;

function webCrypto(): Crypto {
  const crypto = nativeCrypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error(
      "crypto.randomBytes is not available: globalThis.crypto.getRandomValues is missing",
    );
  }
  return crypto;
}

/** Fills `bytes` from the platform CSPRNG. */
export function fillRandom(bytes: Uint8Array): void {
  const crypto = webCrypto();
  for (let offset = 0; offset < bytes.length; offset += GET_RANDOM_VALUES_LIMIT) {
    const end = Math.min(offset + GET_RANDOM_VALUES_LIMIT, bytes.length);
    // getRandomValues refuses SharedArrayBuffer views in some engines; go through a copy then.
    const chunk = bytes.subarray(offset, end);
    if (typeof SharedArrayBuffer !== "undefined" && chunk.buffer instanceof SharedArrayBuffer) {
      const copy = new Uint8Array(chunk.length);
      crypto.getRandomValues(copy);
      chunk.set(copy);
    } else {
      crypto.getRandomValues(chunk as Uint8Array<ArrayBuffer>);
    }
  }
}

function assertOffset(offset: unknown, elementSize: number, length: number): number {
  validateNumber(offset, "offset");
  const bytes = offset * elementSize;
  const maxLength = Math.min(length, MAX_POSSIBLE_LENGTH);
  if (Number.isNaN(bytes) || bytes > maxLength || bytes < 0) {
    throw outOfRange("offset", `>= 0 && <= ${maxLength}`, bytes);
  }
  return bytes >>> 0;
}

function assertSize(size: unknown, elementSize: number, offset: number, length: number): number {
  validateNumber(size, "size");
  const bytes = size * elementSize;
  if (Number.isNaN(bytes) || bytes > MAX_POSSIBLE_LENGTH || bytes < 0) {
    throw outOfRange("size", `>= 0 && <= ${MAX_POSSIBLE_LENGTH}`, bytes);
  }
  if (bytes + offset > length) {
    throw outOfRange("size + offset", `<= ${length}`, bytes + offset);
  }
  return bytes >>> 0;
}

type RandomTarget = ArrayBufferView | ArrayBufferLike;

function assertTarget(buf: unknown): asserts buf is RandomTarget {
  if (!isAnyArrayBuffer(buf) && !ArrayBuffer.isView(buf)) {
    throw invalidArgType("buf", "an instance of ArrayBuffer or ArrayBufferView", buf);
  }
}

function elementSizeOf(buf: RandomTarget): number {
  return (buf as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT || 1;
}

/** `crypto.randomBytes(size[, callback])`. */
export function randomBytes(size: unknown, callback?: unknown): Buffer | undefined {
  const bytes = assertSize(size, 1, 0, Infinity);
  if (callback !== undefined) {
    validateFunction(callback, "callback");
  }
  const buffer = Buffer.alloc(bytes);
  if (callback === undefined) {
    fillRandom(buffer);
    return buffer;
  }
  const done = callback as Callback<Buffer>;
  setTimeout(() => {
    try {
      fillRandom(buffer);
    } catch (error) {
      done(error as Error);
      return;
    }
    done(null, buffer);
  }, 0);
  return undefined;
}

/** `crypto.randomFillSync(buffer[, offset[, size]])`; offset and size count elements. */
export function randomFillSync<T>(buf: T, offset: unknown = 0, size?: unknown): T {
  assertTarget(buf);
  const target = buf as RandomTarget;
  const elementSize = elementSizeOf(target);
  const byteLength = target.byteLength;
  const start = assertOffset(offset, elementSize, byteLength);
  const count =
    size === undefined ? byteLength - start : assertSize(size, elementSize, start, byteLength);
  if (count > 0) {
    fillRandom(bytesOf(target).subarray(start, start + count));
  }
  return buf;
}

/** `crypto.randomFill(buffer[, offset[, size]], callback)`. */
export function randomFill(
  buf: unknown,
  offset?: unknown,
  size?: unknown,
  callback?: unknown,
): void {
  assertTarget(buf);
  const target = buf as RandomTarget;
  const elementSize = elementSizeOf(target);
  const byteLength = target.byteLength;
  let start: number;
  let count: number;
  if (typeof offset === "function") {
    callback = offset;
    start = 0;
    count = byteLength;
  } else if (typeof size === "function") {
    callback = size;
    start = assertOffset(offset, elementSize, byteLength);
    count = byteLength - start;
  } else {
    validateFunction(callback, "callback");
    start = assertOffset(offset, elementSize, byteLength);
    count =
      size === undefined ? byteLength - start : assertSize(size, elementSize, start, byteLength);
  }
  const done = callback as Callback<unknown>;
  setTimeout(() => {
    try {
      fillRandom(bytesOf(target).subarray(start, start + count));
    } catch (error) {
      done(error as Error);
      return;
    }
    done(null, buf);
  }, 0);
}

function safeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw invalidArgType(name, "a safe integer", value);
  }
}

/** An unbiased integer in `[min, max)` (rejection sampling over 48-bit draws). */
function drawInt(min: number, max: number): number {
  const range = max - min;
  const limit = RAND_MAX - (RAND_MAX % range);
  const draw = new Uint8Array(6);
  for (;;) {
    fillRandom(draw);
    const x =
      draw[0] * 2 ** 40 +
      draw[1] * 2 ** 32 +
      draw[2] * 2 ** 24 +
      draw[3] * 2 ** 16 +
      draw[4] * 2 ** 8 +
      draw[5];
    if (x < limit) {
      return (x % range) + min;
    }
  }
}

/** `crypto.randomInt([min, ]max[, callback])`: an integer with `min <= n < max`. */
export function randomInt(min: unknown, max?: unknown, callback?: unknown): number | undefined {
  const minNotSpecified = typeof max === "undefined" || typeof max === "function";
  if (minNotSpecified) {
    callback = max;
    max = min;
    min = 0;
  }
  const isSync = typeof callback === "undefined";
  if (!isSync) {
    validateFunction(callback, "callback");
  }
  safeInteger(min, "min");
  safeInteger(max, "max");
  if (max <= min) {
    throw outOfRange("max", `greater than the value of "min" (${min})`, max);
  }
  const range = max - min;
  if (!(range <= RAND_MAX)) {
    throw outOfRange("max - min", `<= ${RAND_MAX}`, range);
  }
  if (isSync) {
    return drawInt(min, max);
  }
  const done = callback as Callback<number>;
  const low = min;
  const high = max;
  setTimeout(() => done(null, drawInt(low, high)), 0);
  return undefined;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** `crypto.randomUUID([options])`: an RFC 4122 version 4 UUID. */
export function randomUUID(options?: unknown): string {
  if (options !== undefined) {
    validateObject(options, "options");
  }
  const { disableEntropyCache = false } = (options ?? {}) as { disableEntropyCache?: unknown };
  validateBoolean(disableEntropyCache, "options.disableEntropyCache");
  const b = new Uint8Array(16);
  fillRandom(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (byte) => HEX[byte]);
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h.slice(10).join("")}`;
}

/** `crypto.getRandomValues(typedArray)`: the Web Crypto call, bound to `globalThis.crypto`. */
export function getRandomValues<T extends ArrayBufferView | null>(typedArray: T): T {
  return webCrypto().getRandomValues(typedArray as never) as T;
}
