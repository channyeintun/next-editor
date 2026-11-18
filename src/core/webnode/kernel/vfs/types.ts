// The filesystem's vocabulary: file types and open flags (Linux values, the ones
// `fs.constants` reports), the stat record, and the two interfaces the rest of
// the runtime uses to reach the filesystem — `VfsApi` for paths and `OpenFile`
// for an open file.

export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFBLK = 0o060000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_NOCTTY = 0o400;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;
export const O_NONBLOCK = 0o4000;
export const O_DSYNC = 0o10000;
export const O_DIRECTORY = 0o200000;
export const O_NOFOLLOW = 0o400000;
export const O_SYNC = 0o4010000;

export const F_OK = 0;
export const X_OK = 1;
export const W_OK = 2;
export const R_OK = 4;

/**
 * The owner's permission bits. A file belongs to the one user every process
 * runs as (uid and gid 1) or, when the kernel gave it so (`giveToRoot`), to
 * root (uid and gid 0). For the user's own files these are the bits that
 * decide, as on Linux for a user who is not root: read, write, and execute
 * (search, for a directory). For root's, the others' bits decide
 * (`callerBits`).
 */
export const OWNER_R = 0o400;
export const OWNER_W = 0o200;
export const OWNER_X = 0o100;

/** The user and group of a file root owns. */
export const ROOT_ID = 0;

/**
 * The permission bits that decide for the one user, in the owner's places
 * (`OWNER_*`): the owner's bits of `perm`, or for a file root owns the
 * others' bits, as Linux's `acl_permission_check` takes them for a user who
 * is neither the owner nor in the group.
 */
export function callerBits(perm: number, rootOwned: boolean): number {
  return rootOwned ? (perm & 0o7) << 6 : perm;
}

/** The owner bits `access(mode)` asks for (`R_OK`, `W_OK`, `X_OK`). */
export function accessBits(mode: number): number {
  return (
    ((mode & R_OK) !== 0 ? OWNER_R : 0) |
    ((mode & W_OK) !== 0 ? OWNER_W : 0) |
    ((mode & X_OK) !== 0 ? OWNER_X : 0)
  );
}

export const COPYFILE_EXCL = 1;

/** What `stat` reports. `mode` carries the file type bits (`S_IF*`) and the permission bits. */
export interface StatData {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export type DirEntryType = "file" | "dir" | "symlink";

export interface DirEntry {
  name: string;
  type: DirEntryType;
}

/**
 * One change to the tree. `rename` is an entry appearing or disappearing
 * (create, delete, either side of a rename); `change` is a write to a file's
 * contents or metadata. `path` is the absolute path of the entry.
 */
export interface VfsWatchEvent {
  eventType: "rename" | "change";
  path: string;
}

/**
 * A file opened with `VfsApi.open`. It stays readable and writable after its
 * path is unlinked or renamed, as on POSIX.
 */
export interface OpenFile {
  readonly flags: number;
  /**
   * Reads up to `length` bytes. `position` null reads at the file offset and
   * advances it; a number reads there and leaves the offset alone. An empty
   * array is end of file. The result is a copy.
   */
  read(length: number, position: number | null): Uint8Array;
  /**
   * Writes `data` and returns the byte count. `position` null writes at the
   * file offset and advances it. A file opened with `O_APPEND` always writes at
   * the end.
   */
  write(data: Uint8Array, position: number | null): number;
  stat(): StatData;
  truncate(length: number): void;
  chmod(mode: number): void;
  utimes(atimeMs: number, mtimeMs: number): void;
  close(): void;
}

/**
 * The filesystem, by path. Every path is absolute; the implementation
 * normalizes it (`//`, `.`, `..`) and resolves symbolic links. Every failure
 * throws a `SystemError` (errors.ts) with the `syscall` name Node uses for the
 * operation (`open`, `stat`, `lstat`, `scandir`, `mkdir`, `rmdir`, `unlink`,
 * `rm`, `rename`, `link`, `symlink`, `readlink`, `realpath`, `chmod`, `utime`,
 * `truncate`, `copyfile`, `access`, `mkdtemp`) and the path as the caller gave it.
 *
 * Permissions are those of the owner (`OWNER_*`), or the others' for a file
 * root owns (`callerBits`), checked as Linux checks them for a user who is
 * not root: search on each directory a path goes
 * through, read to read a file or list a directory, write to change a file,
 * write and search on a directory to add, remove or rename an entry in it. A
 * refusal is `EACCES`. An open file is checked when it is opened, not later.
 */
export interface VfsApi {
  stat(path: string, followSymlinks: boolean): StatData;
  exists(path: string): boolean;
  /** Entries in the order of their names, by code point (the order of their UTF-8 bytes). */
  readdir(path: string): DirEntry[];
  /**
   * Returns the first directory it created when `recursive`, else undefined.
   * `floor`, a directory `path` begins with (a relative path's working
   * directory and slash), is never made, nor anything above it: where a
   * recursive mkdir would have to, it fails with ENOENT instead and makes
   * nothing, as Node's `mkdir -p` of a relative path whose working
   * directory is gone does.
   */
  mkdir(path: string, recursive: boolean, mode: number, floor?: string): string | undefined;
  rmdir(path: string): void;
  unlink(path: string): void;
  /**
   * Removes a file or, when `recursive`, a tree; `force` passes over a path
   * that is not there (ENOENT, or ENOTDIR: a name below something that is no
   * directory). A tree the permissions refuse part of is not left
   * whole: entries go in the order `readdir` lists them, a directory's
   * contents before its own entry, up to the first refusal, and the call
   * fails with EACCES. A tree's contents are gone before its own entry is
   * asked of its directory, which may still refuse it.
   */
  rm(path: string, recursive: boolean, force: boolean): void;
  rename(from: string, to: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  realpath(path: string): string;
  /** Fails with EPERM on a file root owns, as chmod(2) does for a user who is not its owner. */
  chmod(path: string, mode: number, followSymlinks: boolean): void;
  /**
   * Sets the access and modification times; null for one sets it to now. As
   * utimensat(2) for a user who is not root: explicit times need the owner
   * (EPERM on a file root owns); both set to now (what `touch` asks) need the
   * owner or write permission (EACCES).
   */
  utimes(
    path: string,
    atimeMs: number | null,
    mtimeMs: number | null,
    followSymlinks: boolean,
  ): void;
  /**
   * Gives what `path` names (a final link itself) to root: stat reports uid
   * and gid 0 for it, the others' bits decide what the user may do with it
   * (`callerBits`), and chmod and utimes on it by path or by an open file
   * fail with EPERM. Only the `privileged` view may: a checked call fails
   * with EPERM (syscall `chown`), as chown(2) does for a user who is not root.
   */
  giveToRoot(path: string): void;
  truncate(path: string, length: number): void;
  /** `mode` is `COPYFILE_EXCL` or 0. */
  copyFile(source: string, destination: string, mode: number): void;
  /** `mode` is a mask of `F_OK`, `R_OK`, `W_OK`, `X_OK`. */
  access(path: string, mode: number): void;
  /** Creates a directory named `prefix` plus six random characters and returns its path. */
  mkdtemp(prefix: string): string;
  /** The whole file. The result is a copy. */
  readFile(path: string): Uint8Array;
  /** Writes the whole of `data`, opening the file with `flags` (`O_*`) and creating it with `mode`. */
  writeFile(path: string, data: Uint8Array, flags: number, mode: number): void;
  open(path: string, flags: number, mode: number): OpenFile;
  /**
   * Reports changes at `path` and, when it is a directory, to its entries — to
   * everything below it when `recursive`. Returns the function that stops it.
   */
  watch(path: string, recursive: boolean, listener: (event: VfsWatchEvent) => void): () => void;
}

/**
 * The filesystem as the kernel holds it: checked, as the user every process
 * runs as, with the same tree unchecked beside it.
 */
export interface PermissionedVfs extends VfsApi {
  /**
   * The same filesystem without permission checks, for the callers they do
   * not apply to: the page's own requests (the editor saves and syncs a
   * learner's files whatever their modes) and the kernel's setup. What it
   * opens is not checked later either. What it creates is masked by
   * `DEFAULT_UMASK` (umask.ts), whatever the mask of the caller around it.
   */
  readonly privileged: VfsApi;
  /**
   * Runs `create` for a caller whose file mode creation mask is `umask`
   * (its permission bits; umask(2)): a file or directory a call inside it
   * makes (`open` and `writeFile` with `O_CREAT`, `mkdir`, `mkdtemp`) gets
   * the permission bits of its mode less the mask's. Outside it the mask is
   * `DEFAULT_UMASK`. Nothing else is masked: a symbolic link is 0777, and
   * `copyFile` gives the copy the source's mode, as libuv's fchmod does.
   * Returns what `create` returns.
   */
  withUmask<T>(umask: number, create: () => T): T;
}
