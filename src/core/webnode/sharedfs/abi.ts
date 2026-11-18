// The contract with the Rust filesystem (`crate/src/abi.rs` states the same
// numbers): where the shared block lives, what a call leaves in it, and the
// codes for errors and system calls. Change both files together.
import type { ErrnoCode } from "../errors";

/** Bytes of the argument area: both paths of a call, one after the other. */
export const ARGS_CAPACITY = 65536;
/** Workers that can call into the filesystem directly at one time. */
export const PROCESS_SLOTS = 1024;

/** Byte offsets into the shared block, from `fs_base()`. */
export const OFFSET = {
  /** The mutex word. Only JavaScript reads or writes it (lock.ts). */
  lock: 0,
  /** Non-zero once a call trapped inside the filesystem: its state may be torn. */
  poisoned: 4,
  /** How many watches are registered. Events are logged only while non-zero. */
  watching: 8,
  /** Bytes in the pending event log. */
  eventsLength: 12,
  /**
   * One word for each process slot: 0 when free; the token of the worker that
   * may enter through it while it is outside a call; the token negated while
   * it is inside one; `SLOT_RETIRING` once the kernel asked it to stop.
   */
  slots: 16,
  errno: 4112,
  syscall: 4116,
  /** Which arguments the error names: `PATH_NONE`, `PATH_FIRST` or `PATH_BOTH`. */
  pathMode: 4120,
  /** Where the call's bytes are (file data, a listing, a path, the event log). */
  ptr: 4124,
  /** How many bytes are at `ptr`. */
  len: 4128,
  /** A second number, when a call has one. */
  aux: 4132,
  /** Non-zero once the event log was full and events were dropped. */
  eventsDropped: 4136,
  /**
   * Non-zero when the call is the kernel's privileged one, which the
   * permission bits do not apply to. The caller sets it before every call,
   * under the lock.
   */
  privileged: 4140,
  /**
   * The file mode creation mask of the caller: the permission bits taken off
   * the mode of what the call creates. The caller sets it before every call,
   * under the lock.
   */
  umask: 4144,
  /** A `stat` record: 14 float64 values, in `StatData`'s field order. */
  stat: 4152,
  /** The call's path arguments: the first at 0, the second right after it. */
  args: 4264,
} as const;

/** Error codes by number; index 0 is "no error". */
export const ERRNO_CODES: readonly (ErrnoCode | null)[] = [
  null,
  "ENOENT",
  "EINVAL",
  "ENOTDIR",
  "ELOOP",
  "EEXIST",
  "EISDIR",
  "EBUSY",
  "ENOTEMPTY",
  "EPERM",
  "ENOTSUP",
  "EACCES",
  "EFBIG",
  "EBADF",
  "ENOSPC",
  "ENAMETOOLONG",
  "EIO",
];

/** System call names by number, as Node spells them in an error. */
export const SYSCALL_NAMES: readonly (string | null)[] = [
  null,
  "open",
  "stat",
  "lstat",
  "scandir",
  "mkdir",
  "rmdir",
  "unlink",
  "rm",
  "rename",
  "link",
  "symlink",
  "readlink",
  "realpath",
  "chmod",
  "utime",
  "ftruncate",
  "copyfile",
  "access",
  "mkdtemp",
  "read",
  "write",
  "fstat",
  "fchmod",
  "futime",
  "close",
  "watch",
  "chown",
];

/** A slot whose worker is inside a call that the kernel retires when the call ends. */
export const SLOT_RETIRING = -0x80000000;

/**
 * `fs_utimes`'s flags: follow a final link; set the access time, or the
 * modification time, to now rather than to the number given (`VfsApi.utimes`
 * with null).
 */
export const UTIME_FOLLOW = 1;
export const UTIME_ATIME_NOW = 2;
export const UTIME_MTIME_NOW = 4;

export const PATH_NONE = 0;
export const PATH_FIRST = 1;
export const PATH_BOTH = 2;

/**
 * What `fs_exists` answers: nothing at the path, something, or a symbolic
 * link that leads nowhere or into a loop.
 */
export const ABSENT = 0;
export const PRESENT = 1;
export const BROKEN_LINK = 2;
export type Presence = typeof ABSENT | typeof PRESENT | typeof BROKEN_LINK;

/** Entry kinds in a listing, by number. */
export const ENTRY_KINDS = ["file", "dir", "symlink"] as const;

/** Event types in the event log, by number. */
export const EVENT_TYPES = ["rename", "change"] as const;
