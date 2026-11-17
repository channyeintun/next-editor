// The promise `fs` API (`fs.promises`, `require("fs/promises")`) and its
// `FileHandle`. Each function returns a promise, so argument errors reject
// like any other failure, as in Node. The work is the sync operation, and the
// promise settles from the event loop (completion.ts); `rm` waits
// `retryDelay` between retries and `cp` awaits an async `filter`.
import EventEmitter from "../events";
import type { EventEmitter as EventEmitterType } from "../events";
import { Buffer } from "../buffer";
import {
  AbortError,
  kValidateObjectAllowNullable,
  validateBoolean,
  validateInteger,
  validateObject,
} from "../internalErrors";
import { runtime } from "../../runtime";
import {
  backendPosition,
  bytesOf,
  decodeContents,
  encodeData,
  getOptions,
  getValidatedPath,
  kIoMaxLength,
  parseFileMode,
  stringToFlags,
  toAbsolute,
  validateBuffer,
  validateBufferArray,
  validateEncoding,
  validateOffsetLengthWrite,
  validateStringAfterArrayBufferView,
} from "./args";
import { removeWithRetries } from "./callback";
import { settledLater, settleLater } from "./completion";
import { constants } from "./constants";
import { cpAsync } from "./cp";
import { fileClosed, fileTooLarge, invalidState, notImplemented, restate } from "./errors";
import {
  createReadStream,
  createWriteStream,
  kFileHandle,
  type FsReadStream,
  type FsWriteStream,
} from "./streams";
import * as sync from "./sync";
import type { RmOptions } from "./sync";
import type { BigIntStats, Stats } from "./stats";
import { watchAsync } from "./watch";

const EmitterBase = EventEmitter as unknown as new () => EventEmitterType;
const kReadFileChunk = 512 * 1024;

function checkAborted(signal: unknown): void {
  const s = signal as AbortSignal | undefined;
  if (s?.aborted) {
    throw new AbortError(undefined, { cause: s.reason });
  }
}

/** A string, ArrayBufferView, or (async) iterable of them, as `writeFile` takes. */
function isCustomIterable(value: unknown): boolean {
  return (
    value != null &&
    typeof value !== "string" &&
    !ArrayBuffer.isView(value) &&
    (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function" ||
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function")
  );
}

/** Writes each chunk of an iterable (strings encoded with `encoding`) to `fd` at its offset. */
async function writeIterable(
  fd: number,
  data: unknown,
  encoding: unknown,
  signal: unknown,
): Promise<void> {
  for await (const chunk of data as AsyncIterable<unknown>) {
    checkAborted(signal);
    const bytes =
      typeof chunk === "string"
        ? encodeData(chunk, encoding)
        : ArrayBuffer.isView(chunk)
          ? bytesOf(chunk)
          : null;
    if (bytes === null) {
      validateStringAfterArrayBufferView(chunk, "data");
      continue;
    }
    sync.writeAllToFd(fd, bytes);
  }
}

/** One line reader over a FileHandle's read stream: what `filehandle.readLines()` returns. */
export class LineReader extends EmitterBase {
  #input: FsReadStream;
  #closed = false;

  constructor(input: FsReadStream) {
    super();
    this.#input = input;
    let pending = "";
    let lastWasCR = false;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      let text = chunk;
      // A "\r\n" split across chunks is one line break (readline's crlfDelay: Infinity).
      if (lastWasCR && text.startsWith("\n")) {
        text = text.slice(1);
      }
      lastWasCR = text.endsWith("\r");
      const parts = (pending + text).split(/\r\n|\n|\r/);
      pending = parts.pop() as string;
      for (const line of parts) {
        if (this.#closed) {
          return;
        }
        this.emit("line", line);
      }
    });
    input.on("end", () => {
      if (pending.length > 0 && !this.#closed) {
        this.emit("line", pending);
      }
      this.close();
    });
    input.on("error", (error: Error) => this.emit("error", error));
  }

  /** Stops reading and emits `close`. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#input.destroy();
    this.emit("close");
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, undefined> {
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let failure: unknown = null;
    const notify = () => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    this.on("line", (line: string) => {
      lines.push(line);
      notify();
    });
    this.on("close", () => {
      done = true;
      notify();
    });
    this.on("error", (error: unknown) => {
      failure = error;
      notify();
    });
    try {
      for (;;) {
        if (failure !== null) {
          throw failure;
        }
        const line = lines.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      this.close();
    }
  }
}

/** `FileHandle`: an open file, as `fs.promises.open` returns it. */
export class FileHandle extends EmitterBase {
  #fd: number;
  #closing: Promise<void> | null = null;
  #locked = false;
  readonly [kFileHandle] = true;

  constructor(fd: number) {
    super();
    this.#fd = fd;
  }

  get fd(): number {
    return this.#fd;
  }

  #check(syscall: string): number {
    if (this.#fd === -1) {
      throw fileClosed(syscall);
    }
    return this.#fd;
  }

  getAsyncId(): never {
    throw notImplemented("FileHandle.getAsyncId()");
  }

  async appendFile(data: unknown, options?: unknown): Promise<void> {
    return this.writeFile(data, options);
  }

  async chmod(mode: unknown): Promise<void> {
    sync.fchmodSync(this.#check("fchmod"), mode);
  }

  async chown(uid: unknown, gid: unknown): Promise<void> {
    sync.fchownSync(this.#check("fchown"), uid, gid);
  }

  async datasync(): Promise<void> {
    sync.fdatasyncSync(this.#check("fdatasync"));
  }

  async sync(): Promise<void> {
    sync.fsyncSync(this.#check("fsync"));
  }

  /** `read(buffer, offset, length, position)`, `read(buffer, options)` and `read(options)`. */
  async read(
    bufferOrOptions?: unknown,
    offset?: unknown,
    length?: unknown,
    position?: unknown,
  ): Promise<{ bytesRead: number; buffer: ArrayBufferView }> {
    const fd = this.#check("read");
    let buffer = bufferOrOptions;
    let start = offset;
    let count = length;
    let at = position;
    if (!ArrayBuffer.isView(buffer)) {
      if (bufferOrOptions !== undefined) {
        validateObject(bufferOrOptions, "options", kValidateObjectAllowNullable);
      }
      const opts = (bufferOrOptions ?? {}) as {
        buffer?: unknown;
        offset?: unknown;
        length?: unknown;
        position?: unknown;
      };
      buffer = opts.buffer ?? Buffer.alloc(16384);
      start = opts.offset ?? 0;
      count = opts.length ?? (buffer as ArrayBufferView).byteLength - (start as number);
      at = opts.position ?? null;
      validateBuffer(buffer);
    }
    const view = buffer as ArrayBufferView;
    if (start !== null && typeof start === "object") {
      const opts = start as { offset?: unknown; length?: unknown; position?: unknown };
      start = opts.offset ?? 0;
      count = opts.length ?? view.byteLength - (start as number);
      at = opts.position ?? null;
    }
    if (start == null) {
      start = 0;
    } else {
      validateInteger(start, "offset", 0);
    }
    count ??= view.byteLength - (start as number);
    if (count === 0) {
      return { bytesRead: 0, buffer: view };
    }
    const args = sync.checkReadArgs(view, start, count, at);
    if (args === null) {
      return { bytesRead: 0, buffer: view };
    }
    const bytesRead = await sync.readIntoAsync(fd, view, args.offset, args.length, args.position);
    return { bytesRead, buffer: view };
  }

  async readv(
    buffers: unknown,
    position?: unknown,
  ): Promise<{ bytesRead: number; buffers: unknown }> {
    const fd = this.#check("readv");
    validateBufferArray(buffers);
    if (position == null && sync.isStreamFd(fd)) {
      // A pipe or terminal: wait for bytes without blocking the process.
      return { bytesRead: await sync.readvAsync(fd, buffers as ArrayBufferView[]), buffers };
    }
    return { bytesRead: sync.readvSync(fd, buffers, position), buffers };
  }

  /** Reads from the current position to the end. */
  async readFile(options?: unknown): Promise<string | Buffer> {
    const fd = this.#check("read");
    const opts = getOptions(options, { flag: "r" });
    checkAborted(opts.signal);
    if (sync.isStreamFd(fd)) {
      // A pipe or terminal: wait for bytes without blocking the process.
      return decodeContents(await sync.readAllFromFdAsync(fd), opts.encoding);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      checkAborted(opts.signal);
      const chunk = runtime().fs.read(fd, kReadFileChunk, null);
      if (chunk.length === 0) {
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
      if (total > kIoMaxLength) {
        throw fileTooLarge(total);
      }
    }
    const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    return decodeContents(bytes, opts.encoding);
  }

  /** A line reader over `createReadStream(options)`; it emits `line` and is async iterable. */
  readLines(options?: unknown): LineReader {
    return new LineReader(this.createReadStream(options));
  }

  async stat(options?: unknown): Promise<Stats | BigIntStats> {
    return sync.fstatSync(this.#check("fstat"), options);
  }

  async truncate(len: unknown = 0): Promise<void> {
    sync.ftruncateSync(this.#check("ftruncate"), len);
  }

  async utimes(atime: unknown, mtime: unknown): Promise<void> {
    sync.futimesSync(this.#check("futime"), atime, mtime);
  }

  /** `write(buffer, offset, length, position)`, `write(buffer, options)` and `write(string, position, encoding)`. */
  async write(
    buffer: unknown,
    offsetOrOptions?: unknown,
    length?: unknown,
    position?: unknown,
  ): Promise<{ bytesWritten: number; buffer: unknown }> {
    const fd = this.#check("write");
    if (ArrayBuffer.isView(buffer)) {
      if (buffer.byteLength === 0) {
        return { bytesWritten: 0, buffer };
      }
      let offset = offsetOrOptions;
      let count = length;
      let at = position;
      if (offset !== null && typeof offset === "object") {
        const opts = offset as { offset?: unknown; length?: unknown; position?: unknown };
        offset = opts.offset ?? 0;
        count = opts.length ?? buffer.byteLength - (offset as number);
        at = opts.position ?? null;
      }
      if (offset == null) {
        offset = 0;
      } else {
        validateInteger(offset, "offset", 0);
      }
      if (typeof count !== "number") {
        count = buffer.byteLength - (offset as number);
      }
      if (typeof at !== "number") {
        at = null;
      }
      validateOffsetLengthWrite(offset as number, count as number, buffer.byteLength);
      const bytes = bytesOf(buffer).subarray(
        offset as number,
        (offset as number) + (count as number),
      );
      return { bytesWritten: runtime().fs.write(fd, bytes, backendPosition(at)), buffer };
    }
    validateStringAfterArrayBufferView(buffer, "buffer");
    validateEncoding(buffer, length);
    const encoding = typeof length === "string" ? length : "utf8";
    const bytesWritten = runtime().fs.write(
      fd,
      encodeData(buffer, encoding),
      backendPosition(offsetOrOptions),
    );
    return { bytesWritten, buffer };
  }

  async writev(
    buffers: unknown,
    position?: unknown,
  ): Promise<{ bytesWritten: number; buffers: unknown }> {
    const fd = this.#check("writev");
    validateBufferArray(buffers);
    return { bytesWritten: sync.writevSync(fd, buffers, position), buffers };
  }

  /** Writes at the current position (truncating nothing). */
  async writeFile(data: unknown, options?: unknown): Promise<void> {
    const fd = this.#check("write");
    const opts = getOptions(options, { encoding: "utf8" as unknown });
    checkAborted(opts.signal);
    if (isCustomIterable(data)) {
      await writeIterable(fd, data, opts.encoding, opts.signal);
      return;
    }
    sync.writeAllToFd(fd, sync.writeFileBytes(data, opts.encoding));
  }

  /** Closes the file; closing again resolves at once. */
  close(): Promise<void> {
    if (this.#fd === -1) {
      return this.#closing ?? Promise.resolve();
    }
    const fd = this.#fd;
    this.#fd = -1;
    try {
      runtime().fs.close(fd);
      this.#closing = Promise.resolve();
    } catch (error) {
      this.#closing = Promise.reject(error);
    }
    this.emit("close");
    return this.#closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  createReadStream(options?: unknown): FsReadStream {
    return createReadStream(undefined, { ...(options as object | undefined), fd: this });
  }

  createWriteStream(options?: unknown): FsWriteStream {
    return createWriteStream(undefined, { ...(options as object | undefined), fd: this });
  }

  /** The file from the current position as a web `ReadableStream`; cancelling it closes the handle. */
  readableWebStream(options: { type?: string } = {}): ReadableStream<Uint8Array> {
    if (this.#fd === -1) {
      throw invalidState("The FileHandle is closed");
    }
    if (this.#closing !== null) {
      throw invalidState("The FileHandle is closing");
    }
    if (this.#locked) {
      throw invalidState("The FileHandle is locked");
    }
    this.#locked = true;
    const bytes = options.type === "bytes";
    const source = {
      pull: async (controller: ReadableStreamDefaultController<Uint8Array>) => {
        const { bytesRead, buffer } = await this.read(Buffer.alloc(65536), 0, 65536, null);
        if (bytesRead === 0) {
          controller.close();
          this.#locked = false;
          return;
        }
        controller.enqueue(bytesOf(buffer).subarray(0, bytesRead));
      },
      cancel: async () => {
        this.#locked = false;
        await this.close();
      },
    };
    return bytes
      ? new ReadableStream({
          ...source,
          type: "bytes",
        } as unknown as UnderlyingDefaultSource<Uint8Array>)
      : new ReadableStream(source);
  }
}

/** `fsPromises.open(path, flags, mode)`. */
export async function open(path: unknown, flags?: unknown, mode?: unknown): Promise<FileHandle> {
  const shown = getValidatedPath(path);
  const flagBits = stringToFlags(flags);
  const checked = parseFileMode(mode, "mode", 0o666);
  const absolute = toAbsolute(shown);
  try {
    return new FileHandle(runtime().fs.open(absolute, flagBits, checked));
  } catch (error) {
    throw restate(error, { absolute, shown });
  }
}

/** `fsPromises.readFile(path | FileHandle, options)`. */
export async function readFile(path: unknown, options?: unknown): Promise<string | Buffer> {
  const opts = getOptions(options, { flag: "r" });
  if (path instanceof FileHandle) {
    return path.readFile(opts);
  }
  checkAborted(opts.signal);
  return sync.readFileSync(path, opts);
}

/** `fsPromises.writeFile(path | FileHandle, data, options)`; `data` may be an (async) iterable. */
export async function writeFile(path: unknown, data: unknown, options?: unknown): Promise<void> {
  const opts = getOptions(options, { encoding: "utf8", mode: 0o666, flag: "w", flush: false });
  const flag = opts.flag || "w";
  const flush = opts.flush ?? false;
  validateBoolean(flush, "options.flush");
  let payload = data;
  if (!ArrayBuffer.isView(payload) && !isCustomIterable(payload)) {
    validateStringAfterArrayBufferView(payload, "data");
    payload = encodeData(payload, opts.encoding || "utf8");
  }
  if (path instanceof FileHandle) {
    return path.writeFile(payload, opts);
  }
  checkAborted(opts.signal);
  if (!isCustomIterable(payload)) {
    sync.writeFileSync(path, payload, { ...opts, flag });
    return;
  }
  const handle = await open(path, flag, opts.mode);
  try {
    await writeIterable(handle.fd, payload, opts.encoding, opts.signal);
    if (flush) {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

/** `fsPromises.appendFile(path | FileHandle, data, options)`. */
export async function appendFile(path: unknown, data: unknown, options?: unknown): Promise<void> {
  const opts = { ...getOptions(options, { encoding: "utf8", mode: 0o666, flag: "a" }) };
  opts.flag ||= "a";
  return writeFile(path, data, opts);
}

/** `fsPromises.rm(path, options)`, waiting `retryDelay` between retries. */
export async function rm(path: unknown, options?: unknown): Promise<void> {
  const shown = getValidatedPath(path);
  const opts = sync.validateRmOptions(shown, options, false) as RmOptions;
  await removeWithRetries(shown, opts);
}

/** `fsPromises.cp(src, dest, options)`; `filter` may return a promise. */
export async function cp(src: unknown, dest: unknown, options?: unknown): Promise<void> {
  await cpAsync(src, dest, options);
}

/** `fsPromises.lutimes(path, atime, mtime)`. */
export function lutimes(path: unknown, atime: unknown, mtime: unknown): Promise<void> {
  return settleLater(() => sync.lutimesSync(path, atime, mtime));
}

/** `fsPromises.realpath(path, options)`: the kernel's realpath(3), as Node's promise API uses. */
export function realpath(path: unknown, options?: unknown): Promise<string | Buffer> {
  return settleLater(() => sync.realpathSyncNative(path, options));
}

/** `fsPromises.stat(path, { bigint })`. */
export function stat(
  path: unknown,
  options: unknown = { bigint: false },
): Promise<Stats | BigIntStats> {
  return settleLater(
    () =>
      sync.statSync(path, { bigint: (options as { bigint?: unknown } | null)?.bigint }) as
        | Stats
        | BigIntStats,
  );
}

/** `fsPromises.lstat(path, { bigint })`. */
export function lstat(
  path: unknown,
  options: unknown = { bigint: false },
): Promise<Stats | BigIntStats> {
  return settleLater(
    () =>
      sync.lstatSync(path, { bigint: (options as { bigint?: unknown } | null)?.bigint }) as
        | Stats
        | BigIntStats,
  );
}

/** `fsPromises.glob`: not provided by webnode. */
export function glob(): never {
  throw notImplemented("fsPromises.glob()");
}

function promised<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => R,
): (...args: A) => Promise<R> {
  const wrapper = (...args: A): Promise<R> => settleLater(() => fn(...args));
  Object.defineProperty(wrapper, "name", { value: name, configurable: true });
  return wrapper;
}

/** An async function whose promise settles from the event loop, keeping its name. */
function looped<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const wrapper = settledLater(fn);
  Object.defineProperty(wrapper, "name", { value: fn.name, configurable: true });
  return wrapper;
}

// A FileHandle's operations settle from the event loop as well.
for (const name of [
  "appendFile",
  "chmod",
  "chown",
  "datasync",
  "sync",
  "read",
  "readv",
  "readFile",
  "stat",
  "truncate",
  "utimes",
  "write",
  "writev",
  "writeFile",
  "close",
] as const) {
  const method = FileHandle.prototype[name] as (...args: unknown[]) => Promise<unknown>;
  Object.defineProperty(FileHandle.prototype, name, {
    value: looped(method),
    writable: true,
    configurable: true,
  });
}

/** The `fs/promises` module object, in Node 22's key order. */
export const promises = {
  access: promised("access", sync.accessSync),
  copyFile: promised("copyFile", sync.copyFileSync),
  cp: looped(cp),
  glob,
  open: looped(open),
  opendir: promised("opendir", sync.opendirSync),
  rename: promised("rename", sync.renameSync),
  truncate: promised("truncate", (path: unknown, len?: unknown) => sync.truncateSync(path, len)),
  rm: looped(rm),
  rmdir: promised("rmdir", sync.rmdirSync),
  mkdir: promised("mkdir", sync.mkdirSync),
  readdir: promised("readdir", sync.readdirSync),
  readlink: promised("readlink", sync.readlinkSync),
  symlink: promised("symlink", sync.symlinkSync),
  lstat,
  stat,
  statfs: promised("statfs", sync.statfsSync),
  link: promised("link", sync.linkSync),
  unlink: promised("unlink", sync.unlinkSync),
  chmod: promised("chmod", sync.chmodSync),
  lchmod: promised("lchmod", sync.lchmodSync),
  lchown: promised("lchown", sync.lchownSync),
  chown: promised("chown", sync.chownSync),
  utimes: promised("utimes", sync.utimesSync),
  lutimes,
  realpath,
  mkdtemp: promised("mkdtemp", sync.mkdtempSync),
  writeFile: looped(writeFile),
  appendFile: looped(appendFile),
  readFile: looped(readFile),
  watch: watchAsync,
  constants,
};
