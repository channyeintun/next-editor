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
 */
export interface VfsApi {
  stat(path: string, followSymlinks: boolean): StatData;
  exists(path: string): boolean;
  /** Entries in name order. */
  readdir(path: string): DirEntry[];
  /** Returns the first directory it created when `recursive`, else undefined. */
  mkdir(path: string, recursive: boolean, mode: number): string | undefined;
  rmdir(path: string): void;
  unlink(path: string): void;
  rm(path: string, recursive: boolean, force: boolean): void;
  rename(from: string, to: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  realpath(path: string): string;
  chmod(path: string, mode: number, followSymlinks: boolean): void;
  utimes(path: string, atimeMs: number, mtimeMs: number, followSymlinks: boolean): void;
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
