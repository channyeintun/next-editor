// The `querystring` builtin, ported from Node's lib/querystring.js and
// lib/internal/querystring.js (MIT): parse/decode, stringify/encode, escape,
// unescape, unescapeBuffer. `encodeStr` and the hex tables are exported for
// `url`, which shares them as Node's url.js does.
import { Buffer } from "buffer/";
import { makeNodeError } from "./internalErrors";

/** A parsed query: a null-prototype object of strings and string arrays. */
export type ParsedUrlQuery = Record<string, string | string[]>;

/** What `stringify` accepts as a value. */
export type ParsedUrlQueryInput = Record<
  string,
  | string
  | number
  | bigint
  | boolean
  | readonly (string | number | bigint | boolean)[]
  | null
  | undefined
>;

/** `parse` options. */
export interface ParseOptions {
  maxKeys?: number;
  decodeURIComponent?: (value: string) => string;
}

/** `stringify` options. */
export interface StringifyOptions {
  encodeURIComponent?: (value: string) => string;
}

/** `%00` .. `%FF`, indexed by byte. */
export const hexTable: string[] = Array.from(
  { length: 256 },
  (_, i) => "%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase(),
);

/** 1 for the ASCII hex digits. */
// prettier-ignore
export const isHexTable = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 64 - 79
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 96 - 111
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 112 - 127
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128 ...
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // ... 256
]);

/**
 * Percent-encodes `str` as UTF-8, leaving the characters `noEscapeTable` marks.
 * A lone surrogate throws `ERR_INVALID_URI`.
 */
export function encodeStr(str: string, noEscapeTable: Int8Array, hex: readonly string[]): string {
  const len = str.length;
  if (len === 0) {
    return "";
  }

  let out = "";
  let lastPos = 0;
  let i = 0;

  outer: for (; i < len; i++) {
    let c = str.charCodeAt(i);

    // ASCII
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i) {
          out += str.slice(lastPos, i);
        }
        lastPos = i + 1;
        out += hex[c];
      }

      if (++i === len) {
        break outer;
      }

      c = str.charCodeAt(i);
    }

    if (lastPos < i) {
      out += str.slice(lastPos, i);
    }

    // Multi-byte characters ...
    if (c < 0x800) {
      lastPos = i + 1;
      out += hex[0xc0 | (c >> 6)] + hex[0x80 | (c & 0x3f)];
      continue;
    }
    if (c < 0xd800 || c >= 0xe000) {
      lastPos = i + 1;
      out += hex[0xe0 | (c >> 12)] + hex[0x80 | ((c >> 6) & 0x3f)] + hex[0x80 | (c & 0x3f)];
      continue;
    }
    // Surrogate pair
    ++i;

    if (i >= len) {
      throw makeNodeError<URIError>("ERR_INVALID_URI", "URI malformed", URIError);
    }

    const c2 = str.charCodeAt(i) & 0x3ff;

    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3ff) << 10) | c2);
    out +=
      hex[0xf0 | (c >> 18)] +
      hex[0x80 | ((c >> 12) & 0x3f)] +
      hex[0x80 | ((c >> 6) & 0x3f)] +
      hex[0x80 | (c & 0x3f)];
  }
  if (lastPos === 0) {
    return str;
  }
  if (lastPos < len) {
    return out + str.slice(lastPos);
  }
  return out;
}

// prettier-ignore
const unhexTable = new Int8Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 0 - 15
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 16 - 31
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 32 - 47
  +0, +1, +2, +3, +4, +5, +6, +7, +8, +9, -1, -1, -1, -1, -1, -1, // 48 - 63
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 64 - 79
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 80 - 95
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 96 - 111
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 112 - 127
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 128 ...
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // ... 255
]);

/** A safe alternative to decodeURIComponent: decodes `%XX` into bytes. */
export function unescapeBuffer(s: string, decodeSpaces?: boolean): Buffer {
  const out = Buffer.allocUnsafe(s.length);
  let index = 0;
  let outIndex = 0;
  let currentChar: number;
  let nextChar: number;
  let hexHigh: number;
  let hexLow: number;
  const maxLength = s.length - 2;
  // Whether any hex escapes were decoded
  let hasHex = false;
  while (index < s.length) {
    currentChar = s.charCodeAt(index);
    if (currentChar === 43 /* '+' */ && decodeSpaces) {
      out[outIndex++] = 32; // ' '
      index++;
      continue;
    }
    if (currentChar === 37 /* '%' */ && index < maxLength) {
      currentChar = s.charCodeAt(++index);
      hexHigh = unhexTable[currentChar];
      if (!(hexHigh >= 0)) {
        out[outIndex++] = 37; // '%'
        continue;
      } else {
        nextChar = s.charCodeAt(++index);
        hexLow = unhexTable[nextChar];
        if (!(hexLow >= 0)) {
          out[outIndex++] = 37; // '%'
          index--;
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
    }
    out[outIndex++] = currentChar;
    index++;
  }
  return hasHex ? out.slice(0, outIndex) : out;
}

const utf8Decoder = new TextDecoder();

/** `decodeURIComponent`, falling back to a byte-wise decode for bad input. */
function qsUnescape(s: string, decodeSpaces?: boolean): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // TextDecoder, not Buffer#toString: the `buffer` package emits one U+FFFD
    // per byte of a truncated sequence, Node (like WHATWG) one per sequence.
    return utf8Decoder.decode(querystring.unescapeBuffer(s, decodeSpaces));
  }
}

// Characters that need no escaping in a query string:
// ! - . _ ~ ' ( ) * digits alpha
// prettier-ignore
const noEscape = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, // 112 - 127
]);

/** `querystring.escape`: encodeURIComponent tuned for query strings. */
function qsEscape(str: unknown): string {
  let value: string;
  if (typeof str !== "string") {
    value = typeof str === "object" ? String(str) : `${str as string}`;
  } else {
    value = str;
  }
  return encodeStr(value, noEscape, hexTable);
}

function stringifyPrimitive(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return "" + v;
  }
  if (typeof v === "bigint") {
    return "" + v;
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return "";
}

function encodeStringified(v: unknown, encode: (value: string) => string): string {
  if (typeof v === "string") {
    return v.length ? encode(v) : "";
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Values >= 1e21 switch to scientific notation, whose '+' needs escaping.
    return Math.abs(v) < 1e21 ? "" + v : encode("" + v);
  }
  if (typeof v === "bigint") {
    return "" + v;
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return "";
}

function encodeStringifiedCustom(v: unknown, encode: (value: string) => string): string {
  return encode(stringifyPrimitive(v));
}

/** Serializes an object's own enumerable keys into `k=v&k2=v2`. */
function stringify(
  obj: unknown,
  sep?: string | null,
  eq?: string | null,
  options?: StringifyOptions,
): string {
  sep ||= "&";
  eq ||= "=";

  let encode: (value: string) => string = querystring.escape;
  if (options && typeof options.encodeURIComponent === "function") {
    encode = options.encodeURIComponent;
  }
  const convert = encode === qsEscape ? encodeStringified : encodeStringifiedCustom;

  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record);
    const len = keys.length;
    let fields = "";
    for (let i = 0; i < len; ++i) {
      const k = keys[i];
      const v = record[k];
      let ks = convert(k, encode);
      ks += eq;

      if (Array.isArray(v)) {
        const vlen = v.length;
        if (vlen === 0) {
          continue;
        }
        if (fields) {
          fields += sep;
        }
        for (let j = 0; j < vlen; ++j) {
          if (j) {
            fields += sep;
          }
          fields += ks;
          fields += convert(v[j], encode);
        }
      } else {
        if (fields) {
          fields += sep;
        }
        fields += ks;
        fields += convert(v, encode);
      }
    }
    return fields;
  }
  return "";
}

function charCodes(str: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < str.length; ++i) {
    ret.push(str.charCodeAt(i));
  }
  return ret;
}
const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

function addKeyVal(
  obj: ParsedUrlQuery,
  key: string,
  value: string,
  keyEncoded: boolean,
  valEncoded: boolean,
  decode: (value: string, decodeSpaces?: boolean) => string,
): void {
  if (key.length > 0 && keyEncoded) {
    key = decodeStr(key, decode);
  }
  if (value.length > 0 && valEncoded) {
    value = decodeStr(value, decode);
  }

  if (obj[key] === undefined) {
    obj[key] = value;
  } else {
    const curValue = obj[key];
    // Only arrays have `pop`; every value here is ours.
    if (typeof curValue !== "string") {
      curValue[curValue.length] = value;
    } else {
      obj[key] = [curValue, value];
    }
  }
}

/** Parses `k=v&k2=v2` into a null-prototype object; repeated keys collect into arrays. */
function parse(
  qs: unknown,
  sep?: string | null,
  eq?: string | null,
  options?: ParseOptions,
): ParsedUrlQuery {
  const obj = Object.create(null) as ParsedUrlQuery;

  if (typeof qs !== "string" || qs.length === 0) {
    return obj;
  }

  const sepCodes = !sep ? defSepCodes : charCodes(String(sep));
  const eqCodes = !eq ? defEqCodes : charCodes(String(eq));
  const sepLen = sepCodes.length;
  const eqLen = eqCodes.length;

  let pairs = 1000;
  if (options && typeof options.maxKeys === "number") {
    // -1 stands for "unlimited": `pairs` is decremented and compared with 0.
    pairs = options.maxKeys > 0 ? options.maxKeys : -1;
  }

  let decode: (value: string, decodeSpaces?: boolean) => string = querystring.unescape;
  if (options && typeof options.decodeURIComponent === "function") {
    decode = options.decodeURIComponent;
  }
  const customDecode = decode !== qsUnescape;

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = "";
  let value = "";
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar = customDecode ? "%20" : " ";
  let encodeCheck = 0;
  for (let i = 0; i < qs.length; ++i) {
    const code = qs.charCodeAt(i);

    // Try matching key/value pair separator (e.g. '&')
    if (code === sepCodes[sepIdx]) {
      if (++sepIdx === sepLen) {
        // Key/value pair separator match!
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          // We didn't find the (entire) key/value separator
          if (lastPos < end) {
            // Treat the substring as part of the key instead of the value
            key += qs.slice(lastPos, end);
          } else if (key.length === 0) {
            // We saw an empty substring between separators
            if (--pairs === 0) {
              return obj;
            }
            lastPos = i + 1;
            sepIdx = eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value += qs.slice(lastPos, end);
        }

        addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        if (--pairs === 0) {
          return obj;
        }
        keyEncoded = valEncoded = customDecode;
        key = value = "";
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = eqIdx = 0;
      }
    } else {
      sepIdx = 0;
      // Try matching key/value separator (e.g. '=') if we haven't already
      if (eqIdx < eqLen) {
        if (code === eqCodes[eqIdx]) {
          if (++eqIdx === eqLen) {
            // Key/value separator match!
            const end = i - eqIdx + 1;
            if (lastPos < end) {
              key += qs.slice(lastPos, end);
            }
            encodeCheck = 0;
            lastPos = i + 1;
          }
          continue;
        } else {
          eqIdx = 0;
          if (!keyEncoded) {
            // Look for one valid encoded byte, so plain keys skip decoding.
            if (code === 37 /* % */) {
              encodeCheck = 1;
              continue;
            } else if (encodeCheck > 0) {
              if (isHexTable[code] === 1) {
                if (++encodeCheck === 3) {
                  keyEncoded = true;
                }
                continue;
              } else {
                encodeCheck = 0;
              }
            }
          }
        }
        if (code === 43 /* + */) {
          if (lastPos < i) {
            key += qs.slice(lastPos, i);
          }
          key += plusChar;
          lastPos = i + 1;
        }
        continue;
      }
      if (code === 43 /* + */) {
        if (lastPos < i) {
          value += qs.slice(lastPos, i);
        }
        value += plusChar;
        lastPos = i + 1;
      } else if (!valEncoded) {
        // Look for one valid encoded byte, so plain values skip decoding.
        if (code === 37 /* % */) {
          encodeCheck = 1;
        } else if (encodeCheck > 0) {
          if (isHexTable[code] === 1) {
            if (++encodeCheck === 3) {
              valEncoded = true;
            }
          } else {
            encodeCheck = 0;
          }
        }
      }
    }
  }

  // Deal with any leftover key or value data
  if (lastPos < qs.length) {
    if (eqIdx < eqLen) {
      key += qs.slice(lastPos);
    } else if (sepIdx < sepLen) {
      value += qs.slice(lastPos);
    }
  } else if (eqIdx === 0 && key.length === 0) {
    // We ended on an empty substring
    return obj;
  }

  addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}

function decodeStr(s: string, decoder: (value: string, decodeSpaces?: boolean) => string): string {
  try {
    return decoder(s);
  } catch {
    return querystring.unescape(s, true);
  }
}

/** What `require("querystring")` returns. */
const querystring = {
  unescapeBuffer,
  unescape: qsUnescape,
  escape: qsEscape,
  stringify,
  encode: stringify,
  parse,
  decode: parse,
};

export { parse, stringify, qsEscape as escape, qsUnescape as unescape };

export default querystring;
