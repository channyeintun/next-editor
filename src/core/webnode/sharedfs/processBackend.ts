// A process's own way into the shared filesystem. The path operations become
// calls into the module on the shared memory; everything that belongs to the
// kernel stays a call to the kernel: file descriptors (it owns them all),
// watching (it delivers the events) and the device paths under /dev.
import type { FsBackend } from "../process/runtime";
import { SharedFs } from "./sharedFs";

/** What the kernel gives a worker it admitted to the shared filesystem (boot.ts). */
export interface SharedFsAdmission {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  slot: number;
  token: number;
}

/** Whether `path` is one the kernel answers itself, whatever the filesystem holds there. */
function isKernelPath(path: string): boolean {
  return path === "/dev" || path.startsWith("/dev/");
}

/**
 * `kernel` with its path operations answered by the shared filesystem. A call
 * that changes the tree while something watches it may leave events in the
 * shared log; `notifyChanged` then tells the kernel to deliver them, once for a
 * whole burst. Returns `kernel` itself when this worker cannot join (the module
 * fails to instantiate), so the process still runs.
 */
export function withDirectPaths(
  kernel: FsBackend,
  admission: SharedFsAdmission,
  notifyChanged: () => void,
): FsBackend {
  let fs: SharedFs;
  try {
    fs = new SharedFs({
      module: admission.module,
      memory: admission.memory,
      now: Date.now,
      entry: { slot: admission.slot, token: admission.token },
      deliversEvents: false,
    });
  } catch {
    return kernel;
  }

  /** Runs a call that may change the tree, then reports events it left for the kernel. */
  const changing = <T>(run: () => T): T => {
    try {
      return run();
    } finally {
      if (fs.takeEventsPending()) {
        notifyChanged();
      }
    }
  };

  return {
    ...kernel,
    stat: (path, follow) =>
      isKernelPath(path) ? kernel.stat(path, follow) : fs.stat(path, follow),
    exists: (path) => (isKernelPath(path) ? kernel.exists(path) : fs.exists(path)),
    readdir: (path) => (isKernelPath(path) ? kernel.readdir(path) : fs.readdir(path)),
    readlink: (path) => (isKernelPath(path) ? kernel.readlink(path) : fs.readlink(path)),
    realpath: (path) => (isKernelPath(path) ? kernel.realpath(path) : fs.realpath(path)),
    access: (path, mode) =>
      isKernelPath(path) ? kernel.access(path, mode) : fs.access(path, mode),
    readFile: (path) => (isKernelPath(path) ? kernel.readFile(path) : fs.readFile(path)),
    mkdir: (path, recursive, mode) =>
      isKernelPath(path)
        ? kernel.mkdir(path, recursive, mode)
        : changing(() => fs.mkdir(path, recursive, mode)),
    rmdir: (path) => (isKernelPath(path) ? kernel.rmdir(path) : changing(() => fs.rmdir(path))),
    unlink: (path) => (isKernelPath(path) ? kernel.unlink(path) : changing(() => fs.unlink(path))),
    rm: (path, recursive, force) =>
      isKernelPath(path)
        ? kernel.rm(path, recursive, force)
        : changing(() => fs.rm(path, recursive, force)),
    rename: (from, to) =>
      isKernelPath(from) || isKernelPath(to)
        ? kernel.rename(from, to)
        : changing(() => fs.rename(from, to)),
    link: (existingPath, newPath) =>
      isKernelPath(existingPath) || isKernelPath(newPath)
        ? kernel.link(existingPath, newPath)
        : changing(() => fs.link(existingPath, newPath)),
    symlink: (target, path) =>
      isKernelPath(path) ? kernel.symlink(target, path) : changing(() => fs.symlink(target, path)),
    chmod: (path, mode, follow) =>
      isKernelPath(path)
        ? kernel.chmod(path, mode, follow)
        : changing(() => fs.chmod(path, mode, follow)),
    utimes: (path, atimeMs, mtimeMs, follow) =>
      isKernelPath(path)
        ? kernel.utimes(path, atimeMs, mtimeMs, follow)
        : changing(() => fs.utimes(path, atimeMs, mtimeMs, follow)),
    truncate: (path, length) =>
      isKernelPath(path)
        ? kernel.truncate(path, length)
        : changing(() => fs.truncate(path, length)),
    copyFile: (source, destination, mode) =>
      isKernelPath(source) || isKernelPath(destination)
        ? kernel.copyFile(source, destination, mode)
        : changing(() => fs.copyFile(source, destination, mode)),
    mkdtemp: (prefix) =>
      isKernelPath(prefix) ? kernel.mkdtemp(prefix) : changing(() => fs.mkdtemp(prefix)),
    writeFile: (path, data, flags, mode) =>
      isKernelPath(path)
        ? kernel.writeFile(path, data, flags, mode)
        : changing(() => fs.writeFile(path, data, flags, mode)),
  };
}
