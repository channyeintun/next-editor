// The errno table and the error every failed system call becomes. The kernel
// throws these, they cross to a process as a plain record, and the process
// rebuilds the same error, so `fs` and friends surface Node's `code`, `errno`,
// `syscall`, `path` and message unchanged.

/** Linux errno numbers and Node's descriptions, for the codes the runtime raises. */
const ERRNO = {
  EPERM: [1, "operation not permitted"],
  ENOENT: [2, "no such file or directory"],
  ESRCH: [3, "no such process"],
  EINTR: [4, "interrupted system call"],
  EIO: [5, "i/o error"],
  ENXIO: [6, "no such device or address"],
  E2BIG: [7, "argument list too long"],
  ENOEXEC: [8, "exec format error"],
  EBADF: [9, "bad file descriptor"],
  ECHILD: [10, "no child processes"],
  EAGAIN: [11, "resource temporarily unavailable"],
  ENOMEM: [12, "not enough memory"],
  EACCES: [13, "permission denied"],
  EFAULT: [14, "bad address in system call argument"],
  EBUSY: [16, "resource busy or locked"],
  EEXIST: [17, "file already exists"],
  EXDEV: [18, "cross-device link not permitted"],
  ENODEV: [19, "no such device"],
  ENOTDIR: [20, "not a directory"],
  EISDIR: [21, "illegal operation on a directory"],
  EINVAL: [22, "invalid argument"],
  ENFILE: [23, "file table overflow"],
  EMFILE: [24, "too many open files"],
  ENOTTY: [25, "inappropriate ioctl for device"],
  EFBIG: [27, "file too large"],
  ENOSPC: [28, "no space left on device"],
  ESPIPE: [29, "invalid seek"],
  EROFS: [30, "read-only file system"],
  EMLINK: [31, "too many links"],
  EPIPE: [32, "broken pipe"],
  ERANGE: [34, "result too large"],
  ENAMETOOLONG: [36, "name too long"],
  ENOSYS: [38, "function not implemented"],
  ENOTEMPTY: [39, "directory not empty"],
  ELOOP: [40, "too many symbolic links encountered"],
  ENOTSOCK: [88, "socket operation on non-socket"],
  ENOTSUP: [95, "operation not supported on socket"],
  EADDRINUSE: [98, "address already in use"],
  EADDRNOTAVAIL: [99, "address not available"],
  ENETUNREACH: [101, "network is unreachable"],
  ECONNABORTED: [103, "software caused connection abort"],
  ECONNRESET: [104, "connection reset by peer"],
  EISCONN: [106, "socket is already connected"],
  ENOTCONN: [107, "socket is not connected"],
  ETIMEDOUT: [110, "connection timed out"],
  ECONNREFUSED: [111, "connection refused"],
  EHOSTUNREACH: [113, "host is unreachable"],
  EALREADY: [114, "connection already in progress"],
  ECANCELED: [125, "operation canceled"],
} as const satisfies Record<string, readonly [number, string]>;

export type ErrnoCode = keyof typeof ERRNO;

/** The errno number for `code`, as a positive integer. */
export function errnoOf(code: ErrnoCode): number {
  return ERRNO[code][0];
}

/** libuv's text for `code` (`uv_strerror`): `permission denied` for EACCES. */
export function errnoDescription(code: ErrnoCode): string {
  return ERRNO[code][1];
}

/** `{ EPERM: 1, ... }`, for `os.constants.errno`. */
export function errnoTable(): Record<string, number> {
  return Object.fromEntries(Object.entries(ERRNO).map(([code, [number]]) => [code, number]));
}

/** The code for a negative errno, as `util.getSystemErrorName` reports it. */
export function errnoName(errno: number): string | undefined {
  const positive = Math.abs(errno);
  for (const [code, [number]] of Object.entries(ERRNO)) {
    if (number === positive) {
      return code;
    }
  }
  return undefined;
}

/** A failed system call, in the shape Node gives its `fs` and `net` errors. */
export interface SystemErrorRecord {
  code: ErrnoCode;
  syscall: string;
  path?: string;
  dest?: string;
  /** For socket errors: `address` and `port`, as Node reports them. */
  address?: string;
  port?: number;
}

/** An `Error` carrying Node's system-error fields. */
export interface SystemError extends Error {
  code: ErrnoCode;
  errno: number;
  syscall: string;
  path?: string;
  dest?: string;
  address?: string;
  port?: number;
}

/** `ENOENT: no such file or directory, open '/a'`, the message Node prints. */
export function systemErrorMessage(record: SystemErrorRecord): string {
  let message = `${record.code}: ${ERRNO[record.code][1]}, ${record.syscall}`;
  if (record.path !== undefined) {
    message += ` '${record.path}'`;
    if (record.dest !== undefined) {
      message += ` -> '${record.dest}'`;
    }
  } else if (record.address !== undefined) {
    message += ` ${record.address}${record.port === undefined ? "" : `:${record.port}`}`;
  }
  return message;
}

/** Builds the error for a failed system call. */
export function createSystemError(
  code: ErrnoCode,
  syscall: string,
  path?: string,
  dest?: string,
): SystemError {
  return systemErrorFromRecord({ code, syscall, path, dest });
}

/** Rebuilds a system error from the record that crossed a thread. */
export function systemErrorFromRecord(record: SystemErrorRecord): SystemError {
  const error = new Error(systemErrorMessage(record)) as SystemError;
  // In Node's order, which is what a program that prints the error sees.
  error.errno = -ERRNO[record.code][0];
  error.code = record.code;
  error.syscall = record.syscall;
  if (record.path !== undefined) {
    error.path = record.path;
  }
  if (record.dest !== undefined) {
    error.dest = record.dest;
  }
  if (record.address !== undefined) {
    error.address = record.address;
  }
  if (record.port !== undefined) {
    error.port = record.port;
  }
  return error;
}

/** The errno code of `error` (`"ENOENT"`) when it is a system error, else undefined. */
export function errnoCodeOf(error: unknown): ErrnoCode | undefined {
  return toSystemErrorRecord(error)?.code;
}

/** The record for `error` when it is a system error, else null. */
export function toSystemErrorRecord(error: unknown): SystemErrorRecord | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const candidate = error as Partial<SystemError>;
  if (
    typeof candidate.code !== "string" ||
    !Object.hasOwn(ERRNO, candidate.code) ||
    typeof candidate.syscall !== "string"
  ) {
    return null;
  }
  return {
    code: candidate.code,
    syscall: candidate.syscall,
    path: candidate.path,
    dest: candidate.dest,
    address: candidate.address,
    port: candidate.port,
  };
}
