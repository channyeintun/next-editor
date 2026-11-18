// The synchronous `fs` API (`statSync`, `readFileSync`, `openSync` …). Each
// function validates its arguments the way Node 22 does, makes paths absolute
// and calls the kernel's filesystem through `runtime().fs` — one backend call
// for the common cases — then restates any error with the caller's path and
// Node's syscall name. The callback and promise APIs are built on these.
import type { StatData } from "../../../kernel/vfs/types";
import { O_RDONLY, O_RDWR } from "../../../kernel/vfs/types";
import type { FsBackend } from "../../runtime";
import { runtime } from "../../runtime";
import type { Buffer } from "../buffer";
import {
  validateBoolean,
  validateInteger,
  validateObject,
  kValidateObjectAllowNullable,
} from "../internalErrors";
import path from "../path";
import {
  argValueError,
  backendPosition,
  bytesOf,
  decodeContents,
  encodeData,
  encodeText,
  getOptions,
  getValidatedFd,
  getValidatedPath,
  getValidMode,
  isFd,
  kIoMaxLength,
  parseFileMode,
  stringToFlags,
  toAbsolute,
  toUnixTimestamp,
  validateBuffer,
  validateBufferArray,
  validateEncoding,
  validateOffsetLengthRead,
  validateOffsetLengthWrite,
  validatePosition,
  validateStringAfterArrayBufferView,
  validateUint32,
} from "./args";
import { COPYFILE_FICLONE_FORCE } from "./constants";
import { Dir, Dirent, direntType } from "./dirent";
import {
  codedError,
  fileTooLarge,
  nodeSystemError,
  notImplemented,
  restate,
  rmSyncError,
} from "./errors";
import { createSystemError } from "../../../errors";
import { UID } from "../../platform";
import { makeStats, StatFs, type BigIntStats, type Stats } from "./stats";

const kMaxUserId = 2 ** 32 - 1;
const READ_CHUNK = 64 * 1024;
const RETRY_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

function backend(): FsBackend {
  return runtime().fs;
}

/** Runs `op` on the absolute form of `shown`, restating a failure for the caller. */
function onPath<T>(shown: string, op: (absolute: string) => T, syscall?: string): T {
  const absolute = toAbsolute(shown);
  try {
    return op(absolute);
  } catch (error) {
    throw restate(error, { absolute, shown, syscall });
  }
}

/** `onPath` for the two-path calls (`rename`, `link`, `symlink`, `copyFile`). */
function onPaths<T>(
  shown: string,
  shownDest: string,
  op: (absolute: string, absoluteDest: string) => T,
): T {
  const absolute = toAbsolute(shown);
  const absoluteDest = toAbsolute(shownDest);
  try {
    return op(absolute, absoluteDest);
  } catch (error) {
    throw restate(error, { absolute, shown, absoluteDest, shownDest });
  }
}

/** Runs a file-descriptor call, renaming the syscall when Node reports another. */
function onFd<T>(op: () => T, syscall?: string): T {
  try {
    return op();
  } catch (error) {
    throw syscall === undefined ? error : restate(error, { syscall });
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Reads `fd` from its offset to end of file. */
export function readAllFromFd(fd: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = backend().read(fd, READ_CHUNK, null);
    if (chunk.length === 0) {
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return concatChunks(chunks, total);
}

/** Writes all of `bytes` to `fd` at its offset. */
export function writeAllToFd(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = backend().write(fd, offset === 0 ? bytes : bytes.subarray(offset), null);
    if (written <= 0) {
      break;
    }
    offset += written;
  }
}

// ---- reading and writing whole files ----

/** `fs.readFileSync(path | fd, options)`. */
export function readFileSync(file: unknown, options?: unknown): string | Buffer {
  const opts = getOptions(options, { flag: "r" });
  let bytes: Uint8Array;
  if (isFd(file)) {
    bytes = readAllFromFd(file);
  } else {
    const shown = getValidatedPath(file);
    const flags = stringToFlags(opts.flag);
    bytes = onPath(shown, (absolute) => {
      if (flags === O_RDONLY) {
        return backend().readFile(absolute);
      }
      const fd = backend().open(absolute, flags, 0o666);
      try {
        return readAllFromFd(fd);
      } finally {
        backend().close(fd);
      }
    });
  }
  if (bytes.length > kIoMaxLength) {
    throw fileTooLarge(bytes.length);
  }
  return decodeContents(bytes, opts.encoding);
}

/** The bytes `writeFile` writes for `data`, validating it as Node does. */
export function writeFileBytes(data: unknown, encoding: unknown): Uint8Array {
  if (typeof data === "string") {
    return encodeData(data, encoding);
  }
  if (ArrayBuffer.isView(data)) {
    return bytesOf(data);
  }
  validateStringAfterArrayBufferView(data, "data");
  return encodeData(data, encoding);
}

/** `fs.writeFileSync(path | fd, data, options)`. */
export function writeFileSync(file: unknown, data: unknown, options?: unknown): void {
  const opts = getOptions(options, { encoding: "utf8", mode: 0o666, flag: "w", flush: false });
  const flush = opts.flush ?? false;
  validateBoolean(flush, "options.flush");
  const bytes = writeFileBytes(data, opts.encoding);
  if (isFd(file)) {
    writeAllToFd(file, bytes);
    if (flush) {
      backend().fsync(file);
    }
    return;
  }
  const shown = getValidatedPath(file);
  const flags = stringToFlags(opts.flag || "w");
  const mode = parseFileMode(opts.mode, "mode", 0o666);
  // `flush` needs nothing more for a path: the data is in the kernel's
  // filesystem the moment `writeFile` returns.
  onPath(shown, (absolute) => backend().writeFile(absolute, bytes, flags, mode));
}

/** `fs.appendFileSync(path | fd, data, options)`. */
export function appendFileSync(file: unknown, data: unknown, options?: unknown): void {
  const opts = { ...getOptions(options, { encoding: "utf8", mode: 0o666, flag: "a" }) };
  if (!opts.flag || isFd(file)) {
    opts.flag = "a";
  }
  writeFileSync(file, data, opts);
}

// ---- stat ----

function statWith(
  file: unknown,
  options: unknown,
  follow: boolean,
): Stats | BigIntStats | undefined {
  const opts = (options ?? {}) as { bigint?: unknown; throwIfNoEntry?: unknown };
  const shown = getValidatedPath(file);
  const absolute = toAbsolute(shown);
  let data: StatData;
  try {
    data = backend().stat(absolute, follow);
  } catch (error) {
    if (opts.throwIfNoEntry === false && (error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw restate(error, { absolute, shown });
  }
  return makeStats(data, opts.bigint);
}

/** `fs.statSync(path, { bigint, throwIfNoEntry })`. */
export function statSync(file: unknown, options?: unknown): Stats | BigIntStats | undefined {
  return statWith(file, options, true);
}

/** `fs.lstatSync(path, { bigint, throwIfNoEntry })`. */
export function lstatSync(file: unknown, options?: unknown): Stats | BigIntStats | undefined {
  return statWith(file, options, false);
}

/** `fs.fstatSync(fd, { bigint })`. */
export function fstatSync(fd: unknown, options?: unknown): Stats | BigIntStats {
  const descriptor = getValidatedFd(fd);
  return makeStats(
    backend().fstat(descriptor),
    (options as { bigint?: unknown } | undefined)?.bigint,
  );
}

/** The in-memory filesystem reports itself as tmpfs; it has no fixed capacity, so the sizes are a nominal 8 GiB. */
const STATFS_VALUES = [0x01021994, 4096, 2097152, 2097152, 2097152, 1048576, 1048576] as const;

/** `fs.statfsSync(path, { bigint })`. */
export function statfsSync(file: unknown, options?: unknown): StatFs {
  const shown = getValidatedPath(file);
  onPath(shown, (absolute) => backend().stat(absolute, true), "statfs");
  return new StatFs(STATFS_VALUES, (options as { bigint?: unknown } | undefined)?.bigint === true);
}

/** `fs.existsSync(path)`: false for anything that is not a valid path. */
export function existsSync(file: unknown): boolean {
  let shown: string;
  try {
    shown = getValidatedPath(file);
  } catch {
    return false;
  }
  return backend().exists(toAbsolute(shown));
}

/** `fs.accessSync(path, mode)`. */
export function accessSync(file: unknown, mode?: unknown): void {
  const shown = getValidatedPath(file);
  const checked = getValidMode(mode, "access");
  onPath(shown, (absolute) => backend().access(absolute, checked));
}

// ---- directories ----

interface ReaddirOptions {
  encoding?: unknown;
  withFileTypes?: unknown;
  recursive?: unknown;
}

/** `fs.readdirSync(path, options)`. */
export function readdirSync(file: unknown, options?: unknown): (string | Buffer)[] | Dirent[] {
  const opts = getOptions(options) as ReaddirOptions;
  const shown = getValidatedPath(file);
  if (opts.recursive != null) {
    validateBoolean(opts.recursive, "options.recursive");
  }
  const encoding = opts.encoding;
  if (opts.recursive !== true) {
    const entries = onPath(shown, (absolute) => backend().readdir(absolute));
    if (opts.withFileTypes) {
      return entries.map(
        (entry) => new Dirent(encodeText(entry.name, encoding), direntType(entry.type), shown),
      );
    }
    return entries.map((entry) => encodeText(entry.name, encoding));
  }
  // Node 26 reads each directory below the start by `path.join` (which is
  // also its entries' `parentPath`), and names one that fails as the start
  // as spelled with the names below it appended: './a/nr' from '.',
  // 'a/../nr' from 'a/..'.
  const below = (relative: string, name: string) =>
    relative === "" ? name : `${relative}/${name}`;
  const list = (dir: string, relative: string) => {
    const absolute = toAbsolute(dir);
    try {
      return backend().readdir(absolute);
    } catch (error) {
      const named =
        relative === "" || shown.endsWith("/") ? shown + relative : `${shown}/${relative}`;
      throw restate(error, { absolute, shown: named });
    }
  };
  // Node descends into every entry that stats as a directory, so a link to a
  // directory is followed.
  const descends = (type: string, child: string): boolean => {
    if (type !== "symlink") {
      return type === "dir";
    }
    try {
      return (backend().stat(toAbsolute(child), true).mode & 0o170000) === 0o040000;
    } catch {
      return false;
    }
  };
  /** Each directory to read: as `path.join` spells it, and its names below the start. */
  const queue: { dir: string; relative: string }[] = [{ dir: shown, relative: "" }];
  if (opts.withFileTypes) {
    const results: Dirent[] = [];
    for (let i = 0; i < queue.length; i++) {
      const { dir, relative } = queue[i];
      for (const entry of list(dir, relative)) {
        results.push(new Dirent(encodeText(entry.name, encoding), direntType(entry.type), dir));
        const child = path.join(dir, entry.name);
        if (descends(entry.type, child)) {
          queue.push({ dir: child, relative: below(relative, entry.name) });
        }
      }
    }
    return results;
  }
  const results: (string | Buffer)[] = [];
  for (let i = 0; i < queue.length; i++) {
    const { dir, relative } = queue[i];
    for (const entry of list(dir, relative)) {
      const name = below(relative, entry.name);
      results.push(encodeText(name, encoding));
      const child = path.join(dir, entry.name);
      if (descends(entry.type, child)) {
        queue.push({ dir: child, relative: name });
      }
    }
  }
  return results;
}

/** `fs.mkdirSync`: with `fs.mkdir`'s other forms in ./mkdir. */
export { mkdirSync } from "./mkdir";

/** `fs.mkdtempSync(prefix, options)`. */
export function mkdtempSync(prefix: unknown, options?: unknown): string | Buffer {
  const opts = getOptions(options);
  const shown = getValidatedPath(prefix, "prefix");
  const absolute = toAbsolute(shown);
  let created: string;
  try {
    created = backend().mkdtemp(absolute);
  } catch (error) {
    throw restate(error, { absolute: `${absolute}XXXXXX`, shown: `${shown}XXXXXX` });
  }
  return encodeText(shown + created.slice(absolute.length), opts.encoding);
}

/** `fs.rmdirSync(path, options)`. The deprecated `recursive` removes the tree, as `rm -r` would. */
export function rmdirSync(file: unknown, options?: unknown): void {
  const shown = getValidatedPath(file);
  if ((options as { recursive?: unknown } | undefined)?.recursive) {
    const opts = validateRmOptions(shown, { ...(options as object), force: false }, true);
    if (opts !== false) {
      removeTree(shown, opts);
      return;
    }
  } else {
    validateRmdirOptions(options, DEFAULT_RMDIR_OPTIONS);
  }
  onPath(shown, (absolute) => backend().rmdir(absolute));
}

/** Options of `rm` and `rmdir` after defaults. */
export interface RmOptions {
  recursive: boolean;
  force: boolean;
  retryDelay: number;
  maxRetries: number;
}

const DEFAULT_RMDIR_OPTIONS: RmOptions = {
  recursive: false,
  force: false,
  retryDelay: 100,
  maxRetries: 0,
};
const DEFAULT_RM_OPTIONS: RmOptions = {
  recursive: false,
  force: false,
  retryDelay: 100,
  maxRetries: 0,
};

/** `validateRmdirOptions`. */
function validateRmdirOptions(options: unknown, defaults: RmOptions): RmOptions {
  if (options === undefined) {
    return defaults;
  }
  validateObject(options, "options");
  const merged = { ...defaults, ...(options as object) } as RmOptions;
  validateBoolean(merged.recursive, "options.recursive");
  validateInteger(merged.retryDelay, "options.retryDelay", 0, 2147483647);
  validateUint32(merged.maxRetries, "options.maxRetries");
  return merged;
}

/**
 * `validateRmOptionsSync` and, for the callback and promise forms,
 * `validateRmOptions`: the options with defaults, after the `lstat` Node makes
 * to refuse a directory without `recursive`. The sync form leaves the `lstat`
 * out when nothing could be refused; the others always make it, and so report
 * whatever it fails with but a missing path under `force`. False when
 * `expectDir` and the path is not a directory.
 */
export function validateRmOptions(
  shown: string,
  options: unknown,
  expectDir: boolean,
  form: "sync" | "async" = "sync",
): RmOptions | false {
  const opts = validateRmdirOptions(options, DEFAULT_RM_OPTIONS);
  validateBoolean(opts.force, "options.force");
  if (form === "async" || !opts.force || expectDir || !opts.recursive) {
    const stats = lstatSync(shown, { throwIfNoEntry: !opts.force });
    const isDirectory = stats?.isDirectory();
    if (expectDir && !isDirectory) {
      return false;
    }
    if (isDirectory && !opts.recursive) {
      throw nodeSystemError("ERR_FS_EISDIR", {
        code: "EISDIR",
        message: "is a directory",
        path: shown,
        syscall: "rm",
      });
    }
  }
  return opts;
}

/**
 * One removal attempt of `shown` with validated options, as `rmSync` makes it
 * (std::filesystem in Node's C++): a refusal names the path given, whichever
 * entry below it was refused (`rmSyncError`).
 */
function removeOnce(shown: string, opts: RmOptions): void {
  const absolute = toAbsolute(shown);
  try {
    backend().rm(absolute, opts.recursive, opts.force);
  } catch (error) {
    throw rmSyncError(restate(error, { absolute, shown }), shown);
  }
}

/** True when a failed removal is one Node retries. */
export function isRetryableRm(error: unknown): boolean {
  return RETRY_CODES.has((error as { code?: string }).code ?? "");
}

function removeTree(shown: string, opts: RmOptions): void {
  for (let attempt = 0; ; attempt++) {
    try {
      removeOnce(shown, opts);
      return;
    } catch (error) {
      if (attempt < opts.maxRetries && isRetryableRm(error)) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * `fs.rmSync(path, { recursive, force, maxRetries, retryDelay })`. A sync
 * call cannot wait, so retries happen at once rather than after `retryDelay`.
 */
export function rmSync(file: unknown, options?: unknown): void {
  const shown = getValidatedPath(file);
  const opts = validateRmOptions(shown, options, false) as RmOptions;
  removeTree(shown, opts);
}

/**
 * `fs.opendirSync(path, { encoding, bufferSize, recursive })`. Its error names
 * no path, as Node's sync form.
 */
export function opendirSync(file: unknown, options?: unknown): Dir {
  return openDirectory(file, options, "sync");
}

/**
 * `fs.opendir`'s work for its callback and promise forms, whose error names
 * the directory as the caller spelled it.
 */
export function opendirAsync(file: unknown, options?: unknown): Dir {
  return openDirectory(file, options, "async");
}

function openDirectory(file: unknown, options: unknown, form: "sync" | "async"): Dir {
  const shown = getValidatedPath(file);
  const opts = getOptions(options, { encoding: "utf8" as unknown });
  const bufferSize = opts.bufferSize ?? 32;
  validateUint32(bufferSize, "options.bufferSize", true);
  const recursive = opts.recursive ?? false;
  validateBoolean(recursive, "options.recursive");
  const absolute = toAbsolute(shown);
  let entries;
  try {
    entries = backend().readdir(absolute);
  } catch (error) {
    throw restate(
      error,
      form === "sync"
        ? { syscall: "opendir", dropPath: true }
        : { syscall: "opendir", absolute, shown },
    );
  }
  const encoding = opts.encoding;
  return new Dir(
    shown,
    entries,
    {
      list: (dir) => onPath(dir, (abs) => backend().readdir(abs)),
      encodeName: (name) => encodeText(name, encoding),
    },
    recursive,
    bufferSize as number,
  );
}

// ---- links, renames, removal ----

/** `fs.renameSync(oldPath, newPath)`. */
export function renameSync(oldPath: unknown, newPath: unknown): void {
  const from = getValidatedPath(oldPath, "oldPath");
  const to = getValidatedPath(newPath, "newPath");
  onPaths(from, to, (a, b) => backend().rename(a, b));
}

/** `fs.linkSync(existingPath, newPath)`. */
export function linkSync(existingPath: unknown, newPath: unknown): void {
  const from = getValidatedPath(existingPath, "existingPath");
  const to = getValidatedPath(newPath, "newPath");
  onPaths(from, to, (a, b) => backend().link(a, b));
}

/** `fs.symlinkSync(target, path, type)`. The target is stored as given; `type` only matters on Windows. */
export function symlinkSync(target: unknown, file: unknown, type?: unknown): void {
  const shownTarget = getValidatedPath(target, "target");
  const shown = getValidatedPath(file);
  if (typeof type === "string" && type !== "dir" && type !== "file" && type !== "junction") {
    throw codedError(
      "ERR_FS_INVALID_SYMLINK_TYPE",
      `Symlink type must be one of "dir", "file", or "junction". Received "${type}"`,
    );
  }
  const absolute = toAbsolute(shown);
  try {
    backend().symlink(shownTarget, absolute);
  } catch (error) {
    throw restate(error, { absoluteDest: absolute, shownDest: shown });
  }
}

/** `fs.readlinkSync(path, options)`. */
export function readlinkSync(file: unknown, options?: unknown): string | Buffer {
  const opts = getOptions(options);
  const shown = getValidatedPath(file);
  return encodeText(
    onPath(shown, (absolute) => backend().readlink(absolute)),
    opts.encoding,
  );
}

/** `fs.unlinkSync(path)`. */
export function unlinkSync(file: unknown): void {
  const shown = getValidatedPath(file);
  onPath(shown, (absolute) => backend().unlink(absolute));
}

/**
 * The error Node's JavaScript `realpath` reports for `resolved` (an absolute,
 * lexically resolved path): it `lstat`s each component in turn, so the error
 * names the first component that fails, with syscall `lstat`.
 */
function realpathFailure(resolved: string, error: unknown): unknown {
  const parts = resolved.split("/").filter((part) => part !== "");
  let prefix = "";
  for (const part of parts) {
    prefix += `/${part}`;
    let syscall = "lstat";
    try {
      const own = backend().stat(prefix, false);
      if ((own.mode & 0o170000) === 0o120000) {
        // Node stats a link before reading it.
        syscall = "stat";
        backend().stat(prefix, true);
      }
    } catch (componentError) {
      const code = (componentError as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
        return createSystemError(code, syscall, prefix);
      }
      return componentError;
    }
  }
  return error;
}

/** `fs.realpathSync(path, options)`: Node's JavaScript realpath (lexical `..`, errors from `lstat`). */
export function realpathSync(file: unknown, options?: unknown): string | Buffer {
  const opts = getOptions(options);
  const shown = getValidatedPath(file);
  const resolved = path.resolve(shown);
  let real: string;
  try {
    real = backend().realpath(resolved);
  } catch (error) {
    throw realpathFailure(resolved, error);
  }
  return encodeText(real, opts.encoding);
}

/** `fs.realpathSync.native(path, options)`: the kernel's realpath(3). */
export function realpathSyncNative(file: unknown, options?: unknown): string | Buffer {
  const opts = getOptions(options);
  const shown = getValidatedPath(file);
  return encodeText(
    onPath(shown, (absolute) => backend().realpath(absolute)),
    opts.encoding,
  );
}

realpathSync.native = realpathSyncNative;

/** `fs.copyFileSync(src, dest, mode)`. Copy-on-write clones are not offered: `COPYFILE_FICLONE_FORCE` fails with ENOTSUP. */
export function copyFileSync(src: unknown, dest: unknown, mode?: unknown): void {
  const from = getValidatedPath(src, "src");
  const to = getValidatedPath(dest, "dest");
  const flags = getValidMode(mode, "copyFile");
  if ((flags & COPYFILE_FICLONE_FORCE) !== 0) {
    throw createSystemError("ENOTSUP", "copyfile", from, to);
  }
  onPaths(from, to, (a, b) => backend().copyFile(a, b, flags & 1));
}

// ---- metadata ----

/** `fs.chmodSync(path, mode)`. */
export function chmodSync(file: unknown, mode: unknown): void {
  const shown = getValidatedPath(file);
  const checked = parseFileMode(mode, "mode");
  onPath(shown, (absolute) => backend().chmod(absolute, checked, true));
}

/** `fs.lchmodSync(path, mode)`: changes a link itself, which Linux refuses with ENOTSUP. */
export function lchmodSync(file: unknown, mode: unknown): void {
  const shown = getValidatedPath(file);
  const checked = parseFileMode(mode, "mode");
  onPath(shown, (absolute) => backend().chmod(absolute, checked, false), "lchmod");
}

/** `fs.fchmodSync(fd, mode)`. */
export function fchmodSync(fd: unknown, mode: unknown): void {
  const descriptor = getValidatedFd(fd);
  const checked = parseFileMode(mode, "mode");
  backend().fchmod(descriptor, checked);
}

function validateIds(uid: unknown, gid: unknown): void {
  validateInteger(uid, "uid", -1, kMaxUserId);
  validateInteger(gid, "gid", -1, kMaxUserId);
}

// A file belongs to the one user every process runs as, who is not root, or
// to root. As chown(2) answers such a user: on the user's own file, asking
// for the owner and group it has already succeeds without effect; on root's,
// only -1 for both (leave them as they are) does; any other id is refused
// with EPERM.

/**
 * Refuses a change of owner or group the one user may not make (see above).
 * `path` is the file's absolute path, for the calls that name one.
 */
function checkOwner(
  stat: StatData,
  uid: unknown,
  gid: unknown,
  syscall: string,
  path?: string,
): void {
  const own = stat.uid === UID;
  if ((uid !== -1 && (!own || uid !== stat.uid)) || (gid !== -1 && (!own || gid !== stat.gid))) {
    throw createSystemError("EPERM", syscall, path);
  }
}

/** `fs.chownSync(path, uid, gid)`. */
export function chownSync(file: unknown, uid: unknown, gid: unknown): void {
  const shown = getValidatedPath(file);
  validateIds(uid, gid);
  onPath(
    shown,
    (absolute) => checkOwner(backend().stat(absolute, true), uid, gid, "chown", absolute),
    "chown",
  );
}

/** `fs.lchownSync(path, uid, gid)`: the link itself. */
export function lchownSync(file: unknown, uid: unknown, gid: unknown): void {
  const shown = getValidatedPath(file);
  validateIds(uid, gid);
  onPath(
    shown,
    (absolute) => checkOwner(backend().stat(absolute, false), uid, gid, "lchown", absolute),
    "lchown",
  );
}

/** `fs.fchownSync(fd, uid, gid)`. */
export function fchownSync(fd: unknown, uid: unknown, gid: unknown): void {
  const descriptor = getValidatedFd(fd);
  validateIds(uid, gid);
  onFd(() => checkOwner(backend().fstat(descriptor), uid, gid, "fchown"), "fchown");
}

/** `fs.utimesSync(path, atime, mtime)`. */
export function utimesSync(file: unknown, atime: unknown, mtime: unknown): void {
  const shown = getValidatedPath(file);
  const a = toUnixTimestamp(atime) * 1000;
  const m = toUnixTimestamp(mtime) * 1000;
  onPath(shown, (absolute) => backend().utimes(absolute, a, m, true));
}

/** `fs.lutimesSync(path, atime, mtime)`. */
export function lutimesSync(file: unknown, atime: unknown, mtime: unknown): void {
  const shown = getValidatedPath(file);
  const a = toUnixTimestamp(atime) * 1000;
  const m = toUnixTimestamp(mtime) * 1000;
  onPath(shown, (absolute) => backend().utimes(absolute, a, m, false), "lutime");
}

/** `fs.futimesSync(fd, atime, mtime)`. */
export function futimesSync(fd: unknown, atime: unknown, mtime: unknown): void {
  const descriptor = getValidatedFd(fd);
  const a = toUnixTimestamp(atime, "atime") * 1000;
  const m = toUnixTimestamp(mtime, "mtime") * 1000;
  backend().futimes(descriptor, a, m);
}

/** `fs.truncateSync(path, len)`; a file descriptor goes to `ftruncateSync`. */
export function truncateSync(file: unknown, len?: unknown): void {
  if (typeof file === "number") {
    ftruncateSync(file, len);
    return;
  }
  const length = len === undefined ? 0 : len;
  const shown = getValidatedPath(file);
  if (!Number.isInteger(length)) {
    // Node opens the file (r+) before it looks at `len`.
    onPath(shown, (absolute) => backend().close(backend().open(absolute, O_RDWR, 0o666)));
  }
  validateInteger(length, "len");
  onPath(shown, (absolute) => backend().truncate(absolute, Math.max(0, length)));
}

/** `fs.ftruncateSync(fd, len)`. */
export function ftruncateSync(fd: unknown, len: unknown = 0): void {
  const descriptor = getValidatedFd(fd);
  validateInteger(len, "len");
  backend().ftruncate(descriptor, Math.max(0, len));
}

// ---- file descriptors ----

/** `fs.openSync(path, flags, mode)`. */
export function openSync(file: unknown, flags?: unknown, mode?: unknown): number {
  const shown = getValidatedPath(file);
  const flagBits = stringToFlags(flags);
  const checked = parseFileMode(mode, "mode", 0o666);
  return onPath(shown, (absolute) => backend().open(absolute, flagBits, checked));
}

/** `fs.closeSync(fd)`. */
export function closeSync(fd: unknown): void {
  backend().close(getValidatedFd(fd));
}

/** `fs.fsyncSync(fd)`. */
export function fsyncSync(fd: unknown): void {
  backend().fsync(getValidatedFd(fd));
}

/** `fs.fdatasyncSync(fd)`. */
export function fdatasyncSync(fd: unknown): void {
  onFd(() => backend().fsync(getValidatedFd(fd)), "fdatasync");
}

/** Reads into `buffer[offset, offset + length)`; returns the byte count. */
export function readInto(
  fd: number,
  buffer: ArrayBufferView,
  offset: number,
  length: number,
  position: unknown,
): number {
  const bytes = backend().read(fd, length, backendPosition(position));
  bytesOf(buffer).set(bytes, offset);
  return bytes.length;
}

/**
 * As `readInto`, without blocking the process: for the callback and promise
 * forms of `read`, which must leave a program free to do other work while it
 * waits on a pipe or terminal. The pending read keeps the process alive.
 */
export async function readIntoAsync(
  fd: number,
  buffer: ArrayBufferView,
  offset: number,
  length: number,
  position: unknown,
): Promise<number> {
  const rt = runtime();
  rt.ref();
  try {
    const bytes = await rt.fs.readAsync(fd, length, backendPosition(position));
    bytesOf(buffer).set(bytes, offset);
    return bytes.length;
  } finally {
    rt.unref();
  }
}

/**
 * Whether reading `fd` waits on another process (a pipe or a terminal), so an
 * asynchronous read of it must not block: `read` there would stop the whole
 * process until bytes arrive. A bad fd answers false; the read reports it.
 */
export function isStreamFd(fd: number): boolean {
  let kind: string;
  try {
    kind = runtime().fdStream.kind(fd);
  } catch {
    return false;
  }
  return kind === "pipe" || kind === "tty";
}

/** As `readAllFromFd`, without blocking: for `readFile` on a pipe or terminal. */
export async function readAllFromFdAsync(fd: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(READ_CHUNK);
    const length = await readIntoAsync(fd, chunk, 0, READ_CHUNK, null);
    if (length === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, length));
    total += length;
    if (total > kIoMaxLength) {
      throw fileTooLarge(total);
    }
  }
  return concatChunks(chunks, total);
}

/** As `readvSync`, without blocking: one read, spread over `buffers`, as readv(2) does. */
export async function readvAsync(fd: number, buffers: ArrayBufferView[]): Promise<number> {
  const views = buffers.map((buffer) => bytesOf(buffer));
  const wanted = views.reduce((sum, view) => sum + view.length, 0);
  if (wanted === 0) {
    return 0;
  }
  const rt = runtime();
  rt.ref();
  let bytes: Uint8Array;
  try {
    bytes = await rt.fs.readAsync(fd, wanted, null);
  } finally {
    rt.unref();
  }
  let offset = 0;
  for (const view of views) {
    if (offset >= bytes.length) {
      break;
    }
    const part = bytes.subarray(offset, offset + view.length);
    view.set(part);
    offset += part.length;
  }
  return bytes.length;
}

/** Validated `read` arguments: what `readSync`, `read` and `FileHandle.read` share after their overloads. */
export interface ReadArgs {
  offset: number;
  length: number;
  position: unknown;
}

/** The checks Node makes once `offset`, `length` and `position` are known; null means "read nothing". */
export function checkReadArgs(
  buffer: ArrayBufferView,
  offset: unknown,
  length: unknown,
  position: unknown,
): ReadArgs | null {
  let start = 0;
  if (offset != null) {
    validateInteger(offset, "offset", 0);
    start = offset;
  }
  const count = (length as number) | 0;
  if (count === 0) {
    return null;
  }
  if (buffer.byteLength === 0) {
    throw argValueError("buffer", buffer, "is empty and cannot be written");
  }
  validateOffsetLengthRead(start, count, buffer.byteLength);
  const at = position == null ? -1 : position;
  validatePosition(at, "position", count);
  return { offset: start, length: count, position: at };
}

/** `fs.readSync(fd, buffer, offset, length, position)` and `readSync(fd, buffer, options)`. */
export function readSync(
  fd: unknown,
  buffer: unknown,
  offsetOrOptions?: unknown,
  length?: unknown,
  position?: unknown,
): number {
  const descriptor = getValidatedFd(fd);
  validateBuffer(buffer);
  let offset = offsetOrOptions;
  let count = length;
  let at = position;
  if (arguments.length <= 3 || typeof offsetOrOptions === "object") {
    if (offsetOrOptions !== undefined) {
      validateObject(offsetOrOptions, "options", kValidateObjectAllowNullable);
    }
    const opts = (offsetOrOptions ?? {}) as {
      offset?: unknown;
      length?: unknown;
      position?: unknown;
    };
    offset = opts.offset ?? 0;
    count = opts.length ?? buffer.byteLength - (offset as number);
    at = opts.position ?? null;
  }
  const args = checkReadArgs(buffer, offset, count, at);
  if (args === null) {
    return 0;
  }
  return readInto(descriptor, buffer, args.offset, args.length, args.position);
}

/** `fs.writeSync(fd, buffer, offset, length, position)`, `(fd, buffer, options)` and `(fd, string, position, encoding)`. */
export function writeSync(
  fd: unknown,
  buffer: unknown,
  offsetOrOptions?: unknown,
  length?: unknown,
  position?: unknown,
): number {
  const descriptor = getValidatedFd(fd);
  if (ArrayBuffer.isView(buffer)) {
    let offset = offsetOrOptions;
    let count = length;
    let at = position;
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
    if (at === undefined) {
      at = null;
    }
    if (typeof offset !== "number") {
      offset = 0;
    }
    if (typeof count !== "number") {
      count = buffer.byteLength - (offset as number);
    }
    validateOffsetLengthWrite(offset as number, count as number, buffer.byteLength);
    const bytes = bytesOf(buffer).subarray(
      offset as number,
      (offset as number) + (count as number),
    );
    return backend().write(descriptor, bytes, backendPosition(at));
  }
  validateStringAfterArrayBufferView(buffer, "buffer");
  validateEncoding(buffer, length);
  const encoding = typeof length === "string" ? length : "utf8";
  return backend().write(
    descriptor,
    encodeData(buffer, encoding),
    backendPosition(offsetOrOptions),
  );
}

/** `fs.readvSync(fd, buffers, position)`. */
export function readvSync(fd: unknown, buffers: unknown, position?: unknown): number {
  const descriptor = getValidatedFd(fd);
  validateBufferArray(buffers);
  let at = typeof position === "number" ? backendPosition(position) : null;
  let total = 0;
  for (const buffer of buffers) {
    const view = bytesOf(buffer);
    if (view.length === 0) {
      continue;
    }
    const bytes = backend().read(descriptor, view.length, at);
    view.set(bytes);
    total += bytes.length;
    if (at !== null) {
      at += bytes.length;
    }
    if (bytes.length < view.length) {
      break;
    }
  }
  return total;
}

/** `fs.writevSync(fd, buffers, position)`. */
export function writevSync(fd: unknown, buffers: unknown, position?: unknown): number {
  const descriptor = getValidatedFd(fd);
  validateBufferArray(buffers);
  let at = typeof position === "number" ? backendPosition(position) : null;
  let total = 0;
  for (const buffer of buffers) {
    const view = bytesOf(buffer);
    if (view.length === 0) {
      continue;
    }
    const written = backend().write(descriptor, view, at);
    total += written;
    if (at !== null) {
      at += written;
    }
    if (written < view.length) {
      break;
    }
  }
  return total;
}

/** `fs.globSync`: not provided by webnode. */
export function globSync(): never {
  throw notImplemented("fs.globSync()");
}

/** `fs._toUnixTimestamp`. */
export const _toUnixTimestamp = toUnixTimestamp;

/** Reads `path` (validated) whole, for `openAsBlob`. */
export function readWholeFile(file: unknown): Uint8Array {
  const shown = getValidatedPath(file);
  return onPath(shown, (absolute) => backend().readFile(absolute));
}
