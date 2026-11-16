// Node's string encodings for Buffer: the names Node accepts and, for each, how
// a string becomes bytes and bytes become a string, byte for byte as Node does
// it (forgiving base64 that reads both alphabets, hex that stops at the first
// bad pair, ascii that drops the high bit, utf8 with U+FFFD for bad sequences).

/** The canonical encoding names. */
export type Encoding = "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex";

/** Node's `normalizeEncoding`: the canonical name, or undefined for an unknown one. */
export function normalizeEncoding(encoding: unknown): Encoding | undefined {
  if (encoding === undefined || encoding === null || encoding === "") {
    return "utf8";
  }
  if (typeof encoding !== "string") {
    return undefined;
  }
  switch (encoding.length < 10 ? encoding.toLowerCase() : "") {
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

const SharedArrayBufferCtor: (new (size: number) => ArrayBufferLike) | undefined = (
  globalThis as { SharedArrayBuffer?: new (size: number) => ArrayBufferLike }
).SharedArrayBuffer;

/** A view TextDecoder accepts: browsers refuse views of a SharedArrayBuffer. */
function decodable(bytes: Uint8Array): Uint8Array {
  if (SharedArrayBufferCtor !== undefined && bytes.buffer instanceof SharedArrayBufferCtor) {
    return new Uint8Array(bytes);
  }
  return bytes;
}

const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/** Bytes to a string, UTF-8 with U+FFFD for each bad sequence; keeps a BOM. */
export function utf8Decode(bytes: Uint8Array, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) {
    return "";
  }
  if (length < 32) {
    // Short strings: an ASCII loop beats the TextDecoder call.
    let out = "";
    let i = start;
    for (; i < end; i++) {
      const byte = bytes[i];
      if (byte > 0x7f) {
        break;
      }
      out += String.fromCharCode(byte);
    }
    if (i === end) {
      return out;
    }
  }
  return utf8Decoder.decode(decodable(bytes.subarray(start, end)));
}

/** The UTF-8 length of `string`, lone surrogates counted as U+FFFD (3 bytes). */
export function utf8ByteLength(string: string): number {
  let length = 0;
  const n = string.length;
  for (let i = 0; i < n; i++) {
    const code = string.charCodeAt(i);
    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      const next = string.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}

/** Bytes to a string, one char per byte. */
export function latin1Decode(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 0x2000) {
    const stop = Math.min(end, i + 0x2000);
    out += String.fromCharCode.apply(null, bytes.subarray(i, stop) as unknown as number[]);
  }
  return out;
}

/** Bytes to a string, the high bit of each byte dropped (Node's ascii). */
export function asciiDecode(bytes: Uint8Array, start: number, end: number): string {
  let clean = true;
  for (let i = start; i < end; i++) {
    if (bytes[i] > 0x7f) {
      clean = false;
      break;
    }
  }
  if (clean) {
    return latin1Decode(bytes, start, end);
  }
  const masked = new Uint8Array(end - start);
  for (let i = start; i < end; i++) {
    masked[i - start] = bytes[i] & 0x7f;
  }
  return latin1Decode(masked, 0, masked.length);
}

/** Bytes to a string of UTF-16LE code units; an odd last byte is dropped. */
export function utf16leDecode(bytes: Uint8Array, start: number, end: number): string {
  const units = (end - start) >>> 1;
  let out = "";
  for (let chunk = 0; chunk < units; chunk += 0x2000) {
    const stop = Math.min(units, chunk + 0x2000);
    const codes: number[] = [];
    for (let i = chunk; i < stop; i++) {
      const at = start + i * 2;
      codes.push(bytes[at] | (bytes[at + 1] << 8));
    }
    out += String.fromCharCode.apply(null, codes);
  }
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Bytes to lowercase hex. */
export function hexDecode(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    out += HEX[bytes[i]];
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64Encode(bytes: Uint8Array, start: number, end: number, alphabet: string): string {
  const pad = alphabet === B64;
  let out = "";
  let i = start;
  const full = start + Math.floor((end - start) / 3) * 3;
  // Build in slices so the string concatenation stays cheap.
  const parts: string[] = [];
  for (; i < full; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      alphabet[(n >> 18) & 63] +
      alphabet[(n >> 12) & 63] +
      alphabet[(n >> 6) & 63] +
      alphabet[n & 63];
    if (out.length > 0x4000) {
      parts.push(out);
      out = "";
    }
  }
  const rest = end - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      alphabet[(n >> 18) & 63] +
      alphabet[(n >> 12) & 63] +
      alphabet[(n >> 6) & 63] +
      (pad ? "=" : "");
  }
  parts.push(out);
  return parts.join("");
}

/** Bytes to padded base64. */
export function base64Decode(bytes: Uint8Array, start: number, end: number): string {
  return base64Encode(bytes, start, end, B64);
}

/** Bytes to unpadded base64url. */
export function base64urlDecode(bytes: Uint8Array, start: number, end: number): string {
  return base64Encode(bytes, start, end, B64URL);
}

const UNBASE64 = new Uint8Array(256).fill(255);
for (let i = 0; i < 64; i++) {
  UNBASE64[B64.charCodeAt(i)] = i;
  UNBASE64[B64URL.charCodeAt(i)] = i;
}

/**
 * A base64 or base64url string to bytes, as Node decodes it: either alphabet,
 * characters outside it skipped, decoding stops at the first `=`.
 */
export function base64ToBytes(string: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((string.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let count = 0;
  for (let i = 0; i < string.length; i++) {
    // Node reads each UTF-16 unit by its low byte.
    const code = string.charCodeAt(i) & 0xff;
    if (code === 0x3d) {
      break;
    }
    const value = UNBASE64[code];
    if (value === 255) {
      continue;
    }
    acc = (acc << 6) | value;
    count++;
    if (count === 4) {
      out[o++] = (acc >> 16) & 0xff;
      out[o++] = (acc >> 8) & 0xff;
      out[o++] = acc & 0xff;
      acc = 0;
      count = 0;
    }
  }
  if (count === 2) {
    out[o++] = (acc >> 4) & 0xff;
  } else if (count === 3) {
    out[o++] = (acc >> 10) & 0xff;
    out[o++] = (acc >> 2) & 0xff;
  }
  return out.subarray(0, o);
}

/** Node's estimate of base64's decoded size (what `Buffer.byteLength` reports). */
export function base64ByteLength(string: string): number {
  let bytes = string.length;
  if (bytes > 0 && string.charCodeAt(bytes - 1) === 0x3d) {
    bytes--;
  }
  if (bytes > 1 && string.charCodeAt(bytes - 1) === 0x3d) {
    bytes--;
  }
  return (bytes * 3) >>> 2;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  if (code >= 65 && code <= 70) {
    return code - 55;
  }
  return -1;
}

/** Writes hex pairs into `target` until a bad pair or the end of space. */
function hexWriteInto(target: Uint8Array, string: string, offset: number, length: number): number {
  const pairs = Math.min(length, string.length >>> 1);
  let i = 0;
  for (; i < pairs; i++) {
    const high = hexValue(string.charCodeAt(i * 2));
    const low = hexValue(string.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) {
      break;
    }
    target[offset + i] = (high << 4) | low;
  }
  return i;
}

/**
 * Writes `string` into `target[offset, offset + length)` in `encoding`; returns
 * the bytes written. Never writes a partial character.
 */
export function writeString(
  target: Uint8Array,
  string: string,
  offset: number,
  length: number,
  encoding: Encoding,
): number {
  length = Math.max(0, Math.min(length, target.length - offset));
  switch (encoding) {
    case "utf8": {
      if (length === 0) {
        return 0;
      }
      const view = new Uint8Array(target.buffer, target.byteOffset + offset, length);
      return utf8Encoder.encodeInto(string, view).written ?? 0;
    }
    case "latin1":
    case "ascii": {
      const n = Math.min(length, string.length);
      for (let i = 0; i < n; i++) {
        target[offset + i] = string.charCodeAt(i) & 0xff;
      }
      return n;
    }
    case "utf16le": {
      const units = Math.min(length >>> 1, string.length);
      for (let i = 0; i < units; i++) {
        const code = string.charCodeAt(i);
        target[offset + i * 2] = code & 0xff;
        target[offset + i * 2 + 1] = code >>> 8;
      }
      return units * 2;
    }
    case "hex":
      return hexWriteInto(target, string, offset, length);
    case "base64":
    case "base64url": {
      const bytes = base64ToBytes(string);
      const n = Math.min(length, bytes.length);
      target.set(n === bytes.length ? bytes : bytes.subarray(0, n), offset);
      return n;
    }
  }
}

/** `string` as bytes in `encoding`. */
export function encodeString(string: string, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return utf8Encoder.encode(string);
    case "base64":
    case "base64url":
      return base64ToBytes(string);
    default: {
      const out = new Uint8Array(byteLengthOf(string, encoding));
      const written = writeString(out, string, 0, out.length, encoding);
      return written === out.length ? out : out.subarray(0, written);
    }
  }
}

/** What `Buffer.byteLength(string, encoding)` reports. */
export function byteLengthOf(string: string, encoding: Encoding): number {
  switch (encoding) {
    case "utf8":
      return utf8ByteLength(string);
    case "latin1":
    case "ascii":
      return string.length;
    case "utf16le":
      return string.length * 2;
    case "hex":
      return string.length >>> 1;
    case "base64":
    case "base64url":
      return base64ByteLength(string);
  }
}

/** `bytes[start, end)` as a string in `encoding`. */
export function decodeBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
  encoding: Encoding,
): string {
  switch (encoding) {
    case "utf8":
      return utf8Decode(bytes, start, end);
    case "latin1":
      return latin1Decode(bytes, start, end);
    case "ascii":
      return asciiDecode(bytes, start, end);
    case "utf16le":
      return utf16leDecode(bytes, start, end);
    case "hex":
      return hexDecode(bytes, start, end);
    case "base64":
      return base64Decode(bytes, start, end);
    case "base64url":
      return base64urlDecode(bytes, start, end);
  }
}

/** Whether `bytes` is well-formed UTF-8. */
export function isUtf8Bytes(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(decodable(bytes));
    return true;
  } catch {
    return false;
  }
}

/** Whether every byte of `bytes` is below 0x80. */
export function isAsciiBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7f) {
      return false;
    }
  }
  return true;
}
