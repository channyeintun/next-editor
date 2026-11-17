// Node's argument checks for Buffer's numeric reads and writes
// (lib/internal/buffer.js: checkBounds, checkInt, boundsError) and for the
// sizes `alloc` takes. The package truncates offsets with `>>> 0` and throws
// plain RangeErrors without a `code`; Node throws ERR_OUT_OF_RANGE /
// ERR_BUFFER_OUT_OF_BOUNDS / ERR_INVALID_ARG_TYPE. Each method here validates
// as Node does, then runs the package's own method with checks off.
import { invalidArgType, makeNodeError, outOfRange, validateNumber } from "../internalErrors";

type Method = (this: Uint8Array, ...args: unknown[]) => unknown;
type Proto = Record<string, Method>;

function bufferOutOfBounds(): Error {
  return makeNodeError(
    "ERR_BUFFER_OUT_OF_BOUNDS",
    "Attempt to access memory outside buffer bounds",
    RangeError,
  );
}

/** Node's `boundsError`: why `value` is not a usable offset (or `byteLength`). */
function boundsError(value: number, length: number, type?: string): never {
  if (Math.floor(value) !== value) {
    validateNumber(value, type ?? "offset");
    throw outOfRange(type || "offset", "an integer", value);
  }
  if (length < 0) {
    throw bufferOutOfBounds();
  }
  throw outOfRange(type || "offset", `>= ${type ? 1 : 0} and <= ${length}`, value);
}

/** Node's `checkBounds`: `offset` … `offset + size - 1` are inside `buf`. */
function checkBounds(buf: Uint8Array, offset: unknown, size: number): asserts offset is number {
  validateNumber(offset, "offset");
  if (buf[offset] === undefined || buf[offset + size - 1] === undefined) {
    boundsError(offset, buf.length - size);
  }
}

/** Node's `checkInt` range check, with its wording for wide integers. */
function checkValue(
  value: number | bigint,
  min: number | bigint,
  max: number | bigint,
  size: number,
) {
  if (value > max || value < min) {
    const n = typeof min === "bigint" ? "n" : "";
    let range: string;
    if (size > 4) {
      range =
        min === 0 || min === 0n
          ? `>= 0${n} and < 2${n} ** ${size * 8}${n}`
          : `>= -(2${n} ** ${size * 8 - 1}${n}) and < 2${n} ** ${size * 8 - 1}${n}`;
    } else {
      range = `>= ${min}${n} and <= ${max}${n}`;
    }
    throw outOfRange("value", range, value);
  }
}

/** The `byteLength` of `read/writeUIntLE` and friends: 1 … 6. */
function checkByteLength(byteLength: unknown): number {
  if (
    typeof byteLength === "number" &&
    Number.isInteger(byteLength) &&
    byteLength >= 1 &&
    byteLength <= 6
  ) {
    return byteLength;
  }
  return boundsError(byteLength as number, 6, "byteLength");
}

function integerRange(size: number, signed: boolean): [number, number] {
  return signed ? [-(2 ** (size * 8 - 1)), 2 ** (size * 8 - 1) - 1] : [0, 2 ** (size * 8) - 1];
}

// The package encodes floats in JavaScript and writes a different NaN; Node
// stores them through a typed array, as here.
const float32 = new Float32Array(1);
const float32Bytes = new Uint8Array(float32.buffer);
const float64 = new Float64Array(1);
const float64Bytes = new Uint8Array(float64.buffer);
float32[0] = -1;
const platformBigEndian = float32Bytes[3] === 0;

function writeFloat(
  buf: Uint8Array,
  value: number,
  offset: number,
  size: number,
  bigEndian: boolean,
): number {
  let bytes: Uint8Array;
  if (size === 4) {
    float32[0] = value;
    bytes = float32Bytes;
  } else {
    float64[0] = value;
    bytes = float64Bytes;
  }
  const reverse = bigEndian !== platformBigEndian;
  for (let i = 0; i < size; i++) {
    buf[offset + i] = bytes[reverse ? size - 1 - i : i];
  }
  return offset + size;
}

/** Replaces each name in `names` with `make(the package's method)`. */
function replace(proto: Proto, names: string[], make: (original: Method) => Method): void {
  for (const name of names) {
    const original = proto[name];
    if (typeof original === "function") {
      proto[name] = make(original);
    }
  }
}

/** Spellings Node has for each method: `UInt` and `Uint`. */
function spellings(name: string): string[] {
  return name.includes("UInt") ? [name, name.replace("UInt", "Uint")] : [name];
}

/** Installs Node's checks on the package's numeric read/write methods. */
export function installNumericChecks(proto: Proto): void {
  const fixed: [suffix: string, size: number, signed: boolean | "float"][] = [
    ["UInt8", 1, false],
    ["UInt16LE", 2, false],
    ["UInt16BE", 2, false],
    ["UInt32LE", 4, false],
    ["UInt32BE", 4, false],
    ["Int8", 1, true],
    ["Int16LE", 2, true],
    ["Int16BE", 2, true],
    ["Int32LE", 4, true],
    ["Int32BE", 4, true],
    ["FloatLE", 4, "float"],
    ["FloatBE", 4, "float"],
    ["DoubleLE", 8, "float"],
    ["DoubleBE", 8, "float"],
  ];
  for (const [suffix, size, kind] of fixed) {
    replace(
      proto,
      spellings(`read${suffix}`),
      (original) =>
        function (this: Uint8Array, offset: unknown = 0) {
          checkBounds(this, offset, size);
          return original.call(this, offset, true);
        },
    );
    replace(
      proto,
      spellings(`write${suffix}`),
      (original) =>
        function (this: Uint8Array, value: unknown, offset: unknown = 0) {
          const number = +(value as number);
          if (kind !== "float") {
            const [min, max] = integerRange(size, kind);
            if (size === 1) {
              // Node's 8-bit writers check the offset's type first.
              validateNumber(offset, "offset");
            }
            checkValue(number, min, max, size);
          }
          checkBounds(this, offset, size);
          if (kind === "float") {
            return writeFloat(this, number, offset, size, suffix.endsWith("BE"));
          }
          return original.call(this, number, offset, true);
        },
    );
  }

  for (const [suffix, signed] of [
    ["UIntLE", false],
    ["UIntBE", false],
    ["IntLE", true],
    ["IntBE", true],
  ] as const) {
    replace(
      proto,
      spellings(`read${suffix}`),
      (original) =>
        function (this: Uint8Array, offset: unknown, byteLength: unknown) {
          if (offset === undefined) {
            throw invalidArgType("offset", "number", offset);
          }
          const size = checkByteLength(byteLength);
          checkBounds(this, offset, size);
          return original.call(this, offset, size, true);
        },
    );
    replace(
      proto,
      spellings(`write${suffix}`),
      (original) =>
        function (this: Uint8Array, value: unknown, offset: unknown, byteLength: unknown) {
          const size = checkByteLength(byteLength);
          const number = +(value as number);
          const [min, max] = integerRange(size, signed);
          if (size === 1) {
            validateNumber(offset, "offset");
          }
          checkValue(number, min, max, size);
          checkBounds(this, offset, size);
          return original.call(this, number, offset, size, true);
        },
    );
  }

  for (const [suffix, signed] of [
    ["BigUInt64LE", false],
    ["BigUInt64BE", false],
    ["BigInt64LE", true],
    ["BigInt64BE", true],
  ] as const) {
    replace(
      proto,
      spellings(`read${suffix}`),
      (original) =>
        function (this: Uint8Array, offset: unknown = 0) {
          checkBounds(this, offset, 8);
          return original.call(this, offset);
        },
    );
    replace(
      proto,
      spellings(`write${suffix}`),
      (original) =>
        function (this: Uint8Array, value: unknown, offset: unknown = 0) {
          const [min, max] = signed ? [-(2n ** 63n), 2n ** 63n - 1n] : [0n, 2n ** 64n - 1n];
          checkValue(value as bigint, min, max, 8);
          checkBounds(this, offset, 8);
          return original.call(this, value, offset);
        },
    );
  }
}

/** Node's check of a size given to `alloc`, `allocUnsafe` and `allocUnsafeSlow`. */
export function validateAllocSize(size: unknown, maxLength: number): asserts size is number {
  validateNumber(size, "size", 0, maxLength);
}
