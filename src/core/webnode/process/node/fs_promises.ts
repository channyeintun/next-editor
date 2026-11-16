// The `fs/promises` builtin: the same object as `require("fs").promises`
// (built in fs/promises.ts), re-exported by name for ES module imports.
import { promises } from "./fs/promises";

export { FileHandle } from "./fs/promises";

export const {
  access,
  appendFile,
  chmod,
  chown,
  constants,
  copyFile,
  cp,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
} = promises;

export default promises;
