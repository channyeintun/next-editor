// `fs.ReadStream` / `fs.WriteStream` (+ `createReadStream` / `createWriteStream`),
// ported from Node 22's lib/internal/fs/streams.js. They are function
// constructors over the `stream` builtin's Readable/Writable, so subclassing
// the old way (`ReadStream.apply(this, arguments)`, as graceful-fs does) works.
// All I/O goes through `stream[kFs]` — the `fs` module object, `options.fs`, or
// a FileHandle's methods — with callback-style `open`/`read`/`write`/`close`.
import type { Readable as ReadableType, Writable as WritableType } from "node:stream";
import { Buffer } from "../buffer";
import { nextTick } from "../eventLoop";
import {
  invalidArgType,
  makeNodeError,
  outOfRange,
  validateBoolean,
  validateFunction,
  validateInteger,
} from "../internalErrors";
import { Readable, Writable, finished } from "../stream";
import { deprecate } from "../util";
import { getOptions, getValidatedFd, getValidatedPath, toPathIfFileURL } from "./args";
import { close, fsync, open, read, write, writev } from "./callback";
import { notImplemented } from "./errors";

type Callback = (...args: never[]) => unknown;

/** The callback-style functions a file stream performs its I/O with. */
export interface StreamFs {
  open: (
    path: unknown,
    flags: unknown,
    mode: unknown,
    callback: (error: Error | null, fd?: number) => void,
  ) => void;
  read?: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: unknown,
    callback: (error: Error | null, bytesRead: number, buffer: Buffer) => void,
  ) => void;
  write?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: unknown,
    callback: (error: Error | null, written: number, buffer: Uint8Array) => void,
  ) => void;
  writev?: (
    fd: number,
    buffers: Uint8Array[],
    position: unknown,
    callback: (error: Error | null, written: number, buffers: Uint8Array[]) => void,
  ) => void;
  close: (fd: number, callback: (error?: Error | null) => void) => void;
  fsync?: (fd: number, callback: (error?: Error | null) => void) => void;
}

/** What a stream needs of a `FileHandle` passed as `fd`. */
export interface StreamFileHandle {
  readonly fd: number;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: unknown,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: unknown,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  writev(
    buffers: Uint8Array[],
    position: unknown,
  ): Promise<{ bytesWritten: number; buffers: Uint8Array[] }>;
  close(): Promise<void>;
  on(event: string, listener: () => void): unknown;
}

/** Marks a `FileHandle`, so a stream given one as `fd` uses its methods. */
export const kFileHandle = Symbol("kFileHandle");

const kFs = Symbol("kFs");
const kHandle = Symbol("kHandle");
const kIsPerformingIO = Symbol("kIsPerformingIO");
const kIoDone = Symbol("kIoDone");

interface FileStream {
  fd: number | null;
  path: unknown;
  flags: unknown;
  mode: unknown;
  start: number | undefined;
  pos: number | undefined;
  flush: boolean;
  destroyed: boolean;
  [kFs]: StreamFs;
  [kHandle]?: StreamFileHandle;
  [kIsPerformingIO]: boolean;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  once(event: string | symbol, listener: Callback): unknown;
  on(event: string | symbol, listener: Callback): unknown;
  destroy(error?: Error): unknown;
  open: unknown;
  _readableState?: StreamState;
  _writableState?: StreamState;
}

/** What a stream's state says about its end, as Node's streams keep it. */
interface StreamState {
  autoDestroy: boolean;
  destroyed: boolean;
  errored: Error | null;
  errorEmitted: boolean;
}

interface ReadStreamSelf extends FileStream {
  end: number;
  bytesRead: number;
  push(chunk: unknown): boolean;
}

interface WriteStreamSelf extends FileStream {
  bytesWritten: number;
  closed: boolean;
  autoClose: boolean;
  end(): unknown;
  setDefaultEncoding(encoding: string): unknown;
  _write: unknown;
  _writev: unknown;
}

/** `fs.ReadStream` instances. */
export type FsReadStream = ReadableType & {
  fd: number | null;
  path: string | Buffer | undefined;
  bytesRead: number;
  pending: boolean;
  close(callback?: (error?: Error | null) => void): void;
};

/** `fs.WriteStream` instances. */
export type FsWriteStream = WritableType & {
  fd: number | null;
  path: string | Buffer | undefined;
  bytesWritten: number;
  pending: boolean;
  close(callback?: (error?: Error | null) => void): void;
};

let moduleFs: StreamFs | null = null;

/** Makes the `fs` module object the default `kFs`, so monkey-patches of `fs.read` etc. reach streams, as in Node. */
export function setStreamFs(fs: StreamFs): void {
  moduleFs = fs;
}

function defaultFs(): StreamFs {
  return moduleFs ?? ({ open, read, write, writev, close, fsync } as unknown as StreamFs);
}

function streamDestroyed(name: string): Error {
  return makeNodeError("ERR_STREAM_DESTROYED", `Cannot call ${name} after a stream was destroyed`);
}

function systemFailure(message: string): Error {
  return makeNodeError("ERR_SYSTEM_ERROR", `A system error occurred: ${message}`);
}

/** The I/O functions of a FileHandle, shaped like `fs`'s callback API. */
function fileHandleOperations(handle: StreamFileHandle): StreamFs {
  return {
    open: () => {
      throw notImplemented("open()");
    },
    close: (_fd, callback) => {
      handle.close().then(() => callback(), callback);
    },
    read: (_fd, buffer, offset, length, position, callback) => {
      handle.read(buffer, offset, length, position).then(
        (result) => callback(null, result.bytesRead, result.buffer as Buffer),
        (error: Error) => callback(error, 0, buffer),
      );
    },
    write: (_fd, buffer, offset, length, position, callback) => {
      handle.write(buffer, offset, length, position).then(
        (result) => callback(null, result.bytesWritten, result.buffer),
        (error: Error) => callback(error, 0, buffer),
      );
    },
    writev: (_fd, buffers, position, callback) => {
      handle.writev(buffers, position).then(
        (result) => callback(null, result.bytesWritten, result.buffers),
        (error: Error) => callback(error, 0, buffers),
      );
    },
  };
}

/** `importFd`: a numeric fd, or a FileHandle whose methods the stream then uses. */
function importFd(stream: FileStream, options: Record<string, unknown>): number {
  const fd = options.fd;
  if (typeof fd === "number") {
    return getValidatedFd(fd);
  }
  if (typeof fd === "object" && fd !== null && kFileHandle in fd) {
    if (options.fs) {
      throw notImplemented("FileHandle with fs");
    }
    const handle = fd as unknown as StreamFileHandle;
    stream[kHandle] = handle;
    stream[kFs] = fileHandleOperations(handle);
    handle.on("close", () => (stream as unknown as { close(): void }).close());
    return handle.fd;
  }
  throw invalidArgType("options.fd", ["number", "FileHandle"], fd);
}

/**
 * Node's `errorOrDestroy` for a failure that arrived from the event loop:
 * destroys an auto-destroying stream; any other is marked errored and emits
 * 'error' now, once.
 */
function errorOrDestroy(stream: FileStream, error: Error): void {
  const states = [stream._readableState, stream._writableState].filter(
    (state) => state !== undefined,
  );
  if (states.some((state) => state.destroyed)) {
    return;
  }
  if (states.some((state) => state.autoDestroy)) {
    stream.destroy(error);
    return;
  }
  const emitted = states.some((state) => state.errorEmitted);
  for (const state of states) {
    state.errored ??= error;
    state.errorEmitted = true;
  }
  if (!emitted) {
    stream.emit("error", error);
  }
}

function closeAfterSync(
  stream: FileStream,
  error: Error | null | undefined,
  callback: (error?: Error | null) => void,
): void {
  stream[kFs].close(stream.fd as number, (closeError) => callback(closeError || error));
  stream.fd = null;
}

// Node checks `!stream.fd`, so fd 0 is treated as "nothing to close".
function closeStream(
  stream: FileStream,
  error: Error | null | undefined,
  callback: (error?: Error | null) => void,
): void {
  if (!stream.fd) {
    callback(error);
  } else if (stream.flush && stream[kFs].fsync) {
    stream[kFs].fsync(stream.fd, (flushError) =>
      closeAfterSync(stream, error || flushError, callback),
    );
  } else {
    closeAfterSync(stream, error, callback);
  }
}

function destroyStream(
  this: FileStream,
  error: Error | null,
  callback: (error?: Error | null) => void,
): void {
  if (this[kIsPerformingIO]) {
    this.once(kIoDone, (ioError: Error | null) => closeStream(this, error || ioError, callback));
  } else {
    closeStream(this, error, callback);
  }
}

const openReadFs = deprecate(
  function open() {
    // Noop: the stream opens itself in _construct.
  },
  "ReadStream.prototype.open() is deprecated",
  "DEP0135",
);

const openWriteFs = deprecate(
  function open() {
    // Noop: the stream opens itself in _construct.
  },
  "WriteStream.prototype.open() is deprecated",
  "DEP0135",
);

/** `_construct`: opens the file unless an fd was given, honouring a monkey-patched `open()`. */
function construct(this: FileStream, callback: (error?: Error | null) => void): void {
  if (typeof this.fd === "number") {
    callback();
    return;
  }
  if (this.open !== openWriteFs && this.open !== openReadFs) {
    // Backwards compatibility for code that replaces open().
    const originalEmit = this.emit;
    this.emit = function emit(this: FileStream, ...args: [string | symbol, ...unknown[]]) {
      if (args[0] === "open") {
        this.emit = originalEmit;
        callback();
        return Reflect.apply(originalEmit, this, args) as boolean;
      }
      if (args[0] === "error") {
        this.emit = originalEmit;
        callback(args[1] as Error);
        return true;
      }
      return Reflect.apply(originalEmit, this, args) as boolean;
    };
    (this.open as () => void).call(this);
    return;
  }
  this[kFs].open(this.path, this.flags, this.mode, (error, fd) => {
    if (error) {
      callback(error);
      return;
    }
    this.fd = fd as number;
    callback();
    this.emit("open", this.fd);
    this.emit("ready");
  });
}

function setupPath(
  stream: FileStream,
  path: unknown,
  options: Record<string, unknown>,
  defaultFlags: string,
): void {
  stream.fd = null;
  stream.path = toPathIfFileURL(path);
  stream.flags = options.flags === undefined ? defaultFlags : options.flags;
  stream.mode = options.mode === undefined ? 0o666 : options.mode;
  getValidatedPath(stream.path);
}

/** `fs.ReadStream(path, options)`. */
function ReadStreamImpl(this: ReadStreamSelf, path: unknown, options?: unknown): unknown {
  if (!(this instanceof ReadStreamImpl)) {
    return new (ReadStreamImpl as unknown as new (p: unknown, o: unknown) => unknown)(
      path,
      options,
    );
  }
  const opts: Record<string, unknown> = { ...getOptions(options) };
  if (opts.highWaterMark === undefined) {
    opts.highWaterMark = 64 * 1024;
  }
  if (opts.autoDestroy === undefined) {
    opts.autoDestroy = false;
  }
  this[kFs] = (opts.fs as StreamFs | undefined) || defaultFs();
  validateFunction(this[kFs].open, "options.fs.open");
  validateFunction(this[kFs].read, "options.fs.read");
  validateFunction(this[kFs].close, "options.fs.close");
  if (opts.fd == null) {
    setupPath(this, path, opts, "r");
  } else {
    this.fd = importFd(this, opts);
  }
  opts.autoDestroy = opts.autoClose === undefined ? true : opts.autoClose;
  if (opts.start !== undefined) {
    validateInteger(opts.start, "start", 0);
  }
  this.start = opts.start as number | undefined;
  if (opts.end === undefined) {
    this.end = Infinity;
  } else {
    if (opts.end !== Infinity) {
      validateInteger(opts.end, "end", 0);
    }
    this.end = opts.end as number;
  }
  if (this.start !== undefined && this.start > this.end) {
    throw outOfRange("start", `<= "end" (here: ${this.end})`, this.start);
  }
  this.pos = this.start;
  this.bytesRead = 0;
  this[kIsPerformingIO] = false;
  this.flush = false;
  (Readable as unknown as (this: unknown, options: unknown) => void).call(this, opts);
  return undefined;
}

Object.setPrototypeOf(ReadStreamImpl.prototype, Readable.prototype);
Object.setPrototypeOf(ReadStreamImpl, Readable);

Object.defineProperty(ReadStreamImpl.prototype, "autoClose", {
  get(this: FileStream) {
    return this._readableState?.autoDestroy;
  },
  set(this: FileStream, value: boolean) {
    if (this._readableState) {
      this._readableState.autoDestroy = value;
    }
  },
  configurable: true,
});

Object.defineProperty(ReadStreamImpl.prototype, "pending", {
  get(this: FileStream) {
    return this.fd === null;
  },
  configurable: true,
});

Object.assign(ReadStreamImpl.prototype, {
  open: openReadFs,
  _construct: construct,
  _read(this: ReadStreamSelf, size: number) {
    const n =
      this.pos !== undefined
        ? Math.min(this.end - this.pos + 1, size)
        : Math.min(this.end - this.bytesRead + 1, size);
    if (n <= 0) {
      this.push(null);
      return;
    }
    const buffer = Buffer.allocUnsafeSlow(n);
    this[kIsPerformingIO] = true;
    (this[kFs].read as NonNullable<StreamFs["read"]>)(
      this.fd as number,
      buffer,
      0,
      n,
      this.pos,
      (error, bytesRead, filled) => {
        this[kIsPerformingIO] = false;
        // Tell ._destroy() that it's safe to close the fd now.
        if (this.destroyed) {
          this.emit(kIoDone, error);
          return;
        }
        if (error) {
          errorOrDestroy(this, error);
        } else if (bytesRead > 0) {
          if (this.pos !== undefined) {
            this.pos += bytesRead;
          }
          this.bytesRead += bytesRead;
          let chunk = filled;
          if (bytesRead !== filled.length) {
            // Copy so the rest of the allocation is not kept alive.
            chunk = Buffer.allocUnsafeSlow(bytesRead);
            filled.copy(chunk, 0, 0, bytesRead);
          }
          this.push(chunk);
        } else {
          this.push(null);
        }
      },
    );
  },
  _destroy: destroyStream,
  close(this: ReadStreamSelf, callback?: (error?: Error | null) => void) {
    if (typeof callback === "function") {
      finished(this as unknown as ReadableType, callback);
    }
    this.destroy();
  },
});

function writeAll(
  this: WriteStreamSelf,
  data: Uint8Array,
  size: number,
  pos: number | undefined,
  callback: (error?: Error | null) => void,
  retries = 0,
): void {
  (this[kFs].write as NonNullable<StreamFs["write"]>)(
    this.fd as number,
    data,
    0,
    size,
    pos,
    (error, bytesWritten, buffer) => {
      let failure = error;
      let written = bytesWritten;
      if ((failure as { code?: string } | null)?.code === "EAGAIN") {
        failure = null;
        written = 0;
      }
      if (this.destroyed || failure) {
        callback(failure || streamDestroyed("write"));
        return;
      }
      this.bytesWritten += written;
      const nextRetries = written ? 0 : retries + 1;
      const rest = size - written;
      const nextPos = pos === undefined ? undefined : pos + written;
      if (nextRetries > 5) {
        callback(systemFailure("write failed"));
      } else if (rest) {
        writeAll.call(this, buffer.subarray(written), rest, nextPos, callback, nextRetries);
      } else {
        callback();
      }
    },
  );
}

function writevAll(
  this: WriteStreamSelf,
  chunks: Uint8Array[],
  size: number,
  pos: number | undefined,
  callback: (error?: Error | null) => void,
  retries = 0,
): void {
  (this[kFs].writev as NonNullable<StreamFs["writev"]>)(
    this.fd as number,
    chunks,
    pos,
    (error, bytesWritten, buffers) => {
      let failure = error;
      let written = bytesWritten;
      if ((failure as { code?: string } | null)?.code === "EAGAIN") {
        failure = null;
        written = 0;
      }
      if (this.destroyed || failure) {
        callback(failure || streamDestroyed("writev"));
        return;
      }
      this.bytesWritten += written;
      const nextRetries = written ? 0 : retries + 1;
      const rest = size - written;
      const nextPos = pos === undefined ? undefined : pos + written;
      if (nextRetries > 5) {
        callback(systemFailure("writev failed"));
      } else if (rest) {
        writevAll.call(
          this,
          [Buffer.concat(buffers).subarray(written)],
          rest,
          nextPos,
          callback,
          nextRetries,
        );
      } else {
        callback();
      }
    },
  );
}

/** `fs.WriteStream(path, options)`. */
function WriteStreamImpl(this: WriteStreamSelf, path: unknown, options?: unknown): unknown {
  if (!(this instanceof WriteStreamImpl)) {
    return new (WriteStreamImpl as unknown as new (p: unknown, o: unknown) => unknown)(
      path,
      options,
    );
  }
  const opts: Record<string, unknown> = { ...getOptions(options) };
  // Only buffers are supported.
  opts.decodeStrings = true;
  this[kFs] = (opts.fs as StreamFs | undefined) || defaultFs();
  validateFunction(this[kFs].open, "options.fs.open");
  if (!this[kFs].write && !this[kFs].writev) {
    throw invalidArgType("options.fs.write", "function", this[kFs].write);
  }
  if (this[kFs].write) {
    validateFunction(this[kFs].write, "options.fs.write");
  }
  if (this[kFs].writev) {
    validateFunction(this[kFs].writev, "options.fs.writev");
  }
  validateFunction(this[kFs].close, "options.fs.close");
  // It's enough to override either, in which case only one will be used.
  if (!this[kFs].write) {
    this._write = null;
  }
  if (!this[kFs].writev) {
    this._writev = null;
  }
  if (opts.fd == null) {
    setupPath(this, path, opts, "w");
  } else {
    this.fd = importFd(this, opts);
  }
  opts.autoDestroy = opts.autoClose === undefined ? true : opts.autoClose;
  if (opts.flush == null) {
    this.flush = false;
  } else {
    validateBoolean(opts.flush, "options.flush");
    this.flush = opts.flush;
  }
  this.start = opts.start as number | undefined;
  this.pos = undefined;
  this.bytesWritten = 0;
  this[kIsPerformingIO] = false;
  if (this.start !== undefined) {
    validateInteger(this.start, "start", 0);
    this.pos = this.start;
  }
  (Writable as unknown as (this: unknown, options: unknown) => void).call(this, opts);
  if (opts.encoding) {
    this.setDefaultEncoding(opts.encoding as string);
  }
  return undefined;
}

Object.setPrototypeOf(WriteStreamImpl.prototype, Writable.prototype);
Object.setPrototypeOf(WriteStreamImpl, Writable);

Object.defineProperty(WriteStreamImpl.prototype, "autoClose", {
  get(this: FileStream) {
    return this._writableState?.autoDestroy;
  },
  set(this: FileStream, value: boolean) {
    if (this._writableState) {
      this._writableState.autoDestroy = value;
    }
  },
  configurable: true,
});

Object.defineProperty(WriteStreamImpl.prototype, "pending", {
  get(this: FileStream) {
    return this.fd === null;
  },
  configurable: true,
});

function finishIo(
  stream: WriteStreamSelf,
  callback: (error?: Error | null) => void,
): (error?: Error | null) => void {
  return (error) => {
    stream[kIsPerformingIO] = false;
    if (stream.destroyed) {
      // Tell ._destroy() that it's safe to close the fd now.
      callback(error);
      stream.emit(kIoDone, error);
      return;
    }
    callback(error);
  };
}

Object.assign(WriteStreamImpl.prototype, {
  open: openWriteFs,
  _construct: construct,
  _write(
    this: WriteStreamSelf,
    data: Uint8Array,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ) {
    this[kIsPerformingIO] = true;
    writeAll.call(this, data, data.length, this.pos, finishIo(this, callback));
    if (this.pos !== undefined) {
      this.pos += data.length;
    }
  },
  _writev(
    this: WriteStreamSelf,
    data: { chunk: Uint8Array }[],
    callback: (error?: Error | null) => void,
  ) {
    const chunks = data.map((entry) => entry.chunk);
    let size = 0;
    for (const chunk of chunks) {
      size += chunk.length;
    }
    this[kIsPerformingIO] = true;
    writevAll.call(this, chunks, size, this.pos, finishIo(this, callback));
    if (this.pos !== undefined) {
      this.pos += size;
    }
  },
  _destroy: destroyStream,
  close(this: WriteStreamSelf, callback?: (error?: Error | null) => void) {
    if (callback) {
      if (this.closed) {
        nextTick(callback);
        return;
      }
      this.on("close", callback);
    }
    // If we are not autoClosing, we should call destroy on 'finish'.
    if (!this.autoClose) {
      this.on("finish", this.destroy as Callback);
    }
    // Node uses end() rather than destroy() here (nodejs/node#2006).
    this.end();
  },
});

(WriteStreamImpl.prototype as { destroySoon?: unknown }).destroySoon = (
  Writable.prototype as unknown as { end: unknown }
).end;

/** The `fs.ReadStream` constructor. */
export const ReadStream = ReadStreamImpl as unknown as {
  new (path: unknown, options?: unknown): FsReadStream;
  (path: unknown, options?: unknown): FsReadStream;
  prototype: FsReadStream;
};

/** The `fs.WriteStream` constructor. */
export const WriteStream = WriteStreamImpl as unknown as {
  new (path: unknown, options?: unknown): FsWriteStream;
  (path: unknown, options?: unknown): FsWriteStream;
  prototype: FsWriteStream;
};

/** `fs.createReadStream(path, options)`. */
export function createReadStream(path: unknown, options?: unknown): FsReadStream {
  return new ReadStream(path, options);
}

/** `fs.createWriteStream(path, options)`. */
export function createWriteStream(path: unknown, options?: unknown): FsWriteStream {
  return new WriteStream(path, options);
}
