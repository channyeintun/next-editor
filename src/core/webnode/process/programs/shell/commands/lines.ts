// How the text commands read and write text: a UTF-8 codec that gives back
// every byte it was given (so `sed -i` or `tr` on a file that is not UTF-8
// does not change the bytes it did not touch), and a reader that hands out
// the lines of standard input as they arrive, so `server | grep ready`
// prints as soon as the line is written.
import { runtime } from "../../../runtime";
import type { CommandContext } from "../context";
import { concatBytes } from "../io";
import { decodeEscape } from "../lexer";
import { errorText, isDir } from "./util";

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
/** The characters decodeText puts in place of bytes that are not UTF-8. */
const RAW_BYTES = /[\uDC80-\uDCFF]/gu;

/** The length of the valid UTF-8 sequence at `i`, or 0 when the byte there starts none. */
function sequenceLength(bytes: Uint8Array, i: number): number {
  const b = bytes[i];
  const cont = (at: number, low = 0x80, high = 0xbf): boolean =>
    at < bytes.length && bytes[at] >= low && bytes[at] <= high;
  if (b >= 0xc2 && b <= 0xdf) {
    return cont(i + 1) ? 2 : 0;
  }
  if (b >= 0xe0 && b <= 0xef) {
    const low = b === 0xe0 ? 0xa0 : 0x80;
    const high = b === 0xed ? 0x9f : 0xbf;
    return cont(i + 1, low, high) && cont(i + 2) ? 3 : 0;
  }
  if (b >= 0xf0 && b <= 0xf4) {
    const low = b === 0xf0 ? 0x90 : 0x80;
    const high = b === 0xf4 ? 0x8f : 0xbf;
    return cont(i + 1, low, high) && cont(i + 2) && cont(i + 3) ? 4 : 0;
  }
  return 0;
}

/**
 * Decodes UTF-8. A byte that is not part of valid UTF-8 becomes the lone
 * surrogate U+DC00+byte (Python's "surrogateescape"), which valid UTF-8 never
 * decodes to, so encodeText gives the same byte back.
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    let out = "";
    let start = 0;
    for (let i = 0; i < bytes.length;) {
      if (bytes[i] < 0x80) {
        i++;
        continue;
      }
      const length = sequenceLength(bytes, i);
      if (length > 0) {
        i += length;
        continue;
      }
      out += strict.decode(bytes.subarray(start, i)) + String.fromCharCode(0xdc00 + bytes[i]);
      i++;
      start = i;
    }
    return out + strict.decode(bytes.subarray(start));
  }
}

/** Encodes text as UTF-8, turning decodeText's stand-ins back into their bytes. */
export function encodeText(text: string): Uint8Array {
  RAW_BYTES.lastIndex = 0;
  if (!RAW_BYTES.test(text)) {
    return encoder.encode(text);
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  let last = 0;
  RAW_BYTES.lastIndex = 0;
  for (const match of text.matchAll(RAW_BYTES)) {
    const before = encoder.encode(text.slice(last, match.index));
    parts.push(before, Uint8Array.of(match[0].charCodeAt(0) - 0xdc00));
    total += before.length + 1;
    last = match.index + 1;
  }
  const rest = encoder.encode(text.slice(last));
  parts.push(rest);
  total += rest.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * decodeEscape for output: `\NNN` and `\xHH` name one byte, not a character,
 * so a value of 0x80 or more becomes decodeText's stand-in for that byte and
 * encodeText writes the byte itself (`printf '\377'` is the byte ff).
 */
export function byteEscape(e: string, peek: () => string, advance: () => void): string {
  const text = decodeEscape(e, peek, advance);
  return /^[0-7x]$/.test(e) && text.length === 1 && text.charCodeAt(0) >= 0x80
    ? byteChar(text.charCodeAt(0))
    : text;
}

/** The character encodeText writes as the single byte `byte`. */
export function byteChar(byte: number): string {
  return byte >= 0x80 ? String.fromCharCode(0xdc00 + byte) : String.fromCharCode(byte);
}

/** Writes text to standard output; false once the reader is gone (stop reading then). */
export function writeText(ctx: CommandContext, text: string): boolean {
  if (text !== "") {
    ctx.io.out(encodeText(text));
  }
  return !ctx.io.broken;
}

/** Complete lines of one input, without their newlines. */
export interface LineBatch {
  name: string;
  lines: string[];
  /** The last line of `lines` ended the input without a newline. */
  noNewline: boolean;
}

/** Splits decoded text that ends just after a newline (or is a last partial line). */
function splitBlock(bytes: Uint8Array, complete: boolean): string[] {
  const text = decodeText(complete ? bytes.subarray(0, bytes.length - 1) : bytes);
  return text.split("\n");
}

/**
 * The lines of each input (every named file, `-` is standard input, standard
 * input when there are none). Standard input yields the complete lines of
 * each chunk as it is read, so a command that writes after each batch writes
 * as its input arrives; a consumer that stops iterating stops the reading.
 * A file that cannot be read yields `{ name, error }` (`name: reason`).
 */
export async function* inputLines(
  ctx: CommandContext,
  files: string[],
): AsyncGenerator<LineBatch | { name: string; error: string }> {
  if (files.length === 0) {
    files = ["-"];
  }
  for (const file of files) {
    if (file === "-") {
      // The start of a line whose newline has not arrived yet.
      let carry: Uint8Array[] = [];
      for (;;) {
        const chunk = await ctx.io.readChunk();
        if (chunk.length === 0) {
          break;
        }
        const end = chunk.lastIndexOf(10);
        if (end < 0) {
          carry.push(chunk);
          continue;
        }
        const block = concatBytes([...carry, chunk.subarray(0, end + 1)]);
        carry = end + 1 < chunk.length ? [chunk.slice(end + 1)] : [];
        yield { name: file, lines: splitBlock(block, true), noNewline: false };
      }
      if (carry.length > 0) {
        yield { name: file, lines: splitBlock(concatBytes(carry), false), noNewline: true };
      }
      continue;
    }
    let data: Uint8Array;
    try {
      const path = ctx.resolve(file);
      if (isDir(runtime().fs.stat(path, true))) {
        yield { name: file, error: `${file}: Is a directory` };
        continue;
      }
      data = runtime().fs.readFile(path);
    } catch (error) {
      yield { name: file, error: `${file}: ${errorText(error)}` };
      continue;
    }
    if (data.length > 0) {
      const complete = data[data.length - 1] === 10;
      yield { name: file, lines: splitBlock(data, complete), noNewline: !complete };
    }
  }
}
