// What chdir(2) checks before a process moves to another working directory,
// for `process.chdir` and the shell's `cd`: the path names a directory, every
// directory on the way to it may be searched, and so may the directory itself.
import { createSystemError, toSystemErrorRecord, type ErrnoCode } from "../../../errors";
import { S_IFDIR, S_IFMT, X_OK } from "../../../kernel/vfs/types";
import { runtime } from "../../runtime";

/**
 * Checks that the process may change into `target`, the absolute path of
 * `directory` as the caller gave it. Throws Node's error for a failed
 * `process.chdir`: syscall `chdir`, the working directory as `path` and
 * `directory` as `dest`, as in `EACCES: permission denied, chdir '/w' -> 'd'`.
 */
export function checkChdir(directory: string, target: string): void {
  const fs = runtime().fs;
  let code: ErrnoCode | null = null;
  try {
    if ((fs.stat(target, true).mode & S_IFMT) !== S_IFDIR) {
      code = "ENOTDIR";
    } else {
      fs.access(target, X_OK);
    }
  } catch (error) {
    const record = toSystemErrorRecord(error);
    if (record === null) {
      throw error;
    }
    code = record.code;
  }
  if (code !== null) {
    throw createSystemError(code, "chdir", runtime().cwd, directory);
  }
}
