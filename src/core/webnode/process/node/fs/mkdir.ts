// `fs.mkdir` in all three forms. With `recursive` Node runs MKDirpSync or
// MKDirpAsync (src/node_file.cc): one directory per step, the path first and
// then (on ENOENT) its parents, working on the path as the caller spelled it
// (a parent is the text before the last slash). So each form returns the first
// directory it made in the caller's spelling ('v/q/' for 'v/q/', 'v//x/' for
// 'v//x//y'). A failure names the whole path in the sync form, and the step
// that failed in the callback and promise forms ('ro/a' for 'ro/a/b'). A path
// of plain names is first asked of the filesystem as one request, which gives
// the same result when it is not refused (`makeAtOnce`).
import { createSystemError, errnoCodeOf, type ErrnoCode } from "../../../errors";
import { S_IFDIR, S_IFMT, type StatData } from "../../../kernel/vfs/types";
import { runtime, type FsBackend } from "../../runtime";
import { validateBoolean } from "../internalErrors";
import { getValidatedPath, parseFileMode, toAbsolute } from "./args";
import { restate } from "./errors";

/** `fs.mkdir`'s arguments, validated as Node does for all three forms. */
interface MkdirArguments {
  /** The path as the caller gave it. */
  shown: string;
  recursive: boolean;
  mode: number;
}

/** Validates `fs.mkdir(path, mode | { recursive, mode })`'s arguments. */
function mkdirArguments(file: unknown, options?: unknown): MkdirArguments {
  let mode = 0o777;
  let recursive: unknown = false;
  if (typeof options === "number" || typeof options === "string") {
    mode = parseFileMode(options, "mode");
  } else if (options) {
    const opts = options as { recursive?: unknown; mode?: unknown };
    if (opts.recursive !== undefined) {
      recursive = opts.recursive;
    }
    if (opts.mode !== undefined) {
      mode = parseFileMode(opts.mode, "options.mode");
    }
  }
  validateBoolean(recursive, "options.recursive");
  return { shown: getValidatedPath(file), recursive, mode };
}

/** `fs.mkdirSync(path, mode | { recursive, mode })`. */
export function mkdirSync(file: unknown, options?: unknown): string | undefined {
  return makeDirectory(mkdirArguments(file, options), "sync");
}

/** `fs.mkdir`'s work for its callback and promise forms. */
export function mkdirAsync(file: unknown, options?: unknown): string | undefined {
  return makeDirectory(mkdirArguments(file, options), "async");
}

function makeDirectory(args: MkdirArguments, form: "sync" | "async"): string | undefined {
  if (args.recursive) {
    return mkdirp(args.shown, args.mode, form);
  }
  const absolute = toAbsolute(args.shown);
  try {
    runtime().fs.mkdir(absolute, false, args.mode);
  } catch (error) {
    throw restate(error, { absolute, shown: args.shown });
  }
  return undefined;
}

/** What makes MKDirp stop at once. */
const FATAL = new Set(["EACCES", "ENOSPC", "ENOTDIR", "EPERM"]);

/** A part of a path that is empty, `.` or `..`, at its start or after a slash. */
const PART_NOT_A_NAME = /\/\.{0,2}(?:\/|$)|^\.{1,2}(?:\/|$)/;

/** Returned by `makeAtOnce` when MKDirp's own steps must say what happens. */
const BY_STEPS = Symbol("by steps");

/**
 * `mkdir -p` on `shown` as one request of the filesystem, which makes the
 * missing directories itself, when that is sure to do what MKDirp does: every
 * part of `shown` is a plain name, so that MKDirp's steps (the text before
 * each last slash) are the directories the filesystem walks up through, and
 * the request is not refused. Returns what MKDirp returns then, the first
 * directory made as the caller spelled it; else `BY_STEPS`.
 *
 * MKDirp asks for each directory and goes by the refusal, and a refusal costs
 * an error here, ten times the request. Where the request is refused the
 * steps follow from what it left (nothing, or the directories the steps would
 * have made first), and name the error as Node does.
 */
function makeAtOnce(fs: FsBackend, shown: string, mode: number): string | undefined | symbol {
  if (shown === "" || PART_NOT_A_NAME.test(shown)) {
    return BY_STEPS;
  }
  const requested = toAbsolute(shown);
  // MKDirp stops at the first name of a relative path, so a working
  // directory that is gone is not made again: the request makes nothing at
  // or above it (its floor) and is refused there instead.
  const floor = requested === shown ? undefined : runtime().cwd;
  let first: string | undefined;
  try {
    first = fs.mkdir(requested, true, mode, floor);
  } catch {
    return BY_STEPS;
  }
  return first === undefined ? undefined : first.slice(requested.length - shown.length);
}

/**
 * `fs.mkdir` with `recursive` on `shown`. Returns the first directory made,
 * as the caller spelled it; throws naming `shown` (sync) or the failed step
 * (async), as Node does.
 */
function mkdirp(shown: string, mode: number, form: "sync" | "async"): string | undefined {
  const fs = runtime().fs;
  const made = makeAtOnce(fs, shown, mode);
  return typeof made === "symbol" ? mkdirpBySteps(fs, shown, mode, form) : made;
}

/** MKDirpSync or MKDirpAsync on `shown`, step by step. */
export function mkdirpBySteps(
  fs: FsBackend,
  shown: string,
  mode: number,
  form: "sync" | "async",
): string | undefined {
  const pending = [shown];
  let first: string | undefined;
  /** A backend error restated with the path Node names and `mkdir`. */
  const restated = (error: unknown, absolute: string, step: string) =>
    restate(error, { absolute, shown: form === "sync" ? shown : step, syscall: "mkdir" });
  const failure = (code: ErrnoCode, step: string) =>
    createSystemError(code, "mkdir", form === "sync" ? shown : step);
  while (pending.length > 0) {
    const step = pending.pop()!;
    const absolute = toAbsolute(step);
    let error: unknown;
    try {
      fs.mkdir(absolute, false, mode);
      first ??= step;
      continue;
    } catch (caught) {
      error = caught;
    }
    let code = errnoCodeOf(error);
    if (FATAL.has(code as string)) {
      throw restated(error, absolute, step);
    }
    if (code === "ENOENT") {
      const slash = step.lastIndexOf("/");
      if (slash !== -1) {
        pending.push(step, step.slice(0, slash));
        continue;
      }
      if (pending.length > 0) {
        // Node would try this step forever (its working directory is gone).
        throw restated(error, absolute, step);
      }
      code = "EEXIST";
    }
    // Anything else: what is there decides.
    let stat: StatData | null = null;
    let statError: unknown = null;
    try {
      stat = fs.stat(absolute, true);
    } catch (caught) {
      statError = caught;
    }
    const directory = stat !== null && (stat.mode & S_IFMT) === S_IFDIR;
    const more = code === "EEXIST" && pending.length > 0;
    if (form === "sync") {
      // MKDirpSync: a directory lets the steps go on; anything else ends them.
      if (stat !== null && !directory) {
        throw failure(more ? "ENOTDIR" : "EEXIST", step);
      }
      if (statError !== null) {
        throw restated(statError, absolute, step);
      }
      continue;
    }
    // MKDirpAsync: a directory with more to make below it lets the steps go
    // on; one at the end is success.
    if (more) {
      if (directory) {
        continue;
      }
      throw failure("ENOTDIR", step);
    }
    if (statError !== null) {
      throw restated(statError, absolute, step);
    }
    if (!directory) {
      throw failure("EEXIST", step);
    }
    return first;
  }
  return first;
}
