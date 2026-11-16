// Byte conversion for the crypto builtin: string input decoding, output
// encoding (including `base64url`, which buffer@6 lacks), byte views over
// Buffer/TypedArray/DataView/ArrayBuffer, and the streaming string decoder that
// `Cipheriv#update(…, outputEncoding)` uses.
import { Buffer } from "buffer/";
import { invalidArgType, invalidArgValue } from "./errors";

/** A Node string encoding after normalization. */
export type Encoding = "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex";

/** Node's `normalizeEncoding`: the canonical name, or undefined when unknown. */
export function normalizeEncoding(encoding: unknown): Encoding | undefined {
  if (encoding === undefined || encoding === null || encoding === "") {
    return "utf8";
  }
  switch (String(encoding).toLowerCase()) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return "utf16le";
    case "latin1":
    case "binary":
      return "latin1";
    case "ascii":
      return "ascii";
    case "base64":
      return "base64";
    case "base64url":
      return "base64url";
    case "hex":
      return "hex";
    default:
      return undefined;
  }
}

/** Whether `value` is an ArrayBuffer or SharedArrayBuffer. */
export function isAnyArrayBuffer(value: unknown): value is ArrayBufferLike {
  return (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
    Object.prototype.toString.call(value) === "[object SharedArrayBuffer]"
  );
}

/** A Uint8Array over the same memory as `view` (no copy). */
export function bytesOf(view: ArrayBufferView | ArrayBufferLike): Uint8Array {
  if (ArrayBuffer.isView(view)) {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(view);
}

function base64urlToBase64(text: string): string {
  return text.replace(/-/g, "+").replace(/_/g, "/");
}

/** Decodes `text` the way `Buffer.from(text, encoding)` does in Node; unknown encodings are utf8. */
export function decodeString(text: string, encoding: unknown): Uint8Array {
  const normalized = normalizeEncoding(encoding) ?? "utf8";
  if (normalized === "base64url") {
    return Buffer.from(base64urlToBase64(text), "base64");
  }
  return Buffer.from(text, normalized);
}

/** `bytes` in `encoding`; `base64url` is unpadded. */
export function encodeBytes(bytes: Uint8Array, encoding: Encoding): string {
  const buffer = toBuffer(bytes);
  if (encoding === "base64url") {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return buffer.toString(encoding);
}

/**
 * The output of `digest(encoding)`: a string for a known encoding, else a
 * Buffer (Node returns a Buffer for `"buffer"`, undefined and unknown names).
 */
export function toOutput(bytes: Uint8Array, encoding: unknown): Buffer | string {
  if (encoding === undefined || encoding === null || encoding === "" || encoding === "buffer") {
    return toBuffer(bytes);
  }
  const normalized = normalizeEncoding(encoding);
  return normalized === undefined ? toBuffer(bytes) : encodeBytes(bytes, normalized);
}

/** A Buffer over `bytes` (no copy). */
export function toBuffer(bytes: Uint8Array): Buffer {
  // buffer@6's typings name only ArrayBuffer; its `from` also takes a
  // SharedArrayBuffer (index.js checks for one), which `bytes.buffer` can be.
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The bytes of `data` for `Hash#update`/`Hmac#update`/`Cipheriv#update`:
 * a string in `encoding` (hex must have even length) or an ArrayBufferView.
 */
export function dataBytes(data: unknown, encoding: unknown, name = "data"): Uint8Array {
  if (typeof data === "string") {
    if (normalizeEncoding(encoding) === "hex" && data.length % 2 !== 0) {
      throw invalidArgValue("encoding", encoding, `is invalid for data of length ${data.length}`);
    }
    return decodeString(data, encoding);
  }
  if (ArrayBuffer.isView(data)) {
    return bytesOf(data);
  }
  throw invalidArgType(
    name,
    "of type string or an instance of Buffer, TypedArray, or DataView",
    data,
  );
}

/**
 * Node's `getArrayBufferOrView`: a string (in `encoding`), ArrayBuffer or
 * ArrayBufferView, as bytes.
 */
export function byteSource(value: unknown, name: string, encoding?: unknown): Uint8Array {
  if (typeof value === "string") {
    return decodeString(value, encoding);
  }
  if (ArrayBuffer.isView(value) || isAnyArrayBuffer(value)) {
    return bytesOf(value);
  }
  throw invalidArgType(
    name,
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView",
    value,
  );
}

/** A streaming bytes → string decoder that keeps partial characters/groups between writes. */
export class OutputDecoder {
  readonly encoding: Encoding;
  #pending = new Uint8Array(0);
  #utf8: TextDecoder | null;

  constructor(encoding: Encoding) {
    this.encoding = encoding;
    this.#utf8 = encoding === "utf8" ? new TextDecoder("utf-8") : null;
  }

  /** The text for `bytes`, holding back an incomplete trailing unit. */
  write(bytes: Uint8Array): string {
    if (this.#utf8) {
      return this.#utf8.decode(bytes, { stream: true });
    }
    const all = concatBytes([this.#pending, bytes]);
    const unit =
      this.encoding === "base64" || this.encoding === "base64url"
        ? 3
        : this.encoding === "utf16le"
          ? 2
          : 1;
    const usable = all.length - (all.length % unit);
    this.#pending = all.slice(usable);
    return encodeBytes(all.subarray(0, usable), this.encoding);
  }

  /** The text for `bytes` followed by whatever was held back. */
  end(bytes?: Uint8Array): string {
    if (this.#utf8) {
      return this.#utf8.decode(bytes ?? new Uint8Array(0));
    }
    const all = concatBytes([this.#pending, bytes ?? new Uint8Array(0)]);
    this.#pending = new Uint8Array(0);
    return encodeBytes(all, this.encoding);
  }
}

/** Concatenates byte arrays into a new array. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
