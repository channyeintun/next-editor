// The unchecked view of a filesystem that checks permissions (`PermissionedVfs`
// in types.ts): the same calls, each made with the checks turned off.
import type { VfsApi } from "./types";

/**
 * `fs` with every call made through `unchecked`: the `privileged` view of a
 * filesystem whose checks `unchecked` turns off for the length of one call.
 */
export function privilegedView(fs: VfsApi, unchecked: <T>(run: () => T) => T): VfsApi {
  return {
    stat: (path, follow) => unchecked(() => fs.stat(path, follow)),
    exists: (path) => unchecked(() => fs.exists(path)),
    readdir: (path) => unchecked(() => fs.readdir(path)),
    mkdir: (path, recursive, mode, floor) =>
      unchecked(() => fs.mkdir(path, recursive, mode, floor)),
    rmdir: (path) => unchecked(() => fs.rmdir(path)),
    unlink: (path) => unchecked(() => fs.unlink(path)),
    rm: (path, recursive, force) => unchecked(() => fs.rm(path, recursive, force)),
    rename: (from, to) => unchecked(() => fs.rename(from, to)),
    link: (existing, path) => unchecked(() => fs.link(existing, path)),
    symlink: (target, path) => unchecked(() => fs.symlink(target, path)),
    readlink: (path) => unchecked(() => fs.readlink(path)),
    realpath: (path) => unchecked(() => fs.realpath(path)),
    chmod: (path, mode, follow) => unchecked(() => fs.chmod(path, mode, follow)),
    utimes: (path, atimeMs, mtimeMs, follow) =>
      unchecked(() => fs.utimes(path, atimeMs, mtimeMs, follow)),
    giveToRoot: (path) => unchecked(() => fs.giveToRoot(path)),
    truncate: (path, length) => unchecked(() => fs.truncate(path, length)),
    copyFile: (source, destination, mode) =>
      unchecked(() => fs.copyFile(source, destination, mode)),
    access: (path, mode) => unchecked(() => fs.access(path, mode)),
    mkdtemp: (prefix) => unchecked(() => fs.mkdtemp(prefix)),
    readFile: (path) => unchecked(() => fs.readFile(path)),
    writeFile: (path, data, flags, mode) => unchecked(() => fs.writeFile(path, data, flags, mode)),
    open: (path, flags, mode) => unchecked(() => fs.open(path, flags, mode)),
    watch: (path, recursive, listener) => unchecked(() => fs.watch(path, recursive, listener)),
  };
}
