// `fs.cp` / `fs.cpSync` / `fs.promises.cp`: Node 22's recursive copy
// (lib/internal/fs/cp/). One walk serves all three: it is a generator that
// yields each `filter` result; the sync driver refuses a promise there, the
// async drivers await it. The error wording follows Node: the sync path reports
// its checks the way Node's C++ layer does, the async path as `SystemError`s.
import { isPromise } from "../util_types";
import { validateBoolean, validateFunction, validateObject } from "../internalErrors";
import path from "../path";
import { getValidatedPath, getValidMode } from "./args";
import { codedError, incompatibleOptionPair, invalidReturnValue, nodeSystemError } from "./errors";
import type { BigIntStats } from "./stats";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "./sync";

/** `cp` options after validation. */
export interface CpOptions {
  dereference: boolean;
  errorOnExist: boolean;
  filter: ((src: string, dest: string) => unknown) | undefined;
  force: boolean;
  preserveTimestamps: boolean;
  recursive: boolean;
  verbatimSymlinks: boolean;
  mode: number;
}

const DEFAULT_CP_OPTIONS = {
  dereference: false,
  errorOnExist: false,
  filter: undefined,
  force: true,
  preserveTimestamps: false,
  recursive: false,
  verbatimSymlinks: false,
};

/** `validateCpOptions`. */
export function validateCpOptions(options: unknown): CpOptions {
  if (options === undefined) {
    return { ...DEFAULT_CP_OPTIONS, mode: 0 };
  }
  validateObject(options, "options");
  const opts = { ...DEFAULT_CP_OPTIONS, ...(options as object) } as CpOptions &
    Record<string, unknown>;
  validateBoolean(opts.dereference, "options.dereference");
  validateBoolean(opts.errorOnExist, "options.errorOnExist");
  validateBoolean(opts.force, "options.force");
  validateBoolean(opts.preserveTimestamps, "options.preserveTimestamps");
  validateBoolean(opts.recursive, "options.recursive");
  validateBoolean(opts.verbatimSymlinks, "options.verbatimSymlinks");
  opts.mode = getValidMode(opts.mode, "copyFile");
  if (opts.dereference && opts.verbatimSymlinks) {
    throw incompatibleOptionPair("dereference", "verbatimSymlinks");
  }
  if (opts.filter !== undefined) {
    validateFunction(opts.filter, "options.filter");
  }
  return opts;
}

type Style = "sync" | "async";

/** A walk step: the value of one `filter` call, sent back as whether to copy. */
type CpWalk = Generator<unknown, void, unknown>;

function withSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sameSubject(dest: string, style: Style): Error {
  return style === "sync"
    ? codedError("ERR_FS_CP_EINVAL", `src and dest cannot be the same ${dest}`)
    : nodeSystemError("ERR_FS_CP_EINVAL", {
        code: "EINVAL",
        message: "src and dest cannot be the same",
        path: dest,
        syscall: "cp",
      });
}

function subdirOfSelf(src: string, dest: string, style: Style): Error {
  return style === "sync"
    ? codedError(
        "ERR_FS_CP_EINVAL",
        `Cannot copy ${withSlash(src)} to a subdirectory of self ${dest}`,
      )
    : nodeSystemError("ERR_FS_CP_EINVAL", {
        code: "EINVAL",
        message: `cannot copy ${src} to a subdirectory of self ${dest}`,
        path: dest,
        syscall: "cp",
      });
}

function dirToNonDir(src: string, dest: string, style: Style): Error {
  return style === "sync"
    ? codedError(
        "ERR_FS_CP_DIR_TO_NON_DIR",
        `Cannot overwrite non-directory ${src} with directory ${dest}`,
      )
    : nodeSystemError("ERR_FS_CP_DIR_TO_NON_DIR", {
        code: "EISDIR",
        message: `cannot overwrite non-directory ${dest} with directory ${src}`,
        path: dest,
        syscall: "cp",
      });
}

function nonDirToDir(src: string, dest: string, style: Style): Error {
  return style === "sync"
    ? codedError(
        "ERR_FS_CP_NON_DIR_TO_DIR",
        `Cannot overwrite directory ${dest} with non-directory ${src}`,
      )
    : nodeSystemError("ERR_FS_CP_NON_DIR_TO_DIR", {
        code: "ENOTDIR",
        message: `cannot overwrite directory ${dest} with non-directory ${src}`,
        path: dest,
        syscall: "cp",
      });
}

function isDirectoryError(src: string, style: Style): Error {
  return style === "sync"
    ? codedError(
        "ERR_FS_EISDIR",
        `Recursive option not enabled, cannot copy a directory: ${withSlash(src)}`,
      )
    : nodeSystemError("ERR_FS_EISDIR", {
        code: "EISDIR",
        message: `${src} is a directory (not copied)`,
        path: src,
        syscall: "cp",
      });
}

function srcStatOf(src: string, opts: CpOptions): BigIntStats {
  return (
    opts.dereference ? statSync(src, { bigint: true }) : lstatSync(src, { bigint: true })
  ) as BigIntStats;
}

function destStatOf(dest: string, opts: CpOptions): BigIntStats | undefined {
  const options = { bigint: true, throwIfNoEntry: false };
  return (opts.dereference ? statSync(dest, options) : lstatSync(dest, options)) as
    | BigIntStats
    | undefined;
}

function areIdentical(srcStat: BigIntStats, destStat: BigIntStats): boolean {
  return (
    destStat.ino !== 0n &&
    destStat.dev !== 0n &&
    destStat.ino === srcStat.ino &&
    destStat.dev === srcStat.dev
  );
}

/** True when `dest` is `src` or lies below it (`isSrcSubdir`). */
function isSrcSubdir(src: string, dest: string): boolean {
  const srcParts = path.resolve(src).split("/").filter(Boolean);
  const destParts = path.resolve(dest).split("/").filter(Boolean);
  return srcParts.every((part, i) => destParts[i] === part);
}

function checkPaths(
  src: string,
  dest: string,
  opts: CpOptions,
  style: Style,
): { srcStat: BigIntStats; destStat: BigIntStats | undefined } {
  const srcStat = srcStatOf(src, opts);
  const destStat = destStatOf(dest, opts);
  if (destStat !== undefined) {
    if (areIdentical(srcStat, destStat)) {
      throw sameSubject(dest, style);
    }
    if (srcStat.isDirectory() && !destStat.isDirectory()) {
      throw dirToNonDir(src, dest, style);
    }
    if (!srcStat.isDirectory() && destStat.isDirectory()) {
      throw nonDirToDir(src, dest, style);
    }
  }
  if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
    throw subdirOfSelf(src, dest, style);
  }
  return { srcStat, destStat };
}

/** `checkParentPaths`: refuses a `dest` whose parent chain reaches `src` through links. */
function checkParentPaths(src: string, srcStat: BigIntStats, dest: string, style: Style): void {
  const srcParent = path.resolve(path.dirname(src));
  const destParent = path.resolve(path.dirname(dest));
  if (destParent === srcParent || destParent === path.parse(destParent).root) {
    return;
  }
  const destStat = statSync(destParent, { bigint: true, throwIfNoEntry: false }) as
    | BigIntStats
    | undefined;
  if (destStat === undefined) {
    return;
  }
  if (areIdentical(srcStat, destStat)) {
    throw subdirOfSelf(src, dest, style);
  }
  checkParentPaths(src, srcStat, destParent, style);
}

function setDestMode(dest: string, srcMode: bigint): void {
  chmodSync(dest, Number(srcMode));
}

function copyOneFile(srcStat: BigIntStats, src: string, dest: string, opts: CpOptions): void {
  copyFileSync(src, dest, opts.mode);
  if (opts.preserveTimestamps) {
    if ((Number(srcStat.mode) & 0o200) === 0) {
      chmodSync(dest, Number(srcStat.mode) | 0o200);
    }
    const updated = statSync(src) as { atime: Date; mtime: Date };
    utimesSync(dest, updated.atime, updated.mtime);
  }
  setDestMode(dest, srcStat.mode);
}

function onFile(
  srcStat: BigIntStats,
  destStat: BigIntStats | undefined,
  src: string,
  dest: string,
  opts: CpOptions,
): void {
  if (destStat === undefined) {
    copyOneFile(srcStat, src, dest, opts);
    return;
  }
  if (opts.force) {
    unlinkSync(dest);
    copyOneFile(srcStat, src, dest, opts);
  } else if (opts.errorOnExist) {
    throw nodeSystemError("ERR_FS_CP_EEXIST", {
      code: "EEXIST",
      message: `${dest} already exists`,
      path: dest,
      syscall: "cp",
    });
  }
}

function onLink(
  destStat: BigIntStats | undefined,
  src: string,
  dest: string,
  opts: CpOptions,
  style: Style,
): void {
  let resolvedSrc = readlinkSync(src) as string;
  if (!opts.verbatimSymlinks && !path.isAbsolute(resolvedSrc)) {
    resolvedSrc = path.resolve(path.dirname(src), resolvedSrc);
  }
  if (destStat === undefined) {
    symlinkSync(resolvedSrc, dest);
    return;
  }
  let resolvedDest: string;
  try {
    resolvedDest = readlinkSync(dest) as string;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EINVAL" || code === "UNKNOWN") {
      symlinkSync(resolvedSrc, dest);
      return;
    }
    throw error;
  }
  if (!path.isAbsolute(resolvedDest)) {
    resolvedDest = path.resolve(path.dirname(dest), resolvedDest);
  }
  if (isSrcSubdir(resolvedSrc, resolvedDest)) {
    throw subdirOfSelf(resolvedSrc, resolvedDest, style);
  }
  if (
    (statSync(src) as { isDirectory(): boolean }).isDirectory() &&
    isSrcSubdir(resolvedDest, resolvedSrc)
  ) {
    throw nodeSystemError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", {
      code: "EINVAL",
      message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
      path: dest,
      syscall: "cp",
    });
  }
  unlinkSync(dest);
  symlinkSync(resolvedSrc, dest);
}

function* copyDir(src: string, dest: string, opts: CpOptions, style: Style): CpWalk {
  for (const name of readdirSync(src) as string[]) {
    const srcItem = path.join(src, name);
    const destItem = path.join(dest, name);
    if (opts.filter !== undefined && !(yield opts.filter(srcItem, destItem))) {
      continue;
    }
    const { destStat } = checkPaths(srcItem, destItem, opts, style);
    yield* startCopy(destStat, srcItem, destItem, opts, style);
  }
}

function* startCopy(
  destStat: BigIntStats | undefined,
  src: string,
  dest: string,
  opts: CpOptions,
  style: Style,
): CpWalk {
  const srcStat = srcStatOf(src, opts);
  if (srcStat.isDirectory()) {
    if (!opts.recursive) {
      throw isDirectoryError(src, style);
    }
    if (destStat === undefined) {
      mkdirSync(dest);
      yield* copyDir(src, dest, opts, style);
      setDestMode(dest, srcStat.mode);
    } else {
      yield* copyDir(src, dest, opts, style);
    }
  } else if (srcStat.isSymbolicLink()) {
    onLink(destStat, src, dest, opts, style);
  } else {
    onFile(srcStat, destStat, src, dest, opts);
  }
}

function* cpWalk(src: string, dest: string, opts: CpOptions, style: Style): CpWalk {
  if (opts.filter !== undefined && !(yield opts.filter(src, dest))) {
    return;
  }
  const { srcStat, destStat } = checkPaths(src, dest, opts, style);
  checkParentPaths(src, srcStat, dest, style);
  const destParent = path.dirname(dest);
  if (!existsSync(destParent)) {
    mkdirSync(destParent, { recursive: true });
  }
  yield* startCopy(destStat, src, dest, opts, style);
}

/** `fs.cpSync(src, dest, options)`. */
export function cpSync(src: unknown, dest: unknown, options?: unknown): void {
  const opts = validateCpOptions(options);
  const from = getValidatedPath(src, "src");
  const to = getValidatedPath(dest, "dest");
  const walk = cpWalk(from, to, opts, "sync");
  let step = walk.next();
  while (step.done !== true) {
    if (isPromise(step.value)) {
      throw invalidReturnValue("boolean", "filter", step.value);
    }
    step = walk.next(step.value);
  }
}

/**
 * The async copy behind `fs.cp` and `fs.promises.cp`, where `filter` may
 * return a promise. Argument errors throw at once; the copy's own errors
 * reject the returned promise.
 */
export function cpAsync(src: unknown, dest: unknown, options?: unknown): Promise<void> {
  const opts = validateCpOptions(options);
  const from = getValidatedPath(src, "src");
  const to = getValidatedPath(dest, "dest");
  return runAsync(cpWalk(from, to, opts, "async"));
}

async function runAsync(walk: CpWalk): Promise<void> {
  let step = walk.next();
  while (step.done !== true) {
    step = walk.next(await step.value);
  }
}
