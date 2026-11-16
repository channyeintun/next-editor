// `fs.constants`: Node 22's table on Linux x64, in the order Node lists it.
// The open flags and file type bits come from the filesystem's own vocabulary
// (kernel/vfs/types.ts), so the numbers `fs` passes down are the ones it reads.
import {
  COPYFILE_EXCL,
  F_OK,
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  O_DSYNC,
  O_EXCL,
  O_NOCTTY,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_RDWR,
  O_SYNC,
  O_TRUNC,
  O_WRONLY,
  R_OK,
  S_IFBLK,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  S_IFSOCK,
  W_OK,
  X_OK,
} from "../../../kernel/vfs/types";

/** `fs.constants.COPYFILE_FICLONE`: try a copy-on-write clone. */
export const COPYFILE_FICLONE = 2;
/** `fs.constants.COPYFILE_FICLONE_FORCE`: fail unless a copy-on-write clone is possible. */
export const COPYFILE_FICLONE_FORCE = 4;

/** `readdir` entry types, as libuv numbers them (the `Dirent` type field). */
export const UV_DIRENT_UNKNOWN = 0;
export const UV_DIRENT_FILE = 1;
export const UV_DIRENT_DIR = 2;
export const UV_DIRENT_LINK = 3;
export const UV_DIRENT_FIFO = 4;
export const UV_DIRENT_SOCKET = 5;
export const UV_DIRENT_CHAR = 6;
export const UV_DIRENT_BLOCK = 7;

/** The `fs.constants` object. */
export const constants = Object.freeze({
  UV_FS_SYMLINK_DIR: 1,
  UV_FS_SYMLINK_JUNCTION: 2,
  O_RDONLY,
  O_WRONLY,
  O_RDWR,
  UV_DIRENT_UNKNOWN,
  UV_DIRENT_FILE,
  UV_DIRENT_DIR,
  UV_DIRENT_LINK,
  UV_DIRENT_FIFO,
  UV_DIRENT_SOCKET,
  UV_DIRENT_CHAR,
  UV_DIRENT_BLOCK,
  EXTENSIONLESS_FORMAT_JAVASCRIPT: 0,
  EXTENSIONLESS_FORMAT_WASM: 1,
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFCHR,
  S_IFBLK,
  S_IFIFO,
  S_IFLNK,
  S_IFSOCK,
  O_CREAT,
  O_EXCL,
  UV_FS_O_FILEMAP: 0,
  O_NOCTTY,
  O_TRUNC,
  O_APPEND,
  O_DIRECTORY,
  O_NOATIME: 0o1000000,
  O_NOFOLLOW,
  O_SYNC,
  O_DSYNC,
  O_DIRECT: 0o40000,
  O_NONBLOCK,
  S_IRWXU: 0o700,
  S_IRUSR: 0o400,
  S_IWUSR: 0o200,
  S_IXUSR: 0o100,
  S_IRWXG: 0o70,
  S_IRGRP: 0o40,
  S_IWGRP: 0o20,
  S_IXGRP: 0o10,
  S_IRWXO: 0o7,
  S_IROTH: 0o4,
  S_IWOTH: 0o2,
  S_IXOTH: 0o1,
  F_OK,
  R_OK,
  W_OK,
  X_OK,
  UV_FS_COPYFILE_EXCL: COPYFILE_EXCL,
  COPYFILE_EXCL,
  UV_FS_COPYFILE_FICLONE: COPYFILE_FICLONE,
  COPYFILE_FICLONE,
  UV_FS_COPYFILE_FICLONE_FORCE: COPYFILE_FICLONE_FORCE,
  COPYFILE_FICLONE_FORCE,
});
