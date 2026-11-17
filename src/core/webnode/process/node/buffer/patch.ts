// Brings the `buffer` npm package (v6.0.3) up to Node 22's Buffer: every
// encoding (base64url included) in toString/write/from/byteLength/isEncoding/
// fill/indexOf, the native `*Slice`/`*Write` prototype methods, Node's
// argument validation (numeric reads and writes in buffer/numeric.ts), `copyBytesFrom`, `inspect` output, Uint8Array arguments
// to `equals`/`compare`, and TextDecoder-backed utf8 decoding. The package's
// own Buffer is patched in place, so Buffers stay `Uint8Array` subclasses and
// every copy of the package in one bundle agrees.
import { Buffer as PkgBuffer } from "buffer/";
import { invalidArgType, makeNodeError, outOfRange, validateInteger } from "../internalErrors";
import {
  byteLengthOf,
  decodeBytes,
  encodeString,
  normalizeEncoding,
  writeString,
  type Encoding,
} from "./encodings";
import { installNumericChecks, validateAllocSize } from "./numeric";

/** Node's `kMaxLength` on 64-bit (Node 22). */
export const K_MAX_LENGTH = 2 ** 53 - 1;
/** Node's `kStringMaxLength` (V8's string limit). */
export const K_STRING_MAX_LENGTH = 2 ** 29 - 24;

/** The instance methods Node has that the package lacks or gets wrong. */
export interface BufferExtras {
  toString(encoding?: string, start?: number, end?: number): string;
  latin1Slice(start?: number, end?: number): string;
  utf8Slice(start?: number, end?: number): string;
  asciiSlice(start?: number, end?: number): string;
  hexSlice(start?: number, end?: number): string;
  base64Slice(start?: number, end?: number): string;
  base64urlSlice(start?: number, end?: number): string;
  ucs2Slice(start?: number, end?: number): string;
  utf8Write(string: string, offset?: number, length?: number): number;
  latin1Write(string: string, offset?: number, length?: number): number;
  asciiWrite(string: string, offset?: number, length?: number): number;
  hexWrite(string: string, offset?: number, length?: number): number;
  base64Write(string: string, offset?: number, length?: number): number;
  base64urlWrite(string: string, offset?: number, length?: number): number;
  ucs2Write(string: string, offset?: number, length?: number): number;
  readBigUint64LE(offset?: number): bigint;
  readBigUint64BE(offset?: number): bigint;
  writeBigUint64LE(value: bigint, offset?: number): number;
  writeBigUint64BE(value: bigint, offset?: number): number;
  equals(other: Uint8Array): boolean;
  indexOf(
    value: string | number | Uint8Array,
    byteOffset?: number | string,
    encoding?: string,
  ): number;
  lastIndexOf(
    value: string | number | Uint8Array,
    byteOffset?: number | string,
    encoding?: string,
  ): number;
  includes(
    value: string | number | Uint8Array,
    byteOffset?: number | string,
    encoding?: string,
  ): boolean;
  write(string: string, encoding?: string): number;
  write(string: string, offset: number, encoding?: string): number;
  write(string: string, offset: number, length: number, encoding?: string): number;
  fill(value: string | number | Uint8Array, encoding?: string): this;
  fill(value: string | number | Uint8Array, offset: number, encoding?: string): this;
  fill(value: string | number | Uint8Array, offset: number, end: number, encoding?: string): this;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
}

/** A Buffer as webnode builds it: the package's class plus Node 22's extras. */
export interface Buffer extends Omit<PkgBuffer, keyof BufferExtras>, BufferExtras {}

/** The Buffer constructor with Node 22's statics. */
export interface BufferConstructor {
  new (value: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
  (value: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
  prototype: Buffer;
  from(value: unknown, encodingOrOffset?: unknown, length?: number): Buffer;
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: string): Buffer;
  allocUnsafe(size: number): Buffer;
  allocUnsafeSlow(size: number): Buffer;
  isBuffer(value: unknown): value is Buffer;
  isEncoding(encoding: string): boolean;
  byteLength(value: string | ArrayBufferView | ArrayBufferLike, encoding?: string): number;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  compare(a: Uint8Array, b: Uint8Array): number;
  copyBytesFrom(view: ArrayBufferView, offset?: number, length?: number): Buffer;
  of(...items: number[]): Buffer;
  poolSize: number;
}

let inspectMaxBytes = 50;

/** `buffer.INSPECT_MAX_BYTES`. */
export function getInspectMaxBytes(): number {
  return inspectMaxBytes;
}

/** Sets `buffer.INSPECT_MAX_BYTES`, validated as Node does. */
export function setInspectMaxBytes(value: unknown): void {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw outOfRange("buffer.INSPECT_MAX_BYTES", ">= 0", value);
  }
  inspectMaxBytes = value;
}

function unknownEncoding(encoding: unknown): Error {
  return makeNodeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${String(encoding)}`, TypeError);
}

function encodingOrThrow(encoding: unknown): Encoding {
  const normalized = normalizeEncoding(encoding);
  if (normalized === undefined) {
    throw unknownEncoding(encoding);
  }
  return normalized;
}

/** Node's `validateOffset`: an integer in `[min, max]`. */
function validateOffset(value: unknown, name: string, min = 0, max = K_MAX_LENGTH): number {
  if (typeof value !== "number") {
    throw invalidArgType(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw outOfRange(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function compareBytes(
  a: Uint8Array,
  aStart: number,
  aEnd: number,
  b: Uint8Array,
  bStart: number,
  bEnd: number,
): number {
  const aLength = aEnd - aStart;
  const bLength = bEnd - bStart;
  const n = Math.min(aLength, bLength);
  for (let i = 0; i < n; i++) {
    const x = a[aStart + i];
    const y = b[bStart + i];
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return aLength < bLength ? -1 : aLength > bLength ? 1 : 0;
}

/** Node's `IndexOfOffset` (src/node_buffer.cc). */
function indexOfOffset(
  length: number,
  offset: number,
  needleLength: number,
  forward: boolean,
): number {
  if (offset < 0) {
    if (offset + length >= 0) {
      return length + offset;
    }
    if (forward || needleLength === 0) {
      return 0;
    }
    return -1;
  }
  if (offset + needleLength <= length) {
    return offset;
  }
  if (needleLength === 0) {
    return length;
  }
  return forward ? -1 : length - 1;
}

function searchBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  offset: number,
  forward: boolean,
): number {
  const last = haystack.length - needle.length;
  const first = needle[0];
  if (forward) {
    for (
      let i = haystack.indexOf(first, offset);
      i !== -1 && i <= last;
      i = haystack.indexOf(first, i + 1)
    ) {
      let j = 1;
      while (j < needle.length && haystack[i + j] === needle[j]) {
        j++;
      }
      if (j === needle.length) {
        return i;
      }
    }
    return -1;
  }
  for (let i = Math.min(offset, last); i >= 0; i--) {
    if (haystack[i] !== first) {
      continue;
    }
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) {
      j++;
    }
    if (j === needle.length) {
      return i;
    }
  }
  return -1;
}

function searchUnits(
  haystack: Uint8Array,
  needle: Uint8Array,
  offset: number,
  forward: boolean,
): number {
  const hayUnits = haystack.length >>> 1;
  const needleUnits = needle.length >>> 1;
  const unit = (bytes: Uint8Array, i: number) => bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  const matches = (at: number) => {
    for (let j = 0; j < needleUnits; j++) {
      if (unit(haystack, at + j) !== unit(needle, j)) {
        return false;
      }
    }
    return true;
  };
  // Node starts a forward search at the next whole unit, a backward one at this unit.
  const start = forward ? Math.ceil(offset / 2) : Math.floor(offset / 2);
  if (forward) {
    for (let i = start; i + needleUnits <= hayUnits; i++) {
      if (matches(i)) {
        return i * 2;
      }
    }
    return -1;
  }
  for (let i = Math.min(start, hayUnits - needleUnits); i >= 0; i--) {
    if (matches(i)) {
      return i * 2;
    }
  }
  return -1;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  byteOffset: number,
  encoding: Encoding,
  forward: boolean,
): number {
  const offset = indexOfOffset(haystack.length, Math.trunc(byteOffset), needle.length, forward);
  if (needle.length === 0) {
    return offset;
  }
  if (haystack.length === 0 || offset <= -1) {
    return -1;
  }
  if ((forward && haystack.length < offset + needle.length) || needle.length > haystack.length) {
    return -1;
  }
  if (encoding === "utf16le") {
    if (haystack.length < 2 || needle.length < 2) {
      return -1;
    }
    return searchUnits(haystack, needle, offset, forward);
  }
  return searchBytes(haystack, needle, offset, forward);
}

/** Node's `bidirectionalIndexOf` (lib/buffer.js). */
function bidirectionalIndexOf(
  buffer: Uint8Array,
  value: unknown,
  byteOffset: unknown,
  encoding: unknown,
  forward: boolean,
): number {
  let offset: number;
  if (typeof byteOffset === "string") {
    encoding = byteOffset;
    offset = Number.NaN;
  } else {
    let raw = byteOffset as number;
    if (raw > 0x7fffffff) {
      raw = 0x7fffffff;
    } else if (raw < -0x80000000) {
      raw = -0x80000000;
    }
    offset = +raw;
  }
  if (Number.isNaN(offset)) {
    offset = forward ? 0 : buffer.length;
  }
  if (typeof value === "number") {
    const byte = (value >>> 0) & 0xff;
    const at = indexOfOffset(buffer.length, Math.trunc(offset), 1, forward);
    if (at <= -1 || buffer.length === 0) {
      return -1;
    }
    return forward
      ? Uint8Array.prototype.indexOf.call(buffer, byte, at)
      : Uint8Array.prototype.lastIndexOf.call(buffer, byte, at);
  }
  const normalized = encoding === undefined ? "utf8" : normalizeEncoding(encoding);
  if (typeof value === "string") {
    if (normalized === undefined) {
      throw unknownEncoding(encoding);
    }
    return indexOfBytes(buffer, encodeString(value, normalized), offset, normalized, forward);
  }
  if (isUint8Array(value)) {
    return indexOfBytes(buffer, value, offset, normalized ?? "utf8", forward);
  }
  throw invalidArgType("value", ["number", "string", "Buffer", "Uint8Array"], value);
}

type Proto = Record<string | symbol, unknown> & Uint8Array;

function sliceRange(buffer: Uint8Array, start: unknown, end: unknown): [number, number] {
  const length = buffer.length;
  const from = start === undefined ? 0 : Math.trunc(Number(start)) || 0;
  const to = end === undefined ? length : Math.trunc(Number(end)) || 0;
  if (from < 0 || to > length || from > length) {
    throw makeNodeError("ERR_OUT_OF_RANGE", "Index out of range", RangeError);
  }
  return [from, Math.max(from, to)];
}

function writeRange(buffer: Uint8Array, offset: unknown, length: unknown): [number, number] {
  const at = offset === undefined ? 0 : Math.trunc(Number(offset)) || 0;
  if (at < 0 || at > buffer.length) {
    throw makeNodeError(
      "ERR_BUFFER_OUT_OF_BOUNDS",
      '"offset" is outside of buffer bounds',
      RangeError,
    );
  }
  const max = buffer.length - at;
  const count =
    length === undefined ? max : Math.min(max, Math.max(0, Math.trunc(Number(length)) || 0));
  return [at, count];
}

let installed = false;

/** Patches the package's Buffer once; returns it typed as Node's. */
export function installBufferPatches(): BufferConstructor {
  const BufferCtor = PkgBuffer as unknown as BufferConstructor;
  if (installed) {
    return BufferCtor;
  }
  installed = true;
  const proto = PkgBuffer.prototype as unknown as Proto;
  const statics = PkgBuffer as unknown as Record<string, unknown>;
  const originalFrom = PkgBuffer.from as (...args: unknown[]) => Buffer;
  const asBuffer = (bytes: Uint8Array): Buffer => {
    Object.setPrototypeOf(bytes, PkgBuffer.prototype);
    return bytes as Buffer;
  };

  const encodings: Encoding[] = ["utf8", "latin1", "ascii", "hex", "base64", "base64url"];
  for (const encoding of encodings) {
    proto[`${encoding}Slice`] = function (this: Uint8Array, start?: number, end?: number) {
      const [from, to] = sliceRange(this, start, end);
      return decodeBytes(this, from, to, encoding);
    };
    proto[`${encoding}Write`] = function (
      this: Uint8Array,
      string: string,
      offset?: number,
      length?: number,
    ) {
      if (typeof string !== "string") {
        throw invalidArgType("argument", "string", string);
      }
      const [at, count] = writeRange(this, offset, length);
      return writeString(this, string, at, count, encoding);
    };
  }
  proto.ucs2Slice = function (this: Uint8Array, start?: number, end?: number) {
    const [from, to] = sliceRange(this, start, end);
    return decodeBytes(this, from, to, "utf16le");
  };
  proto.ucs2Write = function (this: Uint8Array, string: string, offset?: number, length?: number) {
    if (typeof string !== "string") {
      throw invalidArgType("argument", "string", string);
    }
    const [at, count] = writeRange(this, offset, length);
    return writeString(this, string, at, count, "utf16le");
  };

  proto.toString = function toString(
    this: Uint8Array,
    encoding?: unknown,
    start?: unknown,
    end?: unknown,
  ): string {
    const length = this.length;
    if (arguments.length === 0) {
      return decodeBytes(this, 0, length, "utf8");
    }
    let from: number;
    if ((start as number) <= 0) {
      from = 0;
    } else if ((start as number) >= length) {
      return "";
    } else {
      from = Math.trunc(start as number) || 0;
    }
    let to: number;
    if (end === undefined || (end as number) > length) {
      to = length;
    } else {
      to = Math.trunc(end as number) || 0;
    }
    if (to <= from) {
      return "";
    }
    if (encoding === undefined) {
      return decodeBytes(this, from, to, "utf8");
    }
    return decodeBytes(this, from, to, encodingOrThrow(encoding));
  };
  proto.toLocaleString = proto.toString;

  proto.write = function write(
    this: Uint8Array,
    string: unknown,
    offset?: unknown,
    length?: unknown,
    encoding?: unknown,
  ): number {
    if (typeof string !== "string") {
      throw invalidArgType("argument", "string", string);
    }
    if (offset === undefined) {
      return writeString(this, string, 0, this.length, "utf8");
    }
    let at: number;
    let count: number;
    if (length === undefined && typeof offset === "string") {
      encoding = offset;
      at = 0;
      count = this.length;
    } else {
      at = validateOffset(offset, "offset", 0, this.length);
      const remaining = this.length - at;
      if (length === undefined) {
        count = remaining;
      } else if (typeof length === "string") {
        encoding = length;
        count = remaining;
      } else {
        count = Math.min(validateOffset(length, "length", 0, this.length), remaining);
      }
    }
    if (!encoding) {
      return writeString(this, string, at, count, "utf8");
    }
    return writeString(this, string, at, count, encodingOrThrow(encoding));
  };

  proto.equals = function equals(this: Uint8Array, other: unknown): boolean {
    if (!isUint8Array(other)) {
      throw invalidArgType("otherBuffer", ["Buffer", "Uint8Array"], other);
    }
    if (this === other) {
      return true;
    }
    if (this.byteLength !== other.byteLength) {
      return false;
    }
    return compareBytes(this, 0, this.length, other, 0, other.length) === 0;
  };

  proto.compare = function compare(
    this: Uint8Array,
    target: unknown,
    targetStart?: unknown,
    targetEnd?: unknown,
    sourceStart?: unknown,
    sourceEnd?: unknown,
  ): number {
    if (!isUint8Array(target)) {
      throw invalidArgType("target", ["Buffer", "Uint8Array"], target);
    }
    if (arguments.length === 1) {
      return compareBytes(this, 0, this.length, target, 0, target.length);
    }
    const tStart = targetStart === undefined ? 0 : validateOffset(targetStart, "targetStart");
    const tEnd =
      targetEnd === undefined
        ? target.length
        : validateOffset(targetEnd, "targetEnd", 0, target.length);
    const sStart = sourceStart === undefined ? 0 : validateOffset(sourceStart, "sourceStart");
    const sEnd =
      sourceEnd === undefined
        ? this.length
        : validateOffset(sourceEnd, "sourceEnd", 0, this.length);
    if (sStart >= sEnd) {
      return tStart >= tEnd ? 0 : -1;
    }
    if (tStart >= tEnd) {
      return 1;
    }
    if (sStart > this.length) {
      throw outOfRange("sourceStart", `<= ${this.length}`, sStart);
    }
    if (tStart > target.length) {
      throw outOfRange("targetStart", `<= ${target.length}`, tStart);
    }
    return compareBytes(this, sStart, sEnd, target, tStart, tEnd);
  };

  proto.indexOf = function indexOf(
    this: Uint8Array,
    value: unknown,
    byteOffset?: unknown,
    encoding?: unknown,
  ): number {
    return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
  };
  proto.lastIndexOf = function lastIndexOf(
    this: Uint8Array,
    value: unknown,
    byteOffset?: unknown,
    encoding?: unknown,
  ): number {
    return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
  };
  proto.includes = function includes(
    this: Uint8Array,
    value: unknown,
    byteOffset?: unknown,
    encoding?: unknown,
  ): boolean {
    return bidirectionalIndexOf(this, value, byteOffset, encoding, true) !== -1;
  };

  proto.readBigUint64LE = proto.readBigUInt64LE;
  proto.readBigUint64BE = proto.readBigUInt64BE;
  proto.writeBigUint64LE = proto.writeBigUInt64LE;
  proto.writeBigUint64BE = proto.writeBigUInt64BE;

  const inspect = function inspect(
    this: Uint8Array,
    _depth?: unknown,
    options?: unknown,
    inspectFn?: unknown,
  ): string {
    const max = inspectMaxBytes;
    const actualMax = Math.min(max, this.length);
    const remaining = this.length - max;
    let str = decodeBytes(this, 0, actualMax, "hex")
      .replace(/(.{2})/g, "$1 ")
      .trim();
    if (remaining > 0) {
      str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
    }
    if (options !== undefined && typeof inspectFn === "function") {
      const extras = Object.keys(this).filter((key) => !/^\d+$/.test(key));
      if (extras.length > 0) {
        const show = inspectFn as (value: unknown, opts: unknown) => string;
        const shown = extras.map(
          (key) =>
            `${key}: ${show((this as unknown as Record<string, unknown>)[key], {
              ...(options as object),
              breakLength: Infinity,
              compact: true,
            })}`,
        );
        str += `${str === "" ? "" : ", "}${shown.join(", ")}`;
      }
    }
    return `<${this.constructor.name} ${str}>`;
  };
  proto.inspect = inspect;
  proto[Symbol.for("nodejs.util.inspect.custom")] = inspect;

  statics.isEncoding = function isEncoding(encoding: unknown): boolean {
    return (
      typeof encoding === "string" &&
      encoding.length !== 0 &&
      normalizeEncoding(encoding) !== undefined
    );
  };

  statics.byteLength = function byteLength(string: unknown, encoding?: unknown): number {
    if (typeof string !== "string") {
      if (ArrayBuffer.isView(string) || string instanceof ArrayBuffer) {
        return string.byteLength;
      }
      if (
        typeof SharedArrayBuffer !== "undefined" &&
        (string as object) instanceof SharedArrayBuffer
      ) {
        return (string as SharedArrayBuffer).byteLength;
      }
      throw invalidArgType("string", ["string", "Buffer", "ArrayBuffer"], string);
    }
    if (string.length === 0) {
      return 0;
    }
    return byteLengthOf(string, normalizeEncoding(encoding) ?? "utf8");
  };

  statics.from = function from(
    value: unknown,
    encodingOrOffset?: unknown,
    length?: unknown,
  ): Buffer {
    if (typeof value === "string") {
      let encoding: Encoding;
      if (typeof encodingOrOffset !== "string" || encodingOrOffset.length === 0) {
        encoding = "utf8";
      } else {
        encoding = encodingOrThrow(encodingOrOffset);
      }
      return asBuffer(encodeString(value, encoding));
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      throw invalidArgType(
        "first argument",
        ["string", "Buffer", "ArrayBuffer", "Array", "Array-like Object"],
        value,
      );
    }
    return originalFrom.call(PkgBuffer, value, encodingOrOffset, length);
  };

  statics.compare = function compare(a: unknown, b: unknown): number {
    if (!isUint8Array(a)) {
      throw invalidArgType("buf1", ["Buffer", "Uint8Array"], a);
    }
    if (!isUint8Array(b)) {
      throw invalidArgType("buf2", ["Buffer", "Uint8Array"], b);
    }
    if (a === b) {
      return 0;
    }
    return compareBytes(a, 0, a.length, b, 0, b.length);
  };

  statics.copyBytesFrom = function copyBytesFrom(
    view: unknown,
    offset?: unknown,
    length?: unknown,
  ): Buffer {
    if (!ArrayBuffer.isView(view) || view instanceof DataView) {
      throw invalidArgType("view", ["TypedArray"], view);
    }
    const typed = view as unknown as {
      length: number;
      BYTES_PER_ELEMENT: number;
      byteOffset: number;
      buffer: ArrayBufferLike;
    };
    const viewLength = typed.length;
    if (viewLength === 0) {
      return BufferCtor.alloc(0);
    }
    let start = 0;
    let end = viewLength;
    if (offset !== undefined || length !== undefined) {
      if (offset !== undefined) {
        validateInteger(offset, "offset", 0);
        if (offset >= viewLength) {
          return BufferCtor.alloc(0);
        }
        start = offset;
      }
      if (length !== undefined) {
        validateInteger(length, "length", 0);
        end = Math.min(viewLength, start + length);
      }
    }
    const size = typed.BYTES_PER_ELEMENT;
    const bytes = new Uint8Array(
      typed.buffer,
      typed.byteOffset + start * size,
      (end - start) * size,
    );
    return asBuffer(new Uint8Array(bytes));
  };

  installNumericChecks(proto as unknown as Parameters<typeof installNumericChecks>[0]);

  for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) {
    const original = statics[name] as (size: number, ...rest: unknown[]) => Buffer;
    statics[name] = {
      [name](size: unknown, ...rest: unknown[]): Buffer {
        validateAllocSize(size, K_MAX_LENGTH);
        return original.call(PkgBuffer, size, ...rest);
      },
    }[name];
  }

  statics.of = function of(...items: number[]): Buffer {
    const out = BufferCtor.allocUnsafe(items.length);
    for (let i = 0; i < items.length; i++) {
      out[i] = items[i];
    }
    return out;
  };

  return BufferCtor;
}
