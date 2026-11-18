// The errors `fs` raises itself, beyond the backend's system errors: Node's
// `SystemError` class (ERR_FS_EISDIR, ERR_FS_CP_*), the directory-handle and
// file-size errors, `ERR_INVALID_RETURN_VALUE`, and the error for a member
// webnode does not implement. Also rewriting a backend error so it names the
// path the caller gave and the syscall Node reports.
import { errnoOf, systemErrorMessage, type ErrnoCode, type SystemError } from "../../../errors";
import { determineSpecificType, makeNodeError, type NodeError } from "../internalErrors";

/** What a Node `SystemError` (lib/internal/errors.js) carries in `info`. */
export interface SystemErrorContext {
  code: ErrnoCode;
  message: string;
  syscall: string;
  path?: string;
  dest?: string;
}

const SYSTEM_ERROR_PREFIXES: Readonly<Record<string, string>> = {
  ERR_FS_EISDIR: "Path is a directory",
  ERR_FS_CP_DIR_TO_NON_DIR: "Cannot overwrite non-directory with directory",
  ERR_FS_CP_EEXIST: "Target already exists",
  ERR_FS_CP_EINVAL: "Invalid src or dest",
  ERR_FS_CP_NON_DIR_TO_DIR: "Cannot overwrite directory with non-directory",
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: "Cannot overwrite symlink in subdirectory of self",
};

/** An error of Node's `SystemError` class: `Prefix: syscall returned CODE (message) path`. */
export function nodeSystemError(key: string, context: SystemErrorContext): NodeError {
  let message = `${SYSTEM_ERROR_PREFIXES[key]}: ${context.syscall} returned ${context.code} (${context.message})`;
  if (context.path !== undefined) {
    message += ` ${context.path}`;
  }
  if (context.dest !== undefined) {
    message += ` => ${context.dest}`;
  }
  const error = makeNodeError(key, message);
  error.name = "SystemError";
  const fields = error as NodeError & Record<string, unknown>;
  fields.info = { ...context, errno: errnoOf(context.code) };
  fields.errno = errnoOf(context.code);
  fields.syscall = context.syscall;
  if (context.path !== undefined) {
    fields.path = context.path;
  }
  if (context.dest !== undefined) {
    fields.dest = context.dest;
  }
  return error;
}

/** A plain `Error` with `code`, the shape of the errors Node's C++ layer throws. */
export function codedError(code: string, message: string): NodeError {
  return makeNodeError(code, message);
}

/** `ERR_DIR_CLOSED`. */
export function dirClosed(): NodeError {
  return makeNodeError("ERR_DIR_CLOSED", "Directory handle was closed");
}

/** `ERR_FS_FILE_TOO_LARGE` (a `RangeError`). */
export function fileTooLarge(size: number): NodeError<RangeError> {
  return makeNodeError<RangeError>(
    "ERR_FS_FILE_TOO_LARGE",
    `File size (${size}) is greater than 2 GiB`,
    RangeError,
  );
}

/** `ERR_INVALID_RETURN_VALUE` (a `TypeError`). */
export function invalidReturnValue(
  input: string,
  name: string,
  value: unknown,
): NodeError<TypeError> {
  return makeNodeError<TypeError>(
    "ERR_INVALID_RETURN_VALUE",
    `Expected ${input} to be returned from the "${name}" function but got ${determineSpecificType(value)}.`,
    TypeError,
  );
}

/** `ERR_INCOMPATIBLE_OPTION_PAIR` (a `TypeError`). */
export function incompatibleOptionPair(a: string, b: string): NodeError<TypeError> {
  return makeNodeError<TypeError>(
    "ERR_INCOMPATIBLE_OPTION_PAIR",
    `Option "${a}" cannot be used in combination with option "${b}"`,
    TypeError,
  );
}

/** `ERR_INVALID_STATE` (an `Error`). */
export function invalidState(message: string): NodeError {
  return makeNodeError("ERR_INVALID_STATE", `Invalid state: ${message}`);
}

/** The error for an `fs` member webnode does not provide; it names the member. */
export function notImplemented(name: string): NodeError {
  return makeNodeError("ERR_METHOD_NOT_IMPLEMENTED", `The ${name} method is not implemented`);
}

/** The `EBADF` a FileHandle method raises once the handle is closed. */
export function fileClosed(syscall: string): NodeError {
  const error = new Error("file closed") as NodeError & { syscall?: string };
  error.code = "EBADF";
  error.syscall = syscall;
  return error;
}

/** The codes of the argument errors Node throws synchronously, even from callback-style functions. */
const ARGUMENT_ERROR_CODES = new Set([
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_OUT_OF_RANGE",
  "ERR_MISSING_ARGS",
  "ERR_INCOMPATIBLE_OPTION_PAIR",
  "ERR_INVALID_URL_SCHEME",
  "ERR_INVALID_FILE_URL_PATH",
  "ERR_INVALID_FILE_URL_HOST",
  "ERR_FS_INVALID_SYMLINK_TYPE",
  "ERR_METHOD_NOT_IMPLEMENTED",
]);

/** True for an argument-validation error: callback-style functions throw these instead of passing them on. */
export function isArgumentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ARGUMENT_ERROR_CODES.has((error as unknown as { code: string }).code)
  );
}

function isSystemError(error: unknown): error is SystemError {
  return (
    error instanceof Error &&
    typeof (error as Partial<SystemError>).syscall === "string" &&
    typeof (error as Partial<SystemError>).errno === "number"
  );
}

/** How to restate a backend error: the caller's spelling of each path, and Node's syscall name. */
export interface ErrorRewrite {
  /** The absolute path the backend saw, and the caller's spelling of it. */
  absolute?: string;
  shown?: string;
  absoluteDest?: string;
  shownDest?: string;
  syscall?: string;
  /** Drops the path from the error, as Node does for `opendirSync`. */
  dropPath?: boolean;
}

/** What Node's C++ `rmSync` says for the codes it names (node_file.cc, RmSync). */
const RM_SYNC_TEXT: Readonly<Record<string, string>> = {
  EPERM: "Operation not permitted",
  ENOTEMPTY: "Directory not empty",
  ENOTDIR: "Not a directory",
  EACCES: "Permission denied",
};

/**
 * A removal error as `rmSync` throws it: `EACCES, Permission denied: 'x'`,
 * naming the path it was given, with a positive `errno` and syscall `rm`.
 * Codes it does not name, and other errors, are returned unchanged.
 */
export function rmSyncError(error: unknown, shown: string): unknown {
  if (!isSystemError(error)) {
    return error;
  }
  const text = RM_SYNC_TEXT[error.code];
  if (text === undefined) {
    return error;
  }
  error.message = `${error.code}, ${text}: '${shown}'`;
  error.errno = Math.abs(error.errno);
  error.syscall = "rm";
  error.path = shown;
  delete error.dest;
  if (typeof error.stack === "string") {
    const newline = error.stack.indexOf("\n");
    error.stack = `Error: ${error.message}${newline === -1 ? "" : error.stack.slice(newline)}`;
  }
  return error;
}

/**
 * Restates the backend's system error `error` the way Node reports it for the
 * public function, rebuilding the message when anything changed. Any other
 * error is returned unchanged.
 */
export function restate(error: unknown, rewrite: ErrorRewrite): unknown {
  if (!isSystemError(error)) {
    return error;
  }
  let changed = false;
  if (rewrite.dropPath === true && error.path !== undefined) {
    delete error.path;
    changed = true;
  } else if (
    rewrite.shown !== undefined &&
    error.path === rewrite.absolute &&
    rewrite.shown !== rewrite.absolute
  ) {
    error.path = rewrite.shown;
    changed = true;
  }
  if (
    rewrite.shownDest !== undefined &&
    error.dest === rewrite.absoluteDest &&
    rewrite.shownDest !== rewrite.absoluteDest
  ) {
    error.dest = rewrite.shownDest;
    changed = true;
  }
  if (rewrite.syscall !== undefined && error.syscall !== rewrite.syscall) {
    error.syscall = rewrite.syscall;
    changed = true;
  }
  if (changed) {
    error.message = systemErrorMessage(error);
    if (typeof error.stack === "string") {
      const newline = error.stack.indexOf("\n");
      error.stack = `Error: ${error.message}${newline === -1 ? "" : error.stack.slice(newline)}`;
    }
  }
  return error;
}
