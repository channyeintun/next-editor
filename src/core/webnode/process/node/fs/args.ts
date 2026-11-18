// Argument handling shared by every `fs` entry point, following Node 22's
// lib/internal/fs/utils.js: path validation (string, Buffer, `file:` URL),
// making a path absolute for the backend, file descriptors, open flags, modes,
// option objects and encodings, timestamps, buffers with offset/length/position,
// and encoding the names `fs` returns.
import { Buffer } from "../buffer";
import {
  invalidArgType,
  invalidArgValue,
  makeNodeError,
  outOfRange,
  validateAbortSignal,
  validateInteger,
} from "../internalErrors";
import { fileURLToPath } from "../url";
import { runtime } from "../../runtime";
import {
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_SYNC,
  O_TRUNC,
  O_WRONLY,
} from "../../../kernel/vfs/types";

/** What `fs` accepts as a path. */
export type PathLike = string | Uint8Array | URL;

/** An option object or encoding name, as most `fs` functions take. */
export type EncodingOption = string | null | undefined | { encoding?: string | null };

/** The largest single read or write Node performs (`kIoMaxLength`). */
export const kIoMaxLength = 2 ** 31 - 1;

const SLASH = 47;
const NULL_BYTES_REASON = "must be a string, Uint8Array, or URL without null bytes";
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const textEncoder = new TextEncoder();

/** `util.inspect` of a string the way Node quotes it in error messages, control characters escaped. */
function inspectString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = value.replace(/[\x00-\x1f\x7f\\]/g, (char) => {
    const code = char.charCodeAt(0);
    switch (code) {
      case 8:
        return "\\b";
      case 9:
        return "\\t";
      case 10:
        return "\\n";
      case 12:
        return "\\f";
      case 13:
        return "\\r";
      case 92:
        return "\\\\";
      default:
        return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  });
  if (!escaped.includes("'")) {
    return `'${escaped}'`;
  }
  if (!escaped.includes('"')) {
    return `"${escaped}"`;
  }
  if (!escaped.includes("`") && !escaped.includes("${")) {
    return `\`${escaped}\``;
  }
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

/** `ERR_INVALID_ARG_VALUE` with Node's rendering of strings with control characters and of Buffers. */
export function argValueError(name: string, value: unknown, reason: string): Error {
  let shown: string | null = null;
  if (typeof value === "string") {
    shown = inspectString(value);
  } else if (
    value instanceof Uint8Array &&
    (value.constructor as { name?: string }).name === "Buffer"
  ) {
    const hex = Array.from(value.subarray(0, 50), (byte) => byte.toString(16).padStart(2, "0"));
    const more =
      value.length > 50
        ? ` ... ${value.length - 50} more byte${value.length - 50 > 1 ? "s" : ""}`
        : "";
    shown = `<Buffer ${hex.join(" ")}${more}>`;
  }
  if (shown === null) {
    return invalidArgValue(name, value, reason);
  }
  if (shown.length > 128) {
    shown = `${shown.slice(0, 128)}...`;
  }
  const type = name.includes(".") ? "property" : "argument";
  return makeNodeError<TypeError>(
    "ERR_INVALID_ARG_VALUE",
    `The ${type} '${name}' ${reason}. Received ${shown}`,
    TypeError,
  );
}

/** UTF-8 to string, keeping a byte order mark (Node strips nothing). */
export function decodeUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/** String to UTF-8. */
export function encodeUtf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** `isURL` from lib/internal/url.js: a WHATWG URL, not a legacy `url.parse` object. */
export function isURLInstance(value: unknown): value is URL {
  const candidate = value as {
    href?: unknown;
    protocol?: unknown;
    auth?: unknown;
    path?: unknown;
  } | null;
  return Boolean(
    candidate?.href &&
    candidate.protocol &&
    candidate.auth === undefined &&
    candidate.path === undefined,
  );
}

/** `toPathIfFileURL`. */
export function toPathIfFileURL(value: unknown): unknown {
  return isURLInstance(value) ? fileURLToPath(value) : value;
}

/**
 * `getValidatedPath(fileURLOrPath, propName)`: the path as a string (a Buffer
 * path is decoded as UTF-8), throwing Node's argument errors.
 */
export function getValidatedPath(value: unknown, name = "path"): string {
  const path = toPathIfFileURL(value);
  if (typeof path === "string") {
    if (path.includes("\u0000")) {
      throw argValueError(name, path, NULL_BYTES_REASON);
    }
    return path;
  }
  if (path instanceof Uint8Array) {
    if (path.includes(0)) {
      throw argValueError(name, path, NULL_BYTES_REASON);
    }
    return decodeUtf8(path);
  }
  throw invalidArgType(name, ["string", "Buffer", "URL"], path);
}

/**
 * The absolute path the backend gets for `path`. An absolute path passes
 * unchanged; a relative one is joined to the working directory without
 * normalizing, so a trailing `/` or `/.` still demands a directory and `..`
 * is resolved after symbolic links, as the kernel would.
 */
export function toAbsolute(path: string): string {
  if (path.charCodeAt(0) === SLASH || path === "") {
    return path;
  }
  return workingDirectoryPrefix() + path;
}

/** What `toAbsolute` puts in front of a relative path: the working directory and a slash. */
export function workingDirectoryPrefix(): string {
  const cwd = runtime().cwd;
  return cwd === "/" ? cwd : `${cwd}/`;
}

/** `isInt32`: what `readFile`/`writeFile` treat as a file descriptor. */
export function isFd(value: unknown): value is number {
  return typeof value === "number" && value === (value | 0);
}

/** `getValidatedFd(fd)`: an int32 >= 0. */
export function getValidatedFd(fd: unknown, name = "fd"): number {
  validateInteger(fd, name, 0, 2147483647);
  return fd;
}

/** `validateUint32`. */
export function validateUint32(
  value: unknown,
  name: string,
  positive = false,
): asserts value is number {
  validateInteger(value, name, positive ? 1 : 0, 4294967295);
}

/** `stringToFlags(flags)`: Node's flag strings, or a number passed through. */
export function stringToFlags(flags: unknown): number {
  if (typeof flags === "number") {
    return flags;
  }
  if (flags == null) {
    return O_RDONLY;
  }
  switch (flags) {
    case "r":
      return O_RDONLY;
    case "rs":
    case "sr":
      return O_RDONLY | O_SYNC;
    case "r+":
      return O_RDWR;
    case "rs+":
    case "sr+":
      return O_RDWR | O_SYNC;
    case "w":
      return O_TRUNC | O_CREAT | O_WRONLY;
    case "wx":
    case "xw":
      return O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
    case "w+":
      return O_TRUNC | O_CREAT | O_RDWR;
    case "wx+":
    case "xw+":
      return O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
    case "a":
      return O_APPEND | O_CREAT | O_WRONLY;
    case "ax":
    case "xa":
      return O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
    case "as":
    case "sa":
      return O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
    case "a+":
      return O_APPEND | O_CREAT | O_RDWR;
    case "ax+":
    case "xa+":
      return O_APPEND | O_CREAT | O_RDWR | O_EXCL;
    case "as+":
    case "sa+":
      return O_APPEND | O_CREAT | O_RDWR | O_SYNC;
    default:
      throw invalidArgValue("flags", flags);
  }
}

/** `parseFileMode(value, name, def)`: a uint32 or an octal string. */
export function parseFileMode(value: unknown, name: string, def?: number): number {
  let mode = value ?? def;
  if (typeof mode === "string") {
    if (!/^[0-7]+$/.test(mode)) {
      throw invalidArgValue(name, mode, "must be a 32-bit unsigned integer or an octal string");
    }
    mode = Number.parseInt(mode, 8);
  }
  validateUint32(mode, name);
  return mode;
}

/**
 * The `mode` of `access` and `copyFile`, checked as Node 22's C++ layer does:
 * null/undefined gives the default, a non-number is a TypeError, and the
 * value must lie in 0..7.
 */
export function getValidMode(mode: unknown, type: "access" | "copyFile"): number {
  if (mode == null) {
    return 0;
  }
  if (typeof mode !== "number") {
    throw makeNodeError<TypeError>(
      "ERR_INVALID_ARG_TYPE",
      "mode must be int32 or null/undefined",
      TypeError,
    );
  }
  const value = Math.trunc(mode);
  if (!(value >= 0 && value <= 7)) {
    throw makeNodeError<RangeError>(
      "ERR_OUT_OF_RANGE",
      "mode is out of range: >= 0 && <= 7",
      RangeError,
    );
  }
  // Both modes share the 0..7 range; `type` only names which table applies.
  void type;
  return value;
}

/** `assertEncoding`, with Node's swapped arguments in the message. */
export function assertEncoding(encoding: unknown): void {
  if (encoding && !Buffer.isEncoding(encoding as string)) {
    throw invalidArgValue(String(encoding), "encoding", "is invalid encoding");
  }
}

/** `getOptions(options, defaultOptions)`: a string is the encoding; null or a function gives the defaults. */
export function getOptions<T extends object>(
  options: unknown,
  defaults: T = {} as T,
): T & Record<string, unknown> {
  if (options == null || typeof options === "function") {
    return defaults as T & Record<string, unknown>;
  }
  let result: Record<string, unknown>;
  if (typeof options === "string") {
    result = { ...defaults, encoding: options };
  } else if (typeof options !== "object") {
    throw invalidArgType("options", ["string", "Object"], options);
  } else {
    result = options as Record<string, unknown>;
  }
  if (result.encoding !== "buffer") {
    assertEncoding(result.encoding);
  }
  if (result.signal !== undefined) {
    validateAbortSignal(result.signal, "options.signal");
  }
  return result as T & Record<string, unknown>;
}

/** `toUnixTimestamp(time, name)`: seconds since the epoch. */
export function toUnixTimestamp(time: unknown, name = "time"): number {
  if (typeof time === "string" && Number(time) == (time as unknown as number)) {
    return Number(time);
  }
  if (typeof time === "number" && Number.isFinite(time)) {
    if (time < 0) {
      return Date.now() / 1000;
    }
    return time;
  }
  if (time instanceof Date) {
    return time.getTime() / 1000;
  }
  throw invalidArgType(name, ["Date", "Time in seconds"], time);
}

/** `validateBuffer`. */
export function validateBuffer(
  buffer: unknown,
  name = "buffer",
): asserts buffer is ArrayBufferView {
  if (!ArrayBuffer.isView(buffer)) {
    throw invalidArgType(name, ["Buffer", "TypedArray", "DataView"], buffer);
  }
}

/** `validateStringAfterArrayBufferView`. */
export function validateStringAfterArrayBufferView(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw invalidArgType(name, ["string", "Buffer", "TypedArray", "DataView"], value);
  }
}

/** `validateOffsetLengthRead`. */
export function validateOffsetLengthRead(
  offset: number,
  length: number,
  bufferLength: number,
): void {
  if (offset < 0) {
    throw outOfRange("offset", ">= 0", offset);
  }
  if (length < 0) {
    throw outOfRange("length", ">= 0", length);
  }
  if (offset + length > bufferLength) {
    throw outOfRange("length", `<= ${bufferLength - offset}`, length);
  }
}

/** `validateOffsetLengthWrite`. */
export function validateOffsetLengthWrite(
  offset: number,
  length: number,
  byteLength: number,
): void {
  if (offset > byteLength) {
    throw outOfRange("offset", `<= ${byteLength}`, offset);
  }
  if (length > byteLength - offset) {
    throw outOfRange("length", `<= ${byteLength - offset}`, length);
  }
  if (length < 0) {
    throw outOfRange("length", ">= 0", length);
  }
  validateInteger(length, "length", 0, 2147483647);
}

/** `validatePosition`: an integer >= -1 or a bigint. */
export function validatePosition(position: unknown, name: string, length: number): void {
  if (typeof position === "number") {
    validateInteger(position, name, -1);
  } else if (typeof position === "bigint") {
    const maxPosition = 2n ** 63n - 1n - BigInt(length);
    if (!(position >= -1n && position <= maxPosition)) {
      throw outOfRange(name, `>= -1 && <= ${maxPosition}`, position);
    }
  } else {
    throw invalidArgType(name, ["integer", "bigint"], position);
  }
}

/** A validated read/write position as the backend takes it: null for "the file offset". */
export function backendPosition(position: unknown): number | null {
  if (typeof position === "bigint") {
    return position < 0n ? null : Number(position);
  }
  if (typeof position === "number" && Number.isSafeInteger(position) && position >= 0) {
    return position;
  }
  return null;
}

/** `validateEncoding(data, encoding)`: hex data needs an even length. */
export function validateEncoding(data: string, encoding: unknown): void {
  const normalized = typeof encoding === "string" ? encoding.toLowerCase() : encoding;
  if (normalized === "hex" && data.length % 2 !== 0) {
    throw invalidArgValue("encoding", encoding, `is invalid for data of length ${data.length}`);
  }
}

/** `validateBufferArray`. */
export function validateBufferArray(
  buffers: unknown,
  name = "buffers",
): asserts buffers is ArrayBufferView[] {
  if (!Array.isArray(buffers)) {
    throw invalidArgType(name, "ArrayBufferView[]", buffers);
  }
  for (const buffer of buffers) {
    if (!ArrayBuffer.isView(buffer)) {
      throw invalidArgType(name, "ArrayBufferView[]", buffers);
    }
  }
}

/** The bytes of any ArrayBufferView, without copying. */
export function bytesOf(view: ArrayBufferView): Uint8Array {
  return view instanceof Uint8Array
    ? view
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Wraps a backend result as a Buffer without copying. */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/** Encodes `text` for output: a string for utf8 or no encoding, a Buffer for `"buffer"`, else re-encoded bytes. */
export function encodeText(text: string, encoding: unknown): string | Buffer {
  if (encoding == null || encoding === "utf8" || encoding === "utf-8") {
    return text;
  }
  const buffer = Buffer.from(text, "utf8");
  return encoding === "buffer" ? buffer : buffer.toString(encoding as BufferEncoding);
}

/** Decodes file contents for `readFile`: a Buffer, or a string in `encoding`. */
export function decodeContents(bytes: Uint8Array, encoding: unknown): string | Buffer {
  if (encoding == null || encoding === "buffer") {
    return asBuffer(bytes);
  }
  if (encoding === "utf8" || encoding === "utf-8") {
    return decodeUtf8(bytes);
  }
  return asBuffer(bytes).toString(encoding as BufferEncoding);
}

/** Encodes `data` (string or ArrayBufferView) for writing. */
export function encodeData(data: string | ArrayBufferView, encoding: unknown): Uint8Array {
  if (typeof data !== "string") {
    return bytesOf(data);
  }
  if (encoding == null || encoding === "utf8" || encoding === "utf-8") {
    return encodeUtf8(data);
  }
  return Buffer.from(data, encoding as BufferEncoding);
}
