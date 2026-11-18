// `fs.rm` and `fsPromises.rm` the way Node removes asynchronously
// (lib/internal/fs/rimraf.js), not as `rmSync` does: a file is unlinked; a
// directory is rmdir'd, and only when it is not empty are its entries removed,
// each the same way, before it is rmdir'd again. An entry that cannot be
// removed does not stop the others: what can go goes, the directories above
// it stay, and the first refusal is the error, naming its own system call
// and path. The filesystem's own `rm` stands in when it can only agree.
import { errnoCodeOf } from "../../../errors";
import type { FsBackend } from "../../runtime";
import { runtime } from "../../runtime";
import { toAbsolute } from "./args";
import { restate } from "./errors";

/** rmdir's answers that mean "not empty" (rimraf's `notEmptyErrorCodes`). */
const NOT_EMPTY = new Set(["ENOTEMPTY", "EEXIST", "EPERM"]);

/** A path as the backend takes it and as the caller spelled it. */
interface Entry {
  absolute: string;
  shown: string;
}

/** Runs `op`, restating its failure with the caller's spelling of `entry`. */
function at<T>(entry: Entry, op: () => T): T {
  try {
    return op();
  } catch (error) {
    throw restate(error, { absolute: entry.absolute, shown: entry.shown });
  }
}

/** One attempt of Node's asynchronous recursive removal of `shown`. */
export function rimrafOnce(shown: string): void {
  removeEntry(runtime().fs, { absolute: toAbsolute(shown), shown });
}

function removeEntry(fs: FsBackend, entry: Entry): void {
  let isDirectory = false;
  try {
    isDirectory = (fs.stat(entry.absolute, false).mode & 0o170000) === 0o040000;
  } catch (error) {
    if (errnoCodeOf(error) === "ENOENT") {
      return;
    }
  }
  if (isDirectory) {
    removeDirectory(fs, entry, null);
    return;
  }
  try {
    at(entry, () => fs.unlink(entry.absolute));
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code === "ENOENT") {
      return;
    }
    if (code === "EISDIR" || code === "EPERM") {
      removeDirectory(fs, entry, error);
      return;
    }
    throw error;
  }
}

function removeDirectory(fs: FsBackend, entry: Entry, original: unknown): void {
  try {
    at(entry, () => fs.rmdir(entry.absolute));
    return;
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code === "ENOTDIR" && original !== null) {
      throw original;
    }
    if (code === "ENOENT") {
      return;
    }
    if (!NOT_EMPTY.has(code ?? "")) {
      throw error;
    }
  }
  // The directory could be rmdir'd but for its entries. When the filesystem
  // removes the whole tree, rimraf would have too. When it refuses, it has
  // removed the entries that come before the refusal, which rimraf removes
  // as well; what is left is then removed one by one.
  try {
    fs.rm(entry.absolute, true, false);
    return;
  } catch (error) {
    if (errnoCodeOf(error) !== "EACCES") {
      throw restate(error, { absolute: entry.absolute, shown: entry.shown });
    }
  }
  const names = at(entry, () => fs.readdir(entry.absolute)).map((dirent) => dirent.name);
  let first: unknown = null;
  for (const name of names) {
    try {
      removeEntry(fs, {
        absolute: `${entry.absolute}/${name}`,
        shown: `${entry.shown}/${name}`,
      });
    } catch (error) {
      first ??= error;
    }
  }
  if (first !== null) {
    throw first;
  }
  at(entry, () => fs.rmdir(entry.absolute));
}
