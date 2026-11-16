// The compression engines behind every zlib class and function: raw DEFLATE
// from fflate's streaming Deflate/Inflate, and webnode's own gzip and zlib
// framing around it (headers, CRC-32/Adler-32 trailers, multi-member gzip,
// preset dictionaries), so header checks, checksum checks and error messages
// match Node's zlib. Engines are synchronous and keep bounded state, so both
// the `*Sync` functions and the streaming classes drive them chunk by chunk.
import { Deflate as FlateDeflate, Inflate as FlateInflate } from "fflate";
import { adler32Update, crc32Update } from "./checksum";

/** Node's flush kinds (`Z_NO_FLUSH` …). */
export const Z_NO_FLUSH = 0;
export const Z_PARTIAL_FLUSH = 1;
export const Z_SYNC_FLUSH = 2;
export const Z_FULL_FLUSH = 3;
export const Z_FINISH = 4;
export const Z_BLOCK = 5;

/** The engine kind, as Node's `mode`. */
export type Mode =
  | "deflate"
  | "inflate"
  | "gzip"
  | "gunzip"
  | "deflateRaw"
  | "inflateRaw"
  | "unzip";

/** What an engine takes from the zlib options. */
export interface EngineOptions {
  level: number;
  windowBits: number;
  strategy: number;
  dictionary?: Uint8Array;
}

/** A zlib error as Node reports it: `errno` and `code`. */
export interface ZlibError extends Error {
  errno: number;
  code: string;
}

const ERRNO: Record<string, number> = {
  Z_NEED_DICT: 2,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_BUF_ERROR: -5,
};

/** Builds a zlib error. */
export function zlibError(message: string, code = "Z_DATA_ERROR"): ZlibError {
  const error = new Error(message) as ZlibError;
  error.errno = ERRNO[code] ?? -3;
  error.code = code;
  return error;
}

function isZlibError(error: unknown): error is ZlibError {
  return error instanceof Error && typeof (error as Partial<ZlibError>).errno === "number";
}

/** fflate's error codes as zlib's messages. */
function fromFlateError(error: unknown): ZlibError {
  if (isZlibError(error)) {
    return error;
  }
  switch ((error as { code?: number }).code) {
    case 0:
      return zlibError("unexpected end of file", "Z_BUF_ERROR");
    case 1:
      return zlibError("invalid block type");
    case 2:
      return zlibError("invalid literal/length code");
    case 3:
      return zlibError("invalid distance too far back");
    default:
      return zlibError(error instanceof Error ? error.message : String(error));
  }
}

/** A compressor or decompressor fed one chunk at a time. */
export interface Engine {
  /** Feeds `chunk`; returns the output it produced. Throws a `ZlibError`. */
  write(chunk: Uint8Array, flush: number): Uint8Array[];
  /** Back to the state of a fresh engine with the same options. */
  reset(): void;
  /** For a decompressor: the stream's end was seen. */
  readonly ended: boolean;
}

/** Builds the engine for `mode`. */
export function createEngine(mode: Mode, options: EngineOptions): Engine {
  switch (mode) {
    case "deflate":
    case "gzip":
    case "deflateRaw":
      return new Compressor(mode, options);
    default:
      return new Decompressor(mode, options);
  }
}

class Compressor implements Engine {
  readonly ended = false;
  private deflater!: FlateDeflate;
  private output: Uint8Array[] = [];
  private headerWritten = false;
  private finished = false;
  private check = 0;
  private size = 0;
  private readonly mode: "deflate" | "gzip" | "deflateRaw";
  private readonly options: EngineOptions;

  constructor(mode: "deflate" | "gzip" | "deflateRaw", options: EngineOptions) {
    this.mode = mode;
    this.options = options;
    this.reset();
  }

  reset(): void {
    const { level, windowBits, dictionary } = this.options;
    // fflate always looks back 32 KiB. A smaller window would let a strict
    // decoder reject its output, so a small window stores the data instead.
    const effective = windowBits < 15 ? 0 : level === -1 ? 6 : level;
    this.deflater = new FlateDeflate(
      {
        level: effective as 0,
        dictionary: this.mode === "gzip" ? undefined : dictionary,
      },
      (data) => {
        if (data.length > 0) {
          this.output.push(data);
        }
      },
    );
    this.output = [];
    this.headerWritten = false;
    this.finished = false;
    this.check = this.mode === "deflate" ? 1 : 0;
    this.size = 0;
  }

  private header(): Uint8Array {
    const level = this.options.level === -1 ? 6 : this.options.level;
    if (this.mode === "gzip") {
      const xfl = level === 9 ? 2 : this.options.strategy >= 2 || level < 2 ? 4 : 0;
      // mtime 0 and OS 3 (Unix), as Node writes on Linux.
      return new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, xfl, 3]);
    }
    const windowBits = Math.max(9, this.options.windowBits);
    const cmf = ((windowBits - 8) << 4) | 8;
    const levelFlags =
      this.options.strategy >= 2 || level < 2 ? 0 : level < 6 ? 1 : level === 6 ? 2 : 3;
    const dictionary = this.options.dictionary;
    let flg = (levelFlags << 6) | (dictionary ? 0x20 : 0);
    flg += 31 - (((cmf << 8) | flg) % 31);
    if (!dictionary) {
      return new Uint8Array([cmf, flg]);
    }
    const id = adler32Update(1, dictionary.subarray(-32768));
    return new Uint8Array([cmf, flg, id >>> 24, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  }

  private trailer(): Uint8Array {
    const check = this.check;
    if (this.mode === "gzip") {
      const size = this.size;
      return new Uint8Array([
        check & 0xff,
        (check >>> 8) & 0xff,
        (check >>> 16) & 0xff,
        check >>> 24,
        size & 0xff,
        (size >>> 8) & 0xff,
        (size >>> 16) & 0xff,
        (size >>> 24) & 0xff,
      ]);
    }
    return new Uint8Array([
      check >>> 24,
      (check >>> 16) & 0xff,
      (check >>> 8) & 0xff,
      check & 0xff,
    ]);
  }

  write(chunk: Uint8Array, flush: number): Uint8Array[] {
    if (this.finished) {
      if (chunk.length > 0) {
        throw zlibError("stream end", "Z_STREAM_ERROR");
      }
      return [];
    }
    if (!this.headerWritten) {
      this.headerWritten = true;
      if (this.mode !== "deflateRaw") {
        this.output.push(this.header());
      }
    }
    if (chunk.length > 0) {
      if (this.mode === "gzip") {
        this.check = crc32Update(this.check, chunk);
        this.size = (this.size + chunk.length) >>> 0;
      } else if (this.mode === "deflate") {
        this.check = adler32Update(this.check, chunk);
      }
    }
    if (flush === Z_FINISH) {
      this.deflater.push(chunk, true);
      if (this.mode !== "deflateRaw") {
        this.output.push(this.trailer());
      }
      this.finished = true;
    } else {
      if (chunk.length > 0) {
        this.deflater.push(chunk, false);
      }
      if (flush === Z_PARTIAL_FLUSH || flush === Z_SYNC_FLUSH || flush === Z_FULL_FLUSH) {
        this.deflater.flush(true);
      } else if (flush === Z_BLOCK) {
        this.deflater.flush(false);
      }
    }
    const output = this.output;
    this.output = [];
    return output;
  }
}

/** fflate's streaming Inflate state, as its own Gunzip reads it. */
interface FlateInflateState {
  s: { f?: number; l?: unknown; p?: number };
  p: Uint8Array;
}

type DecompressorState = "detect" | "header" | "body" | "trailer" | "done";

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  if (b.length === 0) {
    return a;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

class Decompressor implements Engine {
  private format: "zlib" | "gzip" | "raw" | "unzip";
  private state: DecompressorState = "header";
  private pending: Uint8Array = new Uint8Array(0);
  private inflater: FlateInflate | null = null;
  private output: Uint8Array[] = [];
  private check = 0;
  private size = 0;
  private readonly mode: Mode;
  private readonly options: EngineOptions;

  constructor(mode: Mode, options: EngineOptions) {
    this.mode = mode;
    this.options = options;
    this.format = "raw";
    this.reset();
  }

  get ended(): boolean {
    return this.state === "done";
  }

  reset(): void {
    this.format =
      this.mode === "gunzip"
        ? "gzip"
        : this.mode === "inflate"
          ? "zlib"
          : this.mode === "unzip"
            ? "unzip"
            : "raw";
    this.state = this.format === "unzip" ? "detect" : "header";
    this.pending = new Uint8Array(0);
    this.inflater = null;
    this.output = [];
    this.startMember();
  }

  private startMember(): void {
    this.check = this.format === "zlib" ? 1 : 0;
    this.size = 0;
  }

  private startBody(dictionary: Uint8Array | undefined): void {
    this.inflater = new FlateInflate(dictionary ? { dictionary } : {}, (data) => {
      if (data.length === 0) {
        return;
      }
      if (this.format === "gzip") {
        this.check = crc32Update(this.check, data);
        this.size = (this.size + data.length) >>> 0;
      } else if (this.format === "zlib") {
        this.check = adler32Update(this.check, data);
      }
      this.output.push(data);
    });
    this.state = "body";
  }

  /** Parses a header from `input`; returns the bytes after it, or null to wait for more. */
  private parseHeader(input: Uint8Array): Uint8Array | null {
    if (this.format === "raw") {
      this.startBody(this.options.dictionary);
      return input;
    }
    if (this.format === "zlib") {
      if (input.length < 2) {
        return null;
      }
      const cmf = input[0];
      const flg = input[1];
      if (((cmf << 8) | flg) % 31 !== 0) {
        throw zlibError("incorrect header check");
      }
      if ((cmf & 0x0f) !== 8) {
        throw zlibError("unknown compression method");
      }
      const windowBits = (cmf >> 4) + 8;
      if (
        windowBits > 15 ||
        (this.options.windowBits !== 0 && windowBits > this.options.windowBits)
      ) {
        throw zlibError("invalid window size");
      }
      if ((flg & 0x20) === 0) {
        this.startBody(undefined);
        return input.subarray(2);
      }
      if (input.length < 6) {
        return null;
      }
      const dictionary = this.options.dictionary;
      if (!dictionary) {
        throw zlibError("Missing dictionary", "Z_NEED_DICT");
      }
      const id = ((input[2] << 24) | (input[3] << 16) | (input[4] << 8) | input[5]) >>> 0;
      if (adler32Update(1, dictionary.subarray(-32768)) !== id) {
        throw zlibError("Bad dictionary", "Z_NEED_DICT");
      }
      this.startBody(dictionary);
      return input.subarray(6);
    }
    // gzip
    if (input.length < 10) {
      if ((input.length >= 1 && input[0] !== 0x1f) || (input.length >= 2 && input[1] !== 0x8b)) {
        throw zlibError("incorrect header check");
      }
      return null;
    }
    if (input[0] !== 0x1f || input[1] !== 0x8b) {
      throw zlibError("incorrect header check");
    }
    if (input[2] !== 8) {
      throw zlibError("unknown compression method");
    }
    const flags = input[3];
    if (flags & 0xe0) {
      throw zlibError("unknown header flags set");
    }
    let at = 10;
    if (flags & 0x04) {
      if (input.length < at + 2) {
        return null;
      }
      at += 2 + (input[at] | (input[at + 1] << 8));
      if (input.length < at) {
        return null;
      }
    }
    for (const flag of [0x08, 0x10]) {
      if (flags & flag) {
        while (at < input.length && input[at] !== 0) {
          at++;
        }
        if (at >= input.length) {
          return null;
        }
        at++;
      }
    }
    if (flags & 0x02) {
      if (input.length < at + 2) {
        return null;
      }
      const expected = crc32Update(0, input.subarray(0, at)) & 0xffff;
      if ((input[at] | (input[at + 1] << 8)) !== expected) {
        throw zlibError("header crc mismatch");
      }
      at += 2;
    }
    this.startBody(undefined);
    return input.subarray(at);
  }

  /** Checks a trailer; returns the bytes after it, or null to wait for more. */
  private parseTrailer(input: Uint8Array): Uint8Array | null {
    if (this.format === "raw") {
      return input;
    }
    if (this.format === "zlib") {
      if (input.length < 4) {
        return null;
      }
      const stored = ((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) >>> 0;
      if (stored !== this.check) {
        throw zlibError("incorrect data check");
      }
      return input.subarray(4);
    }
    if (input.length < 8) {
      return null;
    }
    const crc = (input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24)) >>> 0;
    if (crc !== this.check) {
      throw zlibError("incorrect data check");
    }
    const size = (input[4] | (input[5] << 8) | (input[6] << 16) | (input[7] << 24)) >>> 0;
    if (size !== this.size) {
      throw zlibError("incorrect length check");
    }
    return input.subarray(8);
  }

  write(chunk: Uint8Array, flush: number): Uint8Array[] {
    try {
      this.process(chunk);
    } catch (error) {
      this.output = [];
      throw fromFlateError(error);
    }
    if (flush === Z_FINISH && this.state !== "done") {
      this.output = [];
      throw zlibError("unexpected end of file", "Z_BUF_ERROR");
    }
    const output = this.output;
    this.output = [];
    return output;
  }

  private process(chunk: Uint8Array): void {
    let input = concat(this.pending, chunk);
    this.pending = new Uint8Array(0);
    for (;;) {
      switch (this.state) {
        case "detect": {
          if (input.length === 0 || (input.length === 1 && input[0] === 0x1f)) {
            this.pending = input;
            return;
          }
          this.format = input[0] === 0x1f && input[1] === 0x8b ? "gzip" : "zlib";
          this.startMember();
          this.state = "header";
          break;
        }
        case "header": {
          if (input.length === 0) {
            return;
          }
          const rest = this.parseHeader(input);
          if (rest === null) {
            this.pending = input;
            return;
          }
          input = rest;
          break;
        }
        case "body": {
          const inflater = this.inflater as FlateInflate;
          if (input.length > 0) {
            inflater.push(input, false);
          }
          input = new Uint8Array(0);
          const state = inflater as unknown as FlateInflateState;
          if (!(state.s.f && !state.s.l)) {
            return;
          }
          // The deflate stream ended: what follows is the trailer.
          input = state.p.subarray(((state.s.p ?? 0) + 7) >> 3);
          this.inflater = null;
          this.state = "trailer";
          break;
        }
        case "trailer": {
          const rest = this.parseTrailer(input);
          if (rest === null) {
            this.pending = input;
            return;
          }
          input = rest;
          this.state = "done";
          break;
        }
        case "done": {
          // Node reads another gzip member unless the next byte is zero padding.
          if (this.format !== "gzip" || input.length === 0 || input[0] === 0) {
            return;
          }
          this.startMember();
          this.state = "header";
          break;
        }
      }
    }
  }
}
