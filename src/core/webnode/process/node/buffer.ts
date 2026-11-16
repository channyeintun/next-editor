// The `buffer` builtin: the `buffer` npm package's Buffer brought up to Node 22
// (buffer/patch.ts), plus the module's other exports: `SlowBuffer`, the length
// limits, `INSPECT_MAX_BYTES`, `Blob`/`File`/`atob`/`btoa` (the platform's),
// `isUtf8`, `isAscii` and `transcode`.
import { invalidArgType, makeNodeError } from "./internalErrors";
import {
  decodeBytes,
  encodeString,
  isAsciiBytes,
  isUtf8Bytes,
  normalizeEncoding,
} from "./buffer/encodings";
import {
  K_MAX_LENGTH,
  K_STRING_MAX_LENGTH,
  getInspectMaxBytes,
  installBufferPatches,
  setInspectMaxBytes,
  type Buffer as BufferInstance,
  type BufferConstructor,
} from "./buffer/patch";

/** Node's Buffer: a `Uint8Array` subclass. */
export const Buffer: BufferConstructor = installBufferPatches();
/** A Buffer instance. */
export type Buffer = BufferInstance;

/** `SlowBuffer(size)`: deprecated, an unpooled `Buffer.allocUnsafeSlow`. */
export function SlowBuffer(size: number): Buffer {
  return Buffer.allocUnsafeSlow(size);
}
Object.setPrototypeOf(SlowBuffer.prototype, Uint8Array.prototype);
Object.setPrototypeOf(SlowBuffer, Uint8Array);

/** The largest Buffer Node allows. */
export const kMaxLength = K_MAX_LENGTH;
/** The longest string V8 allows. */
export const kStringMaxLength = K_STRING_MAX_LENGTH;
/** `buffer.constants`. */
export const constants = Object.freeze({
  MAX_LENGTH: K_MAX_LENGTH,
  MAX_STRING_LENGTH: K_STRING_MAX_LENGTH,
});

function bytesOf(input: unknown, name: string): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (
    input instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer)
  ) {
    if ((input as ArrayBuffer & { detached?: boolean }).detached === true) {
      throw makeNodeError(
        "ERR_INVALID_STATE",
        "Invalid state: Cannot validate on a detached buffer",
        Error,
      );
    }
    return new Uint8Array(input);
  }
  throw invalidArgType(name, ["TypedArray", "Buffer", "ArrayBuffer"], input);
}

/** Whether `input` is valid UTF-8. */
export function isUtf8(input: ArrayBufferView | ArrayBufferLike): boolean {
  return isUtf8Bytes(bytesOf(input, "input"));
}

/** Whether `input` holds only ASCII bytes. */
export function isAscii(input: ArrayBufferView | ArrayBufferLike): boolean {
  return isAsciiBytes(bytesOf(input, "input"));
}

const TRANSCODABLE = new Set(["utf8", "utf16le", "latin1", "ascii"]);

/**
 * Re-encodes `source` from one encoding to another (`utf8`, `ucs2`/`utf16le`,
 * `latin1`/`binary`, `ascii`). Characters the target cannot hold become `?`.
 */
export function transcode(source: Uint8Array, fromEncoding: string, toEncoding: string): Buffer {
  if (!(source instanceof Uint8Array)) {
    throw invalidArgType("source", ["Buffer", "Uint8Array"], source);
  }
  if (source.length === 0) {
    return Buffer.alloc(0);
  }
  const from = normalizeEncoding(fromEncoding);
  const to = normalizeEncoding(toEncoding);
  if (from === undefined || to === undefined || !TRANSCODABLE.has(from) || !TRANSCODABLE.has(to)) {
    const error = makeNodeError(
      "U_ILLEGAL_ARGUMENT_ERROR",
      "Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]",
      Error,
    ) as Error & { errno: number };
    error.errno = 1;
    throw error;
  }
  let text = decodeBytes(source, 0, source.length, from);
  if (to === "latin1") {
    text = text.replace(/[\u0100-\u{10ffff}]/gu, "?");
  } else if (to === "ascii") {
    text = text.replace(/[\u0080-\u{10ffff}]/gu, "?");
  }
  return Buffer.from(encodeString(text, to));
}

/** `buffer.resolveObjectURL`: blob URLs belong to the page, not to a process. */
export function resolveObjectURL(_id: string): never {
  throw new Error("buffer.resolveObjectURL is not available in webnode");
}

/** `buffer.atob`: the platform's. */
export function atob(data: string): string {
  if (arguments.length === 0) {
    throw makeNodeError("ERR_MISSING_ARGS", 'The "input" argument must be specified', TypeError);
  }
  return globalThis.atob(data);
}

/** `buffer.btoa`: the platform's. */
export function btoa(data: string): string {
  if (arguments.length === 0) {
    throw makeNodeError("ERR_MISSING_ARGS", 'The "input" argument must be specified', TypeError);
  }
  return globalThis.btoa(data);
}

/** What `require("buffer")` returns. */
const bufferModule = {
  Buffer,
  SlowBuffer,
  transcode,
  isUtf8,
  isAscii,
  kMaxLength,
  kStringMaxLength,
  btoa,
  atob,
  constants,
  INSPECT_MAX_BYTES: 50,
  Blob: undefined as unknown as typeof Blob,
  resolveObjectURL,
  File: undefined as unknown as typeof File,
};
Object.defineProperty(bufferModule, "INSPECT_MAX_BYTES", {
  configurable: true,
  enumerable: true,
  get: getInspectMaxBytes,
  set: setInspectMaxBytes,
});
Object.defineProperty(bufferModule, "Blob", {
  configurable: true,
  enumerable: true,
  get: () => globalThis.Blob,
});
Object.defineProperty(bufferModule, "File", {
  configurable: true,
  enumerable: true,
  get: () => globalThis.File,
});

export default bufferModule;
