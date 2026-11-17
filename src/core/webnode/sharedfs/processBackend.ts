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

/** `path` (absolute) with `//`, `.` and `..` resolved by its text alone. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

/**
 * The normalized path when `path` is one the kernel answers itself (`/dev` and
 * what is under it, however it is spelled), else null. Most paths cannot be:
 * they never mention `/dev`, and that is all this costs them.
 */
export function kernelPathOf(path: string): string | null {
  if (!path.includes("/dev")) {
    return null;
  }
  const normalized = normalizePath(path);
  return normalized === "/dev" || normalized.startsWith("/dev/") ? normalized : null;
}

/**
 * Whether the filesystem refused `error` as a loop of links. The kernel keeps
 * each of its device paths as a link to itself (kernel.ts), so a path that
 * reaches a device through a link, or through a directory linked to /dev,
 * fails this way instead of creating or reading a file there. The kernel then
 * works out where the path leads.
 */
function isLinkLoop(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ELOOP";
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

  /**
   * `local` for ordinary paths, `viaKernel` when `path` (or `other`) is a
   * kernel path, and `viaKernel` again when the filesystem finds a loop of
   * links on the way.
   */
  const route = <T>(
    path: string,
    viaKernel: () => T,
    local: () => T,
    other: string | null = null,
  ): T => {
    if (kernelPathOf(path) !== null || (other !== null && kernelPathOf(other) !== null)) {
      return viaKernel();
    }
    try {
      return local();
    } catch (error) {
      if (isLinkLoop(error)) {
        return viaKernel();
      }
      throw error;
    }
  };

  return {
    ...kernel,
    stat: (path, follow) =>
      route(
        path,
        () => kernel.stat(path, follow),
        () => fs.stat(path, follow),
      ),
    exists: (path) =>
      route(
        path,
        () => kernel.exists(path),
        // Missing, or a link (perhaps to a device): only the second asks the
        // kernel. A miss is the common answer, so it must stay cheap.
        () => fs.exists(path) || (fs.isBrokenLink(path) && kernel.exists(path)),
      ),
    readdir: (path) =>
      route(
        path,
        () => kernel.readdir(path),
        () => fs.readdir(path),
      ),
    readlink: (path) =>
      route(
        path,
        () => kernel.readlink(path),
        () => fs.readlink(path),
      ),
    realpath: (path) =>
      route(
        path,
        () => kernel.realpath(path),
        () => fs.realpath(path),
      ),
    access: (path, mode) =>
      route(
        path,
        () => kernel.access(path, mode),
        () => fs.access(path, mode),
      ),
    readFile: (path) =>
      route(
        path,
        () => kernel.readFile(path),
        () => fs.readFile(path),
      ),
    mkdir: (path, recursive, mode) =>
      route(
        path,
        () => kernel.mkdir(path, recursive, mode),
        () => changing(() => fs.mkdir(path, recursive, mode)),
      ),
    rmdir: (path) =>
      route(
        path,
        () => kernel.rmdir(path),
        () => changing(() => fs.rmdir(path)),
      ),
    unlink: (path) =>
      route(
        path,
        () => kernel.unlink(path),
        () => changing(() => fs.unlink(path)),
      ),
    rm: (path, recursive, force) =>
      route(
        path,
        () => kernel.rm(path, recursive, force),
        () => changing(() => fs.rm(path, recursive, force)),
      ),
    rename: (from, to) =>
      route(
        from,
        () => kernel.rename(from, to),
        () => changing(() => fs.rename(from, to)),
        to,
      ),
    link: (existingPath, newPath) =>
      route(
        existingPath,
        () => kernel.link(existingPath, newPath),
        () => changing(() => fs.link(existingPath, newPath)),
        newPath,
      ),
    symlink: (target, path) =>
      route(
        path,
        () => kernel.symlink(target, path),
        () => changing(() => fs.symlink(target, path)),
      ),
    chmod: (path, mode, follow) =>
      route(
        path,
        () => kernel.chmod(path, mode, follow),
        () => changing(() => fs.chmod(path, mode, follow)),
      ),
    utimes: (path, atimeMs, mtimeMs, follow) =>
      route(
        path,
        () => kernel.utimes(path, atimeMs, mtimeMs, follow),
        () => changing(() => fs.utimes(path, atimeMs, mtimeMs, follow)),
      ),
    truncate: (path, length) =>
      route(
        path,
        () => kernel.truncate(path, length),
        () => changing(() => fs.truncate(path, length)),
      ),
    copyFile: (source, destination, mode) =>
      route(
        source,
        () => kernel.copyFile(source, destination, mode),
        () => changing(() => fs.copyFile(source, destination, mode)),
        destination,
      ),
    mkdtemp: (prefix) =>
      route(
        prefix,
        () => kernel.mkdtemp(prefix),
        () => changing(() => fs.mkdtemp(prefix)),
      ),
    writeFile: (path, data, flags, mode) =>
      route(
        path,
        () => kernel.writeFile(path, data, flags, mode),
        () => changing(() => fs.writeFile(path, data, flags, mode)),
      ),
  };
}
