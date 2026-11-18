// Where a path leads when it reaches the kernel's devices under /dev. The
// tree keeps each device as a link to itself (kernel.ts), so a path that goes
// through one fails there with ELOOP; this module then walks the path itself,
// part by part, as Linux resolves it: /dev/fd is a directory whose names are
// descriptor numbers, every other device is no directory, and the links of
// the tree on the way are followed.
import { kernelPathOf } from "../sharedfs/processBackend";
import { S_IFDIR, S_IFLNK, S_IFMT, type StatData } from "./vfs/types";

/** The devices the kernel provides, as names under /dev; `/dev/fd/N` too. */
export const DEVICE_NAMES = ["fd", "null", "stderr", "stdin", "stdout", "tty"];
const STDIO_DEVICES = ["/dev/stdin", "/dev/stdout", "/dev/stderr"];
/** The one device that is a directory: its names are the caller's descriptors. */
const FD_DIRECTORY = "/dev/fd";
/** Linux's limit on symbolic links followed while resolving one path. */
const MAX_LINKS = 40;

/** Whether `normalized` (no `.`, `..` or `//`) names one of the kernel's devices. */
export function isDevicePath(normalized: string): boolean {
  return (
    (normalized.startsWith("/dev/") && DEVICE_NAMES.includes(normalized.slice(5))) ||
    /^\/dev\/fd\/\d+$/.test(normalized)
  );
}

/**
 * The device `path` names by its spelling (`//dev/null`, `/dev/./null` …),
 * or null. A path with a `..` in it, or that asks for a directory (a last
 * `/` or `/.`) of a device that is none, is left to the walk
 * (`walkDevicePath`): through a device that is no directory (`/dev/fd/0/..`,
 * `/dev/null/`) it is ENOTDIR, which its spelling alone does not show.
 */
export function deviceOf(path: string): string | null {
  const normalized = kernelPathOf(path);
  if (normalized === null || !isDevicePath(normalized) || path.split("/").includes("..")) {
    return null;
  }
  return normalized === FD_DIRECTORY || !/\/\.?$/.test(path) ? normalized : null;
}

/** The descriptor a device stands for: /dev/stdin, /dev/stdout, /dev/stderr and /dev/fd/N. */
export function deviceFd(device: string): number | null {
  const stdio = STDIO_DEVICES.indexOf(device);
  if (stdio >= 0) {
    return stdio;
  }
  return device.startsWith(`${FD_DIRECTORY}/`) ? Number(device.slice(8)) : null;
}

/** What the walk asks of the tree: an entry's stat, its last link not followed, and a link's target. */
export interface DeviceTree {
  stat(path: string, follow: boolean): StatData;
  readlink(path: string): string;
}

/**
 * Where a path that went through a device leads: to a device; to a place in
 * the tree (`/dev/fd/..` is /dev), spelled with no device and no link on the
 * way, for the call to be made there; or to an error of the walk itself (a
 * name after a device that is no directory, a name in /dev/fd that is no
 * number).
 */
export type DeviceWalk = { device: string } | { tree: string } | { error: "ENOTDIR" | "ENOENT" };

/**
 * Walks absolute `path` through `tree` and the kernel's devices; the last
 * part's link is followed when `followLast` is. Null when no device is on
 * the way (or the walk itself finds a loop of the tree's links): the tree's
 * own answer then stands.
 */
export function walkDevicePath(
  tree: DeviceTree,
  path: string,
  followLast: boolean,
): DeviceWalk | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const parts = path.split("/").filter((part) => part !== "");
  // A trailing slash asks for a directory, and follows the last link.
  if (path.endsWith("/") && parts.length > 0) {
    parts.push(".");
  }
  /** Where the walk is: a directory of the tree with no link in its spelling, or a device. */
  let at = "/";
  let onDevice = false;
  let throughDevice = false;
  let links = 0;
  const rest = (from: string) => (parts.length === 0 ? from : `${from}/${parts.join("/")}`);
  while (parts.length > 0) {
    const part = parts.shift() as string;
    if (onDevice && at !== FD_DIRECTORY) {
      return { error: "ENOTDIR" };
    }
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      at = at.slice(0, at.lastIndexOf("/")) || "/";
      onDevice = false;
      continue;
    }
    const next = at === "/" ? `/${part}` : `${at}/${part}`;
    if (isDevicePath(next)) {
      at = next;
      onDevice = true;
      throughDevice = true;
      continue;
    }
    if (onDevice) {
      // A name in /dev/fd that is no descriptor number.
      return { error: "ENOENT" };
    }
    let stat: StatData;
    try {
      stat = tree.stat(next, false);
    } catch {
      // Missing, refused …: the tree says so for the path from here.
      return throughDevice ? { tree: rest(next) } : null;
    }
    const kind = stat.mode & S_IFMT;
    if (kind === S_IFLNK && (parts.length > 0 || followLast)) {
      links += 1;
      if (links > MAX_LINKS) {
        return null;
      }
      const target = tree.readlink(next);
      const targetParts = target.split("/").filter((part) => part !== "");
      if (target.endsWith("/") && targetParts.length > 0) {
        targetParts.push(".");
      }
      parts.unshift(...targetParts);
      if (target.startsWith("/")) {
        at = "/";
      }
      continue;
    }
    if (parts.length > 0 && kind !== S_IFDIR) {
      // A file with more after it: the tree's ENOTDIR.
      return throughDevice ? { tree: rest(next) } : null;
    }
    at = next;
  }
  if (!throughDevice) {
    return null;
  }
  return onDevice ? { device: at } : { tree: at };
}
