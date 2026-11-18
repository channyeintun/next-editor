// The `zlib` builtin: gzip, zlib (deflate) and raw deflate over fflate, with
// Node's framing, checks and errors from zlib/engine.ts. Streaming classes are
// `stream.Transform`s; the `*Sync` functions run an engine in one call. Node
// runs a stream's chunks and the callback forms on its thread pool, so here
// their results come from the event loop, each in a task of its own. Brotli
// and zstd are present and throw.
import { captureAsyncContext } from "./async_hooks";
import { Buffer } from "./buffer";
import { nextTick } from "./eventLoop";
import { complete } from "./fs/completion";
import { runJob, type JobCallback } from "./internal/threadPoolJob";
import {
  invalidArgType,
  makeNodeError,
  outOfRange,
  validateFunction,
  validateInteger,
} from "./internalErrors";
import stream from "./stream";
import type { StreamCallback, TransformOptions } from "./stream";
import { crc32Update } from "./zlib/checksum";
import { codes, constants } from "./zlib/constants";
import {
  Z_BLOCK,
  Z_FINISH,
  Z_FULL_FLUSH,
  Z_NO_FLUSH,
  Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH,
  createEngine,
  type Engine,
  type Mode,
} from "./zlib/engine";

export { codes, constants };

const kMaxLength = 2 ** 53 - 1;

/** The options every zlib class takes. */
export interface ZlibOptions extends Omit<TransformOptions, "flush"> {
  flush?: number;
  finishFlush?: number;
  chunkSize?: number;
  windowBits?: number;
  level?: number;
  memLevel?: number;
  strategy?: number;
  dictionary?: ArrayBufferView | ArrayBuffer;
  info?: boolean;
  maxOutputLength?: number;
}

/** `checkFiniteNumber` (lib/zlib.js): false for undefined/NaN, throws for the rest. */
function checkFiniteNumber(value: unknown, name: string): value is number {
  if (value === undefined) {
    return false;
  }
  if (Number.isFinite(value)) {
    return true;
  }
  if (Number.isNaN(value)) {
    return false;
  }
  if (typeof value !== "number") {
    throw invalidArgType(name, "number", value);
  }
  throw outOfRange(name, "a finite number", value);
}

/** `checkRangesOrGetDefault` (lib/zlib.js). */
function checkRange(
  value: unknown,
  name: string,
  lower: number,
  upper: number,
  fallback: number,
): number {
  if (!checkFiniteNumber(value, name)) {
    return fallback;
  }
  if (value < lower || value > upper) {
    throw outOfRange(name, `>= ${lower} and <= ${upper}`, value);
  }
  return value;
}

function toBytes(value: unknown, name: string, allowString: boolean): Uint8Array {
  if (allowString && typeof value === "string") {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
  ) {
    return new Uint8Array(value);
  }
  throw invalidArgType(
    name,
    allowString
      ? ["string", "Buffer", "TypedArray", "DataView", "ArrayBuffer"]
      : ["Buffer", "TypedArray", "DataView", "ArrayBuffer"],
    value,
  );
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concatAll(parts: Uint8Array[], total: number): Buffer {
  if (parts.length === 1) {
    return asBuffer(parts[0]);
  }
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** How much each flush kind does, least first: Node's `flushiness`. */
const FLUSH_ORDER = [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH];

/** Node's `maxFlush`: the flush kind that does more. */
function maxFlush(a: number, b: number): number {
  return FLUSH_ORDER.indexOf(a) > FLUSH_ORDER.indexOf(b) ? a : b;
}

function bufferTooLarge(max: number): Error {
  return makeNodeError(
    "ERR_BUFFER_TOO_LARGE",
    `Cannot create a Buffer larger than ${max} bytes`,
    RangeError,
  );
}

function bindingClosed(): Error {
  return makeNodeError("ERR_ZLIB_BINDING_CLOSED", "zlib binding closed", Error);
}

/**
 * Stands in for Node's native zlib handle (`stream._handle`) and holds the
 * engine. minizlib, the zlib layer of `tar`, reaches for it: it turns
 * `_handle.close` into a no-op around each `_processChunk` call (which closes
 * the handle in Node) and puts `_handle` back afterwards.
 */
class ZlibHandle {
  engine: Engine | null;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  close(): void {
    this.engine = null;
  }

  reset(): void {
    if (this.engine === null) {
      throw bindingClosed();
    }
    this.engine.reset();
  }
}

/** The base of every zlib stream: Node's `ZlibBase` + `Zlib` over an engine. */
class ZlibBase extends stream.Transform {
  /** Input bytes taken so far. */
  bytesWritten = 0;
  _chunkSize: number;
  _defaultFlushFlag: number;
  _finishFlushFlag: number;
  _defaultFullFlushFlag: number;
  _maxOutputLength: number;
  _info: boolean;
  _level: number;
  _strategy: number;
  /** Node's native handle; null once the stream is closed. */
  _handle: ZlibHandle | null;
  #pendingFlushes: number[] = [];
  /** Binds a callback to the async context the stream was made in, where Node runs its handle's callbacks. */
  readonly #inOwnContext = captureAsyncContext();

  constructor(options: ZlibOptions | undefined, mode: Mode) {
    let opts = options;
    let chunkSize: number = constants.Z_DEFAULT_CHUNK;
    let flush = Z_NO_FLUSH;
    let finishFlush = Z_FINISH;
    let maxOutputLength = kMaxLength;
    let windowBits: number = constants.Z_DEFAULT_WINDOWBITS;
    let level: number = constants.Z_DEFAULT_COMPRESSION;
    let strategy: number = constants.Z_DEFAULT_STRATEGY;
    let dictionary: Uint8Array | undefined;
    if (opts) {
      if (!checkFiniteNumber(opts.chunkSize, "options.chunkSize")) {
        chunkSize = constants.Z_DEFAULT_CHUNK;
      } else if (opts.chunkSize < constants.Z_MIN_CHUNK) {
        throw outOfRange("options.chunkSize", `>= ${constants.Z_MIN_CHUNK}`, opts.chunkSize);
      } else {
        chunkSize = opts.chunkSize;
      }
      flush = checkRange(opts.flush, "options.flush", Z_NO_FLUSH, constants.Z_BLOCK, flush);
      finishFlush = checkRange(
        opts.finishFlush,
        "options.finishFlush",
        Z_NO_FLUSH,
        constants.Z_BLOCK,
        finishFlush,
      );
      maxOutputLength = checkRange(
        opts.maxOutputLength,
        "options.maxOutputLength",
        1,
        kMaxLength,
        kMaxLength,
      );
      if (
        (opts.windowBits == null || opts.windowBits === 0) &&
        (mode === "inflate" || mode === "gunzip" || mode === "unzip")
      ) {
        windowBits = 0;
      } else {
        const min = constants.Z_MIN_WINDOWBITS + (mode === "gzip" ? 1 : 0);
        windowBits = checkRange(
          opts.windowBits,
          "options.windowBits",
          min,
          constants.Z_MAX_WINDOWBITS,
          constants.Z_DEFAULT_WINDOWBITS,
        );
      }
      level = checkRange(
        opts.level,
        "options.level",
        constants.Z_MIN_LEVEL,
        constants.Z_MAX_LEVEL,
        constants.Z_DEFAULT_COMPRESSION,
      );
      checkRange(
        opts.memLevel,
        "options.memLevel",
        constants.Z_MIN_MEMLEVEL,
        constants.Z_MAX_MEMLEVEL,
        constants.Z_DEFAULT_MEMLEVEL,
      );
      strategy = checkRange(
        opts.strategy,
        "options.strategy",
        constants.Z_DEFAULT_STRATEGY,
        constants.Z_FIXED,
        constants.Z_DEFAULT_STRATEGY,
      );
      if (opts.dictionary !== undefined) {
        dictionary = new Uint8Array(toBytes(opts.dictionary, "options.dictionary", false));
      }
      if (
        opts.encoding ||
        opts.objectMode ||
        (opts as { writableObjectMode?: boolean }).writableObjectMode
      ) {
        opts = { ...opts, encoding: null, objectMode: false };
        (opts as { writableObjectMode?: boolean }).writableObjectMode = false;
      }
    }
    // Transform ignores a non-function `flush`, as in Node.
    super({ autoDestroy: true, ...opts } as TransformOptions);
    this._chunkSize = chunkSize;
    this._defaultFlushFlag = flush;
    this._finishFlushFlag = finishFlush;
    this._defaultFullFlushFlag = Z_FULL_FLUSH;
    this._maxOutputLength = maxOutputLength;
    this._info = Boolean(opts?.info);
    this._level = level;
    this._strategy = strategy;
    this._handle = new ZlibHandle(createEngine(mode, { level, windowBits, strategy, dictionary }));
  }

  /** Whether the handle is gone (after `close()`, `destroy()` or `_processChunk`). */
  get _closed(): boolean {
    return !this._handle;
  }

  /** Node's `_close`: closes the handle and lets go of it. */
  #closeHandle(): void {
    this._handle?.close();
    this._handle = null;
  }

  /** Runs the engine over `chunk`; returns its output, unsplit. */
  _runEngine(chunk: Uint8Array, flushFlag: number): Uint8Array[] {
    const engine = this._handle?.engine ?? null;
    if (engine === null) {
      throw bindingClosed();
    }
    const output = engine.write(chunk, flushFlag);
    this.bytesWritten += chunk.length;
    return output;
  }

  #pushOutput(output: Uint8Array[]): void {
    const size = this._chunkSize;
    let total = 0;
    for (const part of output) {
      total += part.length;
    }
    if (output.length > 1 && total <= size) {
      // What one run gave fits one chunk: one push, as Node's output buffer.
      this.push(concatAll(output, total));
      return;
    }
    for (const part of output) {
      for (let at = 0; at < part.length; at += size) {
        this.push(asBuffer(at === 0 && part.length <= size ? part : part.subarray(at, at + size)));
      }
    }
  }

  /**
   * Runs the engine over `chunk` and finishes as Node's zlib does once its
   * thread pool has run a chunk: from the event loop, in a task of its own.
   * The output is pushed there and `callback` follows; a run that failed
   * destroys the stream, and its callback is never called.
   */
  #runChunk(chunk: Uint8Array, flushFlag: number, callback: StreamCallback): void {
    let output: Uint8Array[] = [];
    let failure: { error: Error } | null = null;
    try {
      output = this._runEngine(chunk, flushFlag);
    } catch (error) {
      failure = { error: error as Error };
    }
    complete(
      this.#inOwnContext(() => {
        if (failure !== null) {
          this.destroy(failure.error);
          return;
        }
        if (!this.destroyed) {
          this.#pushOutput(output);
        }
        callback();
      }),
    );
  }

  override _transform(chunk: Uint8Array, _encoding: string, callback: StreamCallback): void {
    let flushFlag = this._defaultFlushFlag;
    if (chunk.length === 0 && this.#pendingFlushes.length > 0) {
      flushFlag = this.#pendingFlushes.shift() as number;
    }
    // The last chunk of an ended stream is also the one that finishes it.
    if (this.writableEnded && this.writableLength === chunk.byteLength) {
      flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
    }
    this.#runChunk(chunk, flushFlag, callback);
  }

  override _flush(callback: StreamCallback): void {
    this.#runChunk(new Uint8Array(0), this._finishFlushFlag, callback);
  }

  /**
   * Done at once, as in Node: 'finish' does not wait for the last flush, which
   * Transform then starts from 'prefinish' and which ends the readable side.
   */
  override _final(callback: StreamCallback): void {
    callback();
  }

  override _destroy(error: Error | null, callback: StreamCallback): void {
    this.#closeHandle();
    callback(error);
  }

  /** Flushes what the engine holds; `kind` defaults to `Z_FULL_FLUSH`. */
  flush(kind?: number | (() => void), callback?: () => void): void {
    if (typeof kind === "function" || (kind === undefined && !callback)) {
      callback = kind as (() => void) | undefined;
      kind = this._defaultFullFlushFlag;
    }
    const flushKind = (kind ?? this._defaultFullFlushFlag) as number;
    if (this.writableFinished) {
      if (callback) {
        nextTick(callback);
      }
    } else if (this.writableEnded) {
      if (callback) {
        this.once("end", callback);
      }
    } else {
      this.#pendingFlushes.push(flushKind);
      this.write(Buffer.alloc(0), "", callback as StreamCallback | undefined);
    }
  }

  /** Destroys the stream; `callback` runs once it has closed. */
  close(callback?: (error?: Error | null) => void): void {
    if (callback) {
      stream.finished(this, callback);
    }
    this.destroy();
  }

  /** Restarts the engine, dropping its state. */
  reset(): void {
    if (!this._handle) {
      throw bindingClosed();
    }
    this._handle.reset();
  }

  /**
   * Node's `params(level, strategy, callback)`. Validates both and flushes;
   * the engine keeps compressing at its original level (fflate cannot switch
   * mid-stream), which keeps the output valid.
   */
  params(level: number, strategy: number, callback?: () => void): void {
    checkRange(level, "level", constants.Z_MIN_LEVEL, constants.Z_MAX_LEVEL, 0);
    checkRange(strategy, "strategy", constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, 0);
    this.flush(Z_SYNC_FLUSH, callback);
  }

  /** Node's legacy synchronous `_processChunk(chunk, flushFlag)`. */
  _processChunk(chunk: Uint8Array, flushFlag: number, callback?: unknown): Buffer {
    if (callback !== undefined) {
      throw new Error("zlib._processChunk with a callback is not available in webnode");
    }
    let output: Uint8Array[];
    try {
      output = this._runEngine(toBytes(chunk, "buffer", true), flushFlag);
    } finally {
      // Node closes the handle after a synchronous run.
      this.#closeHandle();
    }
    let total = 0;
    for (const part of output) {
      total += part.length;
    }
    if (total > this._maxOutputLength) {
      throw bufferTooLarge(this._maxOutputLength);
    }
    return total === 0 ? Buffer.alloc(0) : concatAll(output, total);
  }
}

/** Lets a class be called without `new`, as Node's zlib constructors can. */
function callable<C extends new (options?: ZlibOptions) => ZlibBase>(
  Class: C,
): C & ((options?: ZlibOptions) => InstanceType<C>) {
  return new Proxy(Class, {
    apply: (target, _thisArg, args: [ZlibOptions?]) => new target(...args),
  }) as C & ((options?: ZlibOptions) => InstanceType<C>);
}

class DeflateImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(options, "deflate");
  }
}
class InflateImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(options, "inflate");
  }
}
class GzipImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(options, "gzip");
  }
}
class GunzipImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(options, "gunzip");
  }
}
class DeflateRawImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    // Node turns windowBits 8 into 9 for raw deflate.
    super(
      options && options.windowBits === 8 ? { ...options, windowBits: 9 } : options,
      "deflateRaw",
    );
  }
}
class InflateRawImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(options, "inflateRaw");
  }
}
class UnzipImpl extends ZlibBase {
  constructor(options?: ZlibOptions) {
    super(options, "unzip");
  }
}
Object.defineProperty(DeflateImpl, "name", { value: "Deflate" });
Object.defineProperty(InflateImpl, "name", { value: "Inflate" });
Object.defineProperty(GzipImpl, "name", { value: "Gzip" });
Object.defineProperty(GunzipImpl, "name", { value: "Gunzip" });
Object.defineProperty(DeflateRawImpl, "name", { value: "DeflateRaw" });
Object.defineProperty(InflateRawImpl, "name", { value: "InflateRaw" });
Object.defineProperty(UnzipImpl, "name", { value: "Unzip" });

/** A zlib stream instance. */
export type ZlibStream = ZlibBase;

/** `zlib.Deflate`. */
export const Deflate = callable(DeflateImpl);
/** `zlib.Inflate`. */
export const Inflate = callable(InflateImpl);
/** `zlib.Gzip`. */
export const Gzip = callable(GzipImpl);
/** `zlib.Gunzip`. */
export const Gunzip = callable(GunzipImpl);
/** `zlib.DeflateRaw`. */
export const DeflateRaw = callable(DeflateRawImpl);
/** `zlib.InflateRaw`. */
export const InflateRaw = callable(InflateRawImpl);
/** `zlib.Unzip`. */
export const Unzip = callable(UnzipImpl);

type ZlibClass = new (options?: ZlibOptions) => ZlibBase;

/** Node's `zlibBufferSync`: one engine run over the whole input. */
function runSync(
  Class: ZlibClass,
  buffer: unknown,
  options?: ZlibOptions,
): Buffer | { buffer: Buffer; engine: ZlibBase } {
  const input = toBytes(buffer, "buffer", true);
  return runEngine(new Class(options), input);
}

/** One run of `engine` over all of `input`, then the engine is done. */
function runEngine(
  engine: ZlibBase,
  input: Uint8Array,
): Buffer | { buffer: Buffer; engine: ZlibBase } {
  const result = engine._processChunk(input, engine._finishFlushFlag);
  engine.destroy();
  return engine._info ? { buffer: result, engine } : result;
}

type ZlibCallback = JobCallback<Buffer | { buffer: Buffer; engine: ZlibBase }>;

/** Node's `zlibBuffer`: the callback form, completing from the event loop. */
function runAsync(Class: ZlibClass, buffer: unknown, options: unknown, callback: unknown): void {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  // Made first, so bad options throw here, as in Node; only the run waits.
  const engine = new Class(options as ZlibOptions | undefined);
  validateFunction(callback, "callback");
  const input = toBytes(buffer, "buffer", true);
  const copy = new Uint8Array(input);
  runJob(() => runEngine(engine, copy), callback as ZlibCallback);
}

function syncFn(Class: ZlibClass, name: string) {
  const fn = (buffer: unknown, options?: ZlibOptions): Buffer =>
    runSync(Class, buffer, options) as Buffer;
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

function asyncFn(Class: ZlibClass, name: string) {
  const fn = (buffer: unknown, options: unknown, callback?: unknown): void =>
    runAsync(Class, buffer, options, callback);
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/** `zlib.deflateSync`. */
export const deflateSync = syncFn(DeflateImpl, "deflateSync");
/** `zlib.inflateSync`. */
export const inflateSync = syncFn(InflateImpl, "inflateSync");
/** `zlib.gzipSync`. */
export const gzipSync = syncFn(GzipImpl, "gzipSync");
/** `zlib.gunzipSync`. */
export const gunzipSync = syncFn(GunzipImpl, "gunzipSync");
/** `zlib.deflateRawSync`. */
export const deflateRawSync = syncFn(DeflateRawImpl, "deflateRawSync");
/** `zlib.inflateRawSync`. */
export const inflateRawSync = syncFn(InflateRawImpl, "inflateRawSync");
/** `zlib.unzipSync`. */
export const unzipSync = syncFn(UnzipImpl, "unzipSync");

/** `zlib.deflate`. */
export const deflate = asyncFn(DeflateImpl, "deflate");
/** `zlib.inflate`. */
export const inflate = asyncFn(InflateImpl, "inflate");
/** `zlib.gzip`. */
export const gzip = asyncFn(GzipImpl, "gzip");
/** `zlib.gunzip`. */
export const gunzip = asyncFn(GunzipImpl, "gunzip");
/** `zlib.deflateRaw`. */
export const deflateRaw = asyncFn(DeflateRawImpl, "deflateRaw");
/** `zlib.inflateRaw`. */
export const inflateRaw = asyncFn(InflateRawImpl, "inflateRaw");
/** `zlib.unzip`. */
export const unzip = asyncFn(UnzipImpl, "unzip");

/** `zlib.createDeflate`. */
export const createDeflate = (options?: ZlibOptions) => new DeflateImpl(options);
/** `zlib.createInflate`. */
export const createInflate = (options?: ZlibOptions) => new InflateImpl(options);
/** `zlib.createGzip`. */
export const createGzip = (options?: ZlibOptions) => new GzipImpl(options);
/** `zlib.createGunzip`. */
export const createGunzip = (options?: ZlibOptions) => new GunzipImpl(options);
/** `zlib.createDeflateRaw`. */
export const createDeflateRaw = (options?: ZlibOptions) => new DeflateRawImpl(options);
/** `zlib.createInflateRaw`. */
export const createInflateRaw = (options?: ZlibOptions) => new InflateRawImpl(options);
/** `zlib.createUnzip`. */
export const createUnzip = (options?: ZlibOptions) => new UnzipImpl(options);

/** `zlib.crc32(data, value)`: the CRC-32 of `data`, continuing from `value`. */
export function crc32(data: unknown, value: unknown = 0): number {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = Buffer.from(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw invalidArgType("data", ["Buffer", "TypedArray", "DataView", "string"], data);
  }
  validateInteger(value, "value", 0, 0xffffffff);
  return crc32Update(value, bytes);
}

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `zlib.${name} is not available in webnode`,
    Error,
  );
}

function unavailableFn(name: string): (...args: unknown[]) => never {
  const fn = (): never => {
    throw unavailable(name);
  };
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

/** A constructor that throws: brotli and zstd have no engine in webnode. */
function unavailableClass(name: string): new (...args: unknown[]) => never {
  const Class = function (): never {
    throw unavailable(name);
  } as unknown as new (...args: unknown[]) => never;
  Object.defineProperty(Class, "name", { value: name });
  return Class;
}

/** What `require("zlib")` returns. */
const zlibModule = {
  crc32,
  Deflate,
  Inflate,
  Gzip,
  Gunzip,
  DeflateRaw,
  InflateRaw,
  Unzip,
  BrotliCompress: unavailableClass("BrotliCompress"),
  BrotliDecompress: unavailableClass("BrotliDecompress"),
  ZstdCompress: unavailableClass("ZstdCompress"),
  ZstdDecompress: unavailableClass("ZstdDecompress"),
  deflate,
  deflateSync,
  gzip,
  gzipSync,
  deflateRaw,
  deflateRawSync,
  unzip,
  unzipSync,
  inflate,
  inflateSync,
  gunzip,
  gunzipSync,
  inflateRaw,
  inflateRawSync,
  brotliCompress: unavailableFn("brotliCompress"),
  brotliCompressSync: unavailableFn("brotliCompressSync"),
  brotliDecompress: unavailableFn("brotliDecompress"),
  brotliDecompressSync: unavailableFn("brotliDecompressSync"),
  zstdCompress: unavailableFn("zstdCompress"),
  zstdCompressSync: unavailableFn("zstdCompressSync"),
  zstdDecompress: unavailableFn("zstdDecompress"),
  zstdDecompressSync: unavailableFn("zstdDecompressSync"),
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createGzip,
  createGunzip,
  createUnzip,
  createBrotliCompress: unavailableFn("createBrotliCompress"),
  createBrotliDecompress: unavailableFn("createBrotliDecompress"),
  createZstdCompress: unavailableFn("createZstdCompress"),
  createZstdDecompress: unavailableFn("createZstdDecompress"),
  constants,
  codes,
};

// Node still exposes the Z_* constants on the module, non-enumerable (deprecated).
for (const [key, value] of Object.entries(constants)) {
  if (!key.startsWith("BROTLI")) {
    Object.defineProperty(zlibModule, key, { enumerable: false, value, writable: false });
  }
}

export default zlibModule;
