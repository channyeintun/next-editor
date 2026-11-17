// The callback `fs` API (`fs.stat(path, cb)` …). Each function runs the
// matching sync operation at once and hands the result to the callback from
// the event loop (completion.ts), never synchronously. Argument errors throw, as in Node; every
// other failure goes to the callback. `read`/`write` keep Node's overloads and
// their `util.promisify` shapes; `rm` waits `retryDelay` between retries.
import { Buffer } from "../buffer";
import {
  AbortError,
  kValidateObjectAllowNullable,
  validateFunction,
  validateInteger,
  validateObject,
  validateString,
} from "../internalErrors";
import { promisify } from "../util";
import {
  getValidatedFd,
  getValidatedPath,
  validateBuffer,
  validateEncoding,
  validateOffsetLengthWrite,
  validateStringAfterArrayBufferView,
  bytesOf,
  encodeData,
  backendPosition,
  decodeContents,
  getOptions,
  isFd,
  validateBufferArray,
} from "./args";
import { complete } from "./completion";
import { cpAsync } from "./cp";
import { isArgumentError, notImplemented } from "./errors";
import { runtime } from "../../runtime";
import * as sync from "./sync";
import type { RmOptions } from "./sync";

type AnyCallback = (...args: unknown[]) => unknown;

/** Calls `callback(error)` or `callback(null, ...results)` from the event loop. */
function settle(callback: AnyCallback, op: () => unknown[]): void {
  let results: unknown[];
  try {
    results = op();
  } catch (error) {
    if (isArgumentError(error)) {
      throw error;
    }
    complete(() => callback(error));
    return;
  }
  complete(() => callback(null, ...results));
}

/**
 * Removes and returns the trailing callback. When there is none, the error
 * names what sits where Node's signature puts the callback (`arity` is its
 * index), as Node reports it.
 */
function takeCallback(args: unknown[], arity: number): AnyCallback {
  const last = args[args.length - 1];
  if (typeof last !== "function") {
    validateFunction(args.length > arity ? args[arity] : undefined, "cb");
  }
  args.pop();
  return last as AnyCallback;
}

function named<T extends AnyCallback>(name: string, fn: T): T {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  return fn;
}

/** A callback function over `syncFn`: the callback is the last argument; the result is passed on unless `voidResult`. */
function callbackFrom(
  name: string,
  arity: number,
  syncFn: (...args: never[]) => unknown,
  voidResult: boolean,
): AnyCallback {
  return named(name, function (this: unknown, ...args: unknown[]) {
    const callback = takeCallback(args, arity);
    settle(callback, () => {
      const result = (syncFn as (...values: unknown[]) => unknown)(...args);
      // Node passes no result for void operations (and non-recursive mkdir).
      return voidResult || result === undefined ? [] : [result];
    });
  });
}

function abortedError(signal: unknown): Error | null {
  const s = signal as AbortSignal | undefined;
  return s?.aborted ? new AbortError(undefined, { cause: s.reason }) : null;
}

/** A callback function whose options may carry an already-aborted `signal`. */
function callbackWithSignal(
  name: string,
  syncFn: (...args: never[]) => unknown,
  optionsIndex: number,
  voidResult: boolean,
): AnyCallback {
  const inner = callbackFrom(name, optionsIndex + 1, syncFn, voidResult);
  return named(name, function (this: unknown, ...args: unknown[]) {
    const options = args.length - 1 > optionsIndex ? args[optionsIndex] : undefined;
    const aborted =
      typeof options === "object" && options !== null
        ? abortedError((options as { signal?: unknown }).signal)
        : null;
    if (aborted !== null) {
      const callback = takeCallback(args, optionsIndex + 1);
      complete(() => callback(aborted));
      return;
    }
    inner(...args);
  });
}

export const access = callbackFrom("access", 2, sync.accessSync, true);
export const appendFile = callbackWithSignal("appendFile", sync.appendFileSync, 2, true);
export const chmod = callbackFrom("chmod", 2, sync.chmodSync, true);
export const chown = callbackFrom("chown", 3, sync.chownSync, true);
export const copyFile = callbackFrom("copyFile", 3, sync.copyFileSync, true);
export const fchmod = callbackFrom("fchmod", 2, sync.fchmodSync, true);
export const fchown = callbackFrom("fchown", 3, sync.fchownSync, true);
export const fdatasync = callbackFrom("fdatasync", 1, sync.fdatasyncSync, true);
export const fstat = callbackFrom("fstat", 2, sync.fstatSync, false);
export const fsync = callbackFrom("fsync", 1, sync.fsyncSync, true);
export const ftruncate = callbackFrom("ftruncate", 2, sync.ftruncateSync, true);
export const futimes = callbackFrom("futimes", 3, sync.futimesSync, true);
export const lchmod = callbackFrom("lchmod", 2, sync.lchmodSync, true);
export const lchown = callbackFrom("lchown", 3, sync.lchownSync, true);
export const link = callbackFrom("link", 2, sync.linkSync, true);
export const lstat = callbackFrom("lstat", 2, sync.lstatSync, false);
export const lutimes = callbackFrom("lutimes", 3, sync.lutimesSync, true);
export const mkdir = callbackFrom("mkdir", 2, sync.mkdirSync, false);
export const mkdtemp = callbackFrom("mkdtemp", 2, sync.mkdtempSync, false);
export const open = callbackFrom("open", 3, sync.openSync, false);
export const opendir = callbackFrom("opendir", 2, sync.opendirSync, false);
export const readdir = callbackFrom("readdir", 2, sync.readdirSync, false);
const readFileNow = callbackWithSignal("readFile", sync.readFileSync, 1, false);

/** `fs.readFile(path | fd, options, callback)`; a pipe or terminal is read without blocking. */
export const readFile = named("readFile", function (this: unknown, ...args: unknown[]) {
  const file = args[0];
  if (!isFd(file) || !sync.isStreamFd(file)) {
    return Reflect.apply(readFileNow, this, args);
  }
  const callback = takeCallback(args, 2);
  const opts = getOptions(args[1], { flag: "r" });
  const aborted = abortedError(opts.signal);
  if (aborted !== null) {
    complete(() => callback(aborted));
    return;
  }
  sync.readAllFromFdAsync(file).then(
    (bytes) => {
      let value: unknown;
      try {
        value = decodeContents(bytes, opts.encoding);
      } catch (error) {
        complete(() => callback(error));
        return;
      }
      complete(() => callback(null, value));
    },
    (error: unknown) => complete(() => callback(error)),
  );
});
export const readlink = callbackFrom("readlink", 2, sync.readlinkSync, false);
export const rename = callbackFrom("rename", 2, sync.renameSync, true);
export const rmdir = callbackFrom("rmdir", 2, sync.rmdirSync, true);
export const stat = callbackFrom("stat", 2, sync.statSync, false);
export const statfs = callbackFrom("statfs", 2, sync.statfsSync, false);
export const symlink = callbackFrom("symlink", 3, sync.symlinkSync, true);
export const truncate = callbackFrom("truncate", 2, sync.truncateSync, true);
export const unlink = callbackFrom("unlink", 1, sync.unlinkSync, true);
export const utimes = callbackFrom("utimes", 3, sync.utimesSync, true);
export const writeFile = callbackWithSignal("writeFile", sync.writeFileSync, 2, true);

/** `fs.realpath(path, options, callback)`, with `.native`. */
export const realpath = Object.assign(callbackFrom("realpath", 2, sync.realpathSync, false), {
  native: callbackFrom("native", 2, sync.realpathSyncNative, false),
});

function defaultCloseCallback(error: unknown): void {
  if (error != null) {
    throw error;
  }
}

/** `fs.close(fd, callback)`: the callback is optional; an unhandled close error is thrown, as in Node. */
export function close(fd: unknown, callback: unknown = defaultCloseCallback): void {
  if (callback !== defaultCloseCallback) {
    validateFunction(callback, "cb");
  }
  const descriptor = getValidatedFd(fd);
  settle(callback as AnyCallback, () => {
    sync.closeSync(descriptor);
    return [];
  });
}

/** `fs.exists(path, callback)`: the callback gets a boolean only. Deprecated in Node, still present. */
export function exists(path: unknown, callback: unknown): void {
  validateFunction(callback, "cb");
  let shown: string;
  try {
    shown = getValidatedPath(path);
  } catch {
    (callback as (value: boolean) => void)(false);
    return;
  }
  const found = sync.existsSync(shown);
  complete(() => (callback as (value: boolean) => void)(found));
}

Object.defineProperty(exists, promisify.custom, {
  value: function existsPromisified(path: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      exists(path, resolve);
    });
  },
  enumerable: false,
  writable: false,
  configurable: true,
});

/**
 * `fs.read(fd, buffer, offset, length, position, callback)`, plus
 * `(fd, buffer, options, callback)`, `(fd, options, callback)`,
 * `(fd, buffer, callback)` and `(fd, callback)`.
 */
export function read(
  fd: unknown,
  buffer?: unknown,
  offsetOrOptions?: unknown,
  length?: unknown,
  position?: unknown,
  callback?: unknown,
): void {
  const descriptor = getValidatedFd(fd);
  let target = buffer;
  let offset = offsetOrOptions;
  let count = length;
  let at = position;
  let done = callback;
  if (arguments.length <= 4) {
    let params: unknown = null;
    if (arguments.length === 4) {
      // fs.read(fd, buffer, options, callback)
      validateObject(offsetOrOptions, "options", kValidateObjectAllowNullable);
      done = length;
      params = offsetOrOptions;
    } else if (arguments.length === 3) {
      // fs.read(fd, bufferOrParams, callback)
      if (!ArrayBuffer.isView(buffer)) {
        params = buffer;
        target = (params as { buffer?: unknown } | null | undefined)?.buffer ?? Buffer.alloc(16384);
      }
      done = offsetOrOptions;
    } else {
      // fs.read(fd, callback)
      done = buffer;
      target = Buffer.alloc(16384);
    }
    if (params !== undefined) {
      validateObject(params, "options", kValidateObjectAllowNullable);
    }
    const opts = (params ?? {}) as { offset?: unknown; length?: unknown; position?: unknown };
    offset = opts.offset ?? 0;
    count =
      opts.length ??
      ((target as ArrayBufferView | undefined)?.byteLength as number) - (offset as number);
    at = opts.position ?? null;
  }
  validateBuffer(target);
  validateFunction(done, "cb");
  const view = target;
  const args = sync.checkReadArgs(view, offset, count, at);
  if (args === null) {
    complete(() => (done as AnyCallback)(null, 0, view));
    return;
  }
  sync.readIntoAsync(descriptor, view, args.offset, args.length, args.position).then(
    (bytesRead) => complete(() => (done as AnyCallback)(null, bytesRead, view)),
    (error: unknown) => complete(() => (done as AnyCallback)(error, 0, view)),
  );
}

Object.defineProperty(read, promisify.custom, {
  value: function readPromisified(
    this: unknown,
    ...args: unknown[]
  ): Promise<{ bytesRead: number; buffer: unknown }> {
    return new Promise((resolve, reject) => {
      Reflect.apply(read, this, [
        ...args,
        (error: Error | null, bytesRead: number, buffer: unknown) =>
          error ? reject(error) : resolve({ bytesRead, buffer }),
      ]);
    });
  },
  enumerable: false,
  writable: false,
  configurable: true,
});

/**
 * `fs.write(fd, buffer, offset, length, position, callback)`, plus
 * `(fd, buffer, options, callback)` and `(fd, string, position, encoding, callback)`.
 */
export function write(
  fd: unknown,
  buffer: unknown,
  offsetOrOptions?: unknown,
  length?: unknown,
  position?: unknown,
  callback?: unknown,
): void {
  const descriptor = getValidatedFd(fd);
  let offset = offsetOrOptions;
  let count = length;
  let at = position;
  if (ArrayBuffer.isView(buffer)) {
    const done = (callback || position || length || offset) as unknown;
    validateFunction(done, "cb");
    if (typeof offset === "object") {
      const opts = (offsetOrOptions ?? {}) as {
        offset?: unknown;
        length?: unknown;
        position?: unknown;
      };
      offset = opts.offset ?? 0;
      count = opts.length ?? buffer.byteLength - (offset as number);
      at = opts.position ?? null;
    }
    if (offset == null || typeof offset === "function") {
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
    const where = backendPosition(at);
    settle(
      (error, written) => (done as AnyCallback)(error, written || 0, buffer),
      () => [runtime().fs.write(descriptor, bytes, where)],
    );
    return;
  }
  validateStringAfterArrayBufferView(buffer, "buffer");
  let done = position;
  if (typeof position !== "function") {
    if (typeof offset === "function") {
      done = offset;
      offset = null;
    } else {
      done = length;
    }
    count = "utf8";
  }
  const text = buffer;
  validateEncoding(text, count);
  validateFunction(done, "cb");
  const encoding = typeof count === "string" ? count : "utf8";
  const where = backendPosition(offset);
  settle(
    (error, written) => (done as AnyCallback)(error, written || 0, text),
    () => [runtime().fs.write(descriptor, encodeData(text, encoding), where)],
  );
}

Object.defineProperty(write, promisify.custom, {
  value: function writePromisified(
    this: unknown,
    ...args: unknown[]
  ): Promise<{ bytesWritten: number; buffer: unknown }> {
    return new Promise((resolve, reject) => {
      Reflect.apply(write, this, [
        ...args,
        (error: Error | null, bytesWritten: number, buffer: unknown) =>
          error ? reject(error) : resolve({ bytesWritten, buffer }),
      ]);
    });
  },
  enumerable: false,
  writable: false,
  configurable: true,
});

/** `fs.readv(fd, buffers, position, callback)`. */
export function readv(fd: unknown, buffers: unknown, position?: unknown, callback?: unknown): void {
  let done = callback;
  let at = position;
  if (typeof position === "function") {
    done = position;
    at = null;
  }
  validateFunction(done, "cb");
  const descriptor = getValidatedFd(fd);
  if (at == null && sync.isStreamFd(descriptor)) {
    // A pipe or terminal: wait for bytes without blocking the process.
    validateBufferArray(buffers);
    sync.readvAsync(descriptor, buffers as ArrayBufferView[]).then(
      (bytesRead) => complete(() => (done as AnyCallback)(null, bytesRead, buffers)),
      (error: unknown) => complete(() => (done as AnyCallback)(error, 0, buffers)),
    );
    return;
  }
  settle(
    (error, bytesRead) => (done as AnyCallback)(error, bytesRead || 0, buffers),
    () => [sync.readvSync(fd, buffers, at)],
  );
}

/** `fs.writev(fd, buffers, position, callback)`. */
export function writev(
  fd: unknown,
  buffers: unknown,
  position?: unknown,
  callback?: unknown,
): void {
  let done = callback;
  let at = position;
  if (typeof position === "function") {
    done = position;
    at = null;
  }
  validateFunction(done, "cb");
  settle(
    (error, written) => (done as AnyCallback)(error, written || 0, buffers),
    () => [sync.writevSync(fd, buffers, at)],
  );
}

function definePromisified(fn: AnyCallback, fields: [string, string]): void {
  Object.defineProperty(fn, promisify.custom, {
    value: function promisified(
      this: unknown,
      ...args: unknown[]
    ): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        Reflect.apply(fn, this, [
          ...args,
          (error: Error | null, first: unknown, second: unknown) =>
            error ? reject(error) : resolve({ [fields[0]]: first, [fields[1]]: second }),
        ]);
      });
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

definePromisified(readv as AnyCallback, ["bytesRead", "buffers"]);
definePromisified(writev as AnyCallback, ["bytesWritten", "buffers"]);

/** Removes with `opts`, waiting `retryDelay * attempt` before each retry, as Node's rimraf does. */
export function removeWithRetries(shown: string, opts: RmOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      try {
        sync.removeOnce(shown, opts);
        resolve();
      } catch (error) {
        if (attempt < opts.maxRetries && sync.isRetryableRm(error)) {
          attempt++;
          setTimeout(tryOnce, attempt * opts.retryDelay);
          return;
        }
        reject(error);
      }
    };
    tryOnce();
  });
}

/** `fs.rm(path, options, callback)`. */
export function rm(path: unknown, options: unknown, callback?: unknown): void {
  let done = callback;
  let opts = options;
  if (typeof options === "function") {
    done = options;
    opts = undefined;
  }
  validateFunction(done, "cb");
  const shown = getValidatedPath(path);
  let validated: RmOptions;
  try {
    validated = sync.validateRmOptions(shown, opts, false) as RmOptions;
  } catch (error) {
    if (isArgumentError(error)) {
      throw error;
    }
    complete(() => (done as AnyCallback)(error));
    return;
  }
  removeWithRetries(shown, validated).then(
    () => complete(() => (done as AnyCallback)(null)),
    (error: unknown) => complete(() => (done as AnyCallback)(error)),
  );
}

/** `fs.cp(src, dest, options, callback)`. */
export function cp(src: unknown, dest: unknown, options: unknown, callback?: unknown): void {
  let done = callback;
  let opts = options;
  if (typeof options === "function") {
    done = options;
    opts = undefined;
  }
  validateFunction(done, "cb");
  cpAsync(src, dest, opts).then(
    () => complete(() => (done as AnyCallback)(null, undefined)),
    (error: unknown) => complete(() => (done as AnyCallback)(error)),
  );
}

/** `fs.glob`: not provided by webnode. */
export function glob(): never {
  throw notImplemented("fs.glob()");
}

/** `fs.openAsBlob(path, { type })`: the file's current contents as a Blob. */
export function openAsBlob(path: unknown, options: unknown = {}): Promise<Blob> {
  validateObject(options, "options");
  const type = (options as { type?: unknown }).type || "";
  validateString(type, "options.type");
  const bytes = sync.readWholeFile(path);
  return Promise.resolve(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
}
