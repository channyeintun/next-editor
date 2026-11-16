// The `path` builtin: `path.posix` and `path.win32`, ported from Node's
// lib/path.js (MIT). The default export is the posix object, as on Linux.
// `resolve` reads the working directory from the process runtime when it runs,
// falling back to "/" when no runtime is installed.
import { runtime } from "../runtime";
import { validateObject, validateString } from "./internalErrors";

/** What `path.parse` returns and `path.format` accepts. */
export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

/** `path.format`'s argument: every field optional. */
export type FormatInputPathObject = Partial<ParsedPath>;

/** `path.posix` / `path.win32`. */
export interface PlatformPath {
  resolve(...paths: string[]): string;
  normalize(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  toNamespacedPath(path: string): string;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  format(pathObject: FormatInputPathObject): string;
  parse(path: string): ParsedPath;
  matchesGlob(path: string, pattern: string): boolean;
  readonly sep: "/" | "\\";
  readonly delimiter: ":" | ";";
  posix: PlatformPath;
  win32: PlatformPath;
  /** Legacy alias of `toNamespacedPath` (DEP0080). */
  _makeLong(path: string): string;
}

const CHAR_UPPERCASE_A = 65;
const CHAR_LOWERCASE_A = 97;
const CHAR_UPPERCASE_Z = 90;
const CHAR_LOWERCASE_Z = 122;
const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_COLON = 58;
const CHAR_QUESTION_MARK = 63;

/** The process's working directory, or "/" outside a process. */
function cwd(): string {
  try {
    return runtime().cwd;
  } catch {
    return "/";
  }
}

/** `process.env[name]`, or undefined outside a process. */
function envValue(name: string): string | undefined {
  try {
    return runtime().env[name];
  } catch {
    return undefined;
  }
}

function isPathSeparator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isPosixPathSeparator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH;
}

const WINDOWS_RESERVED_NAMES = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "COM\xb9",
  "COM\xb2",
  "COM\xb3",
  "LPT\xb9",
  "LPT\xb2",
  "LPT\xb3",
];

function isWindowsReservedName(path: string, colonIndex: number): boolean {
  const devicePart = path.slice(0, colonIndex).toUpperCase();
  return WINDOWS_RESERVED_NAMES.includes(devicePart);
}

function isWindowsDeviceRoot(code: number): boolean {
  return (
    (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
    (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z)
  );
}

/** Resolves `.` and `..` segments of a path without its root. */
function normalizeString(
  path: string,
  allowAboveRoot: boolean,
  separator: string,
  isSeparator: (code: number) => boolean,
): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (isSeparator(code)) {
      break;
    } else {
      code = CHAR_FORWARD_SLASH;
    }

    if (isSeparator(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== CHAR_DOT ||
          res.charCodeAt(res.length - 2) !== CHAR_DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.length - lastSegmentLength - 1;
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) {
          res += `${separator}${path.slice(lastSlash + 1, i)}`;
        } else {
          res = path.slice(lastSlash + 1, i);
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function formatExt(ext: string | undefined): string {
  return ext ? `${ext[0] === "." ? "" : "."}${ext}` : "";
}

function formatWith(sep: string, pathObject: FormatInputPathObject): string {
  validateObject(pathObject, "pathObject");
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || `${pathObject.name || ""}${formatExt(pathObject.ext)}`;
  if (!dir) {
    return base;
  }
  return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}

function matchesGlobUnsupported(): never {
  throw new Error("path.matchesGlob is not supported by webnode");
}

/** `path.win32`. */
export const win32 = {
  resolve(...args: string[]): string {
    let resolvedDevice = "";
    let resolvedTail = "";
    let resolvedAbsolute = false;

    for (let i = args.length - 1; i >= -1; i--) {
      let path: string;
      if (i >= 0) {
        path = args[i];
        validateString(path, `paths[${i}]`);
        // Skip empty entries
        if (path.length === 0) {
          continue;
        }
      } else if (resolvedDevice.length === 0) {
        path = cwd();
        // Fast path for the current directory; the cwd is a posix path here.
        if (
          args.length === 0 ||
          (args.length === 1 &&
            (args[0] === "" || args[0] === ".") &&
            isPathSeparator(path.charCodeAt(0)))
        ) {
          return path.replace(/\//g, "\\");
        }
      } else {
        // Windows keeps a working directory per drive; use it when known,
        // else the process cwd, else the drive's root.
        path = envValue(`=${resolvedDevice}`) || cwd();
        if (
          path === undefined ||
          (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
            path.charCodeAt(2) === CHAR_BACKWARD_SLASH)
        ) {
          path = `${resolvedDevice}\\`;
        }
      }

      const len = path.length;
      let rootEnd = 0;
      let device = "";
      let isAbsolute = false;
      const code = path.charCodeAt(0);

      // Try to match a root
      if (len === 1) {
        if (isPathSeparator(code)) {
          // `path` contains just a path separator
          rootEnd = 1;
          isAbsolute = true;
        }
      } else if (isPathSeparator(code)) {
        // Possible UNC root: we at least have an absolute path of some kind.
        isAbsolute = true;

        if (isPathSeparator(path.charCodeAt(1))) {
          // Matched double path separator at beginning
          let j = 2;
          let last = j;
          // Match 1 or more non-path separators
          while (j < len && !isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j < len && j !== last) {
            const firstPart = path.slice(last, j);
            last = j;
            // Match 1 or more path separators
            while (j < len && isPathSeparator(path.charCodeAt(j))) {
              j++;
            }
            if (j < len && j !== last) {
              last = j;
              // Match 1 or more non-path separators
              while (j < len && !isPathSeparator(path.charCodeAt(j))) {
                j++;
              }
              if (j === len || j !== last) {
                if (firstPart !== "." && firstPart !== "?") {
                  // We matched a UNC root
                  device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                  rootEnd = j;
                } else {
                  // We matched a device root (e.g. \\\\.\\PHYSICALDRIVE0)
                  device = `\\\\${firstPart}`;
                  rootEnd = 4;
                }
              }
            }
          }
        } else {
          rootEnd = 1;
        }
      } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
        // Possible device root
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
          // A separator after the drive name makes the path absolute.
          isAbsolute = true;
          rootEnd = 3;
        }
      }

      if (device.length > 0) {
        if (resolvedDevice.length > 0) {
          if (device.toLowerCase() !== resolvedDevice.toLowerCase()) {
            // This path points to another device so it is not applicable
            continue;
          }
        } else {
          resolvedDevice = device;
        }
      }

      if (resolvedAbsolute) {
        if (resolvedDevice.length > 0) {
          break;
        }
      } else {
        resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
        resolvedAbsolute = isAbsolute;
        if (isAbsolute && resolvedDevice.length > 0) {
          break;
        }
      }
    }

    // Normalize the tail path
    resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, "\\", isPathSeparator);

    return resolvedAbsolute
      ? `${resolvedDevice}\\${resolvedTail}`
      : `${resolvedDevice}${resolvedTail}` || ".";
  },

  normalize(path: string): string {
    validateString(path, "path");
    const len = path.length;
    if (len === 0) {
      return ".";
    }
    let rootEnd = 0;
    let device: string | undefined;
    let isAbsolute = false;
    const code = path.charCodeAt(0);

    // Try to match a root
    if (len === 1) {
      // A single character: exit early.
      return isPosixPathSeparator(code) ? "\\" : path;
    }
    if (isPathSeparator(code)) {
      // Possible UNC root: we at least have an absolute path of some kind.
      isAbsolute = true;

      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning
        let j = 2;
        let last = j;
        // Match 1 or more non-path separators
        while (j < len && !isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
          last = j;
          // Match 1 or more path separators
          while (j < len && isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j < len && j !== last) {
            last = j;
            // Match 1 or more non-path separators
            while (j < len && !isPathSeparator(path.charCodeAt(j))) {
              j++;
            }
            if (j === len || j !== last) {
              if (firstPart === "." || firstPart === "?") {
                // We matched a device root (e.g. \\\\.\\PHYSICALDRIVE0)
                device = `\\\\${firstPart}`;
                rootEnd = 4;
                const colonIndex = path.indexOf(":");
                // Special case: \\?\COM1: and similar reserved device paths
                const possibleDevice = path.slice(4, colonIndex + 1);
                if (isWindowsReservedName(possibleDevice, possibleDevice.length - 1)) {
                  device = `\\\\?\\${possibleDevice}`;
                  rootEnd = 4 + possibleDevice.length;
                }
              } else if (j === len) {
                // We matched a UNC root only: nothing left to process.
                return `\\\\${firstPart}\\${path.slice(last)}\\`;
              } else {
                // We matched a UNC root with leftovers
                device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                rootEnd = j;
              }
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else {
      const colonIndex = path.indexOf(":");
      if (colonIndex > 0) {
        if (isWindowsDeviceRoot(code) && colonIndex === 1) {
          device = path.slice(0, 2);
          rootEnd = 2;
          if (len > 2 && isPathSeparator(path.charCodeAt(2))) {
            isAbsolute = true;
            rootEnd = 3;
          }
        } else if (isWindowsReservedName(path, colonIndex)) {
          device = path.slice(0, colonIndex + 1);
          rootEnd = colonIndex + 1;
        }
      }
    }

    let tail =
      rootEnd < len ? normalizeString(path.slice(rootEnd), !isAbsolute, "\\", isPathSeparator) : "";
    if (tail.length === 0 && !isAbsolute) {
      tail = ".";
    }
    if (tail.length > 0 && isPathSeparator(path.charCodeAt(len - 1))) {
      tail += "\\";
    }
    if (!isAbsolute && device === undefined && path.includes(":")) {
      // A relative path not tied to a device must not normalize into
      // something Windows reads as absolute (CVE-2024-36139).
      if (
        tail.length >= 2 &&
        isWindowsDeviceRoot(tail.charCodeAt(0)) &&
        tail.charCodeAt(1) === CHAR_COLON
      ) {
        return `.\\${tail}`;
      }
      let index = path.indexOf(":");
      do {
        if (index === len - 1 || isPathSeparator(path.charCodeAt(index + 1))) {
          return `.\\${tail}`;
        }
      } while ((index = path.indexOf(":", index + 1)) !== -1);
    }
    const colonIndex = path.indexOf(":");
    if (isWindowsReservedName(path, colonIndex)) {
      return `.\\${device ?? ""}${tail}`;
    }
    if (device === undefined) {
      return isAbsolute ? `\\${tail}` : tail;
    }
    return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
  },

  isAbsolute(path: string): boolean {
    validateString(path, "path");
    const len = path.length;
    if (len === 0) {
      return false;
    }
    const code = path.charCodeAt(0);
    return (
      isPathSeparator(code) ||
      // Possible device root
      (len > 2 &&
        isWindowsDeviceRoot(code) &&
        path.charCodeAt(1) === CHAR_COLON &&
        isPathSeparator(path.charCodeAt(2)))
    );
  },

  join(...args: string[]): string {
    if (args.length === 0) {
      return ".";
    }
    const paths: string[] = [];
    for (const arg of args) {
      validateString(arg, "path");
      if (arg.length > 0) {
        paths.push(arg);
      }
    }
    if (paths.length === 0) {
      return ".";
    }

    const firstPart = paths[0];
    let joined = paths.join("\\");

    // A joined path must not start with two slashes, or normalize() reads it
    // as UNC. Skipped when the first part clearly is UNC: exactly two
    // slashes followed by a non-slash (`join('//server', 'share')`).
    let needsReplace = true;
    let slashCount = 0;
    if (isPathSeparator(firstPart.charCodeAt(0))) {
      ++slashCount;
      const firstLen = firstPart.length;
      if (firstLen > 1 && isPathSeparator(firstPart.charCodeAt(1))) {
        ++slashCount;
        if (firstLen > 2) {
          if (isPathSeparator(firstPart.charCodeAt(2))) {
            ++slashCount;
          } else {
            // We matched a UNC path in the first part
            needsReplace = false;
          }
        }
      }
    }
    if (needsReplace) {
      // Find any more consecutive slashes we need to replace
      while (slashCount < joined.length && isPathSeparator(joined.charCodeAt(slashCount))) {
        slashCount++;
      }
      // Replace the slashes if needed
      if (slashCount >= 2) {
        joined = `\\${joined.slice(slashCount)}`;
      }
    }

    // Skip normalization when reserved device names are present
    const parts: string[] = [];
    let part = "";
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] === "\\") {
        if (part) {
          parts.push(part);
        }
        part = "";
        // Skip consecutive backslashes
        while (i + 1 < joined.length && joined[i + 1] === "\\") {
          i++;
        }
      } else {
        part += joined[i];
      }
    }
    if (part) {
      parts.push(part);
    }
    if (
      parts.some((p) => {
        const colonIndex = p.indexOf(":");
        return colonIndex !== -1 && isWindowsReservedName(p, colonIndex);
      })
    ) {
      let result = "";
      for (const char of joined) {
        result += char === "/" ? "\\" : char;
      }
      return result;
    }

    return win32.normalize(joined);
  },

  relative(from: string, to: string): string {
    validateString(from, "from");
    validateString(to, "to");

    if (from === to) {
      return "";
    }

    const fromOrig = win32.resolve(from);
    const toOrig = win32.resolve(to);

    if (fromOrig === toOrig) {
      return "";
    }

    from = fromOrig.toLowerCase();
    to = toOrig.toLowerCase();

    if (from === to) {
      return "";
    }

    if (fromOrig.length !== from.length || toOrig.length !== to.length) {
      const fromSplit = fromOrig.split("\\");
      const toSplit = toOrig.split("\\");
      if (fromSplit[fromSplit.length - 1] === "") {
        fromSplit.pop();
      }
      if (toSplit[toSplit.length - 1] === "") {
        toSplit.pop();
      }

      const fromLen = fromSplit.length;
      const toLen = toSplit.length;
      const length = fromLen < toLen ? fromLen : toLen;

      let i: number;
      for (i = 0; i < length; i++) {
        if (fromSplit[i].toLowerCase() !== toSplit[i].toLowerCase()) {
          break;
        }
      }

      if (i === 0) {
        return toOrig;
      } else if (i === length) {
        if (toLen > length) {
          return toSplit.slice(i).join("\\");
        }
        if (fromLen > length) {
          return "..\\".repeat(fromLen - 1 - i) + "..";
        }
        return "";
      }

      return "..\\".repeat(fromLen - i) + toSplit.slice(i).join("\\");
    }

    // Trim any leading backslashes
    let fromStart = 0;
    while (fromStart < from.length && from.charCodeAt(fromStart) === CHAR_BACKWARD_SLASH) {
      fromStart++;
    }
    // Trim trailing backslashes (applicable to UNC paths only)
    let fromEnd = from.length;
    while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === CHAR_BACKWARD_SLASH) {
      fromEnd--;
    }
    const fromLen = fromEnd - fromStart;

    // Trim any leading backslashes
    let toStart = 0;
    while (toStart < to.length && to.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) {
      toStart++;
    }
    // Trim trailing backslashes (applicable to UNC paths only)
    let toEnd = to.length;
    while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === CHAR_BACKWARD_SLASH) {
      toEnd--;
    }
    const toLen = toEnd - toStart;

    // Compare paths to find the longest common path from root
    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) {
        break;
      } else if (fromCode === CHAR_BACKWARD_SLASH) {
        lastCommonSep = i;
      }
    }

    // A mismatch before the first common separator: return the original `to`.
    if (i !== length) {
      if (lastCommonSep === -1) {
        return toOrig;
      }
    } else {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === CHAR_BACKWARD_SLASH) {
          // `from` is the exact base path for `to`:
          // from='C:\\foo\\bar'; to='C:\\foo\\bar\\baz'
          return toOrig.slice(toStart + i + 1);
        }
        if (i === 2) {
          // `from` is the device root: from='C:\\'; to='C:\\foo'
          return toOrig.slice(toStart + i);
        }
      }
      if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === CHAR_BACKWARD_SLASH) {
          // `to` is the exact base path for `from`:
          // from='C:\\foo\\bar'; to='C:\\foo'
          lastCommonSep = i;
        } else if (i === 2) {
          // `to` is the device root: from='C:\\foo\\bar'; to='C:\\'
          lastCommonSep = 3;
        }
      }
      if (lastCommonSep === -1) {
        lastCommonSep = 0;
      }
    }

    let out = "";
    // One `..` for each segment of `from` after the common part.
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === CHAR_BACKWARD_SLASH) {
        out += out.length === 0 ? ".." : "\\..";
      }
    }

    toStart += lastCommonSep;

    // Then the rest of `to` after the common part.
    if (out.length > 0) {
      return `${out}${toOrig.slice(toStart, toEnd)}`;
    }

    if (toOrig.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) {
      ++toStart;
    }
    return toOrig.slice(toStart, toEnd);
  },

  toNamespacedPath(path: string): string {
    // Non-strings pass through unchanged, as in Node.
    if (typeof path !== "string" || path.length === 0) {
      return path;
    }

    const resolvedPath = win32.resolve(path);

    if (resolvedPath.length <= 2) {
      return path;
    }

    if (resolvedPath.charCodeAt(0) === CHAR_BACKWARD_SLASH) {
      // Possible UNC root
      if (resolvedPath.charCodeAt(1) === CHAR_BACKWARD_SLASH) {
        const code = resolvedPath.charCodeAt(2);
        if (code !== CHAR_QUESTION_MARK && code !== CHAR_DOT) {
          // Matched non-long UNC root, convert the path to a long UNC path
          return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
        }
      }
    } else if (
      isWindowsDeviceRoot(resolvedPath.charCodeAt(0)) &&
      resolvedPath.charCodeAt(1) === CHAR_COLON &&
      resolvedPath.charCodeAt(2) === CHAR_BACKWARD_SLASH
    ) {
      // Matched device root, convert the path to a long UNC path
      return `\\\\?\\${resolvedPath}`;
    }

    return resolvedPath;
  },

  dirname(path: string): string {
    validateString(path, "path");
    const len = path.length;
    if (len === 0) {
      return ".";
    }
    let rootEnd = -1;
    let offset = 0;
    const code = path.charCodeAt(0);

    if (len === 1) {
      // A lone separator is its own dirname; anything else is '.'.
      return isPathSeparator(code) ? path : ".";
    }

    // Try to match a root
    if (isPathSeparator(code)) {
      // Possible UNC root
      rootEnd = offset = 1;

      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning
        let j = 2;
        let last = j;
        // Match 1 or more non-path separators
        while (j < len && !isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          last = j;
          // Match 1 or more path separators
          while (j < len && isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j < len && j !== last) {
            last = j;
            // Match 1 or more non-path separators
            while (j < len && !isPathSeparator(path.charCodeAt(j))) {
              j++;
            }
            if (j === len) {
              // We matched a UNC root only
              return path;
            }
            if (j !== last) {
              // A UNC root with leftovers: the separator after it counts as
              // part of the root.
              rootEnd = offset = j + 1;
            }
          }
        }
      }
      // Possible device root
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
      rootEnd = len > 2 && isPathSeparator(path.charCodeAt(2)) ? 3 : 2;
      offset = rootEnd;
    }

    let end = -1;
    let matchedSlash = true;
    for (let i = len - 1; i >= offset; --i) {
      if (isPathSeparator(path.charCodeAt(i))) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        // We saw the first non-path separator
        matchedSlash = false;
      }
    }

    if (end === -1) {
      if (rootEnd === -1) {
        return ".";
      }
      end = rootEnd;
    }
    return path.slice(0, end);
  },

  basename(path: string, suffix?: string): string {
    if (suffix !== undefined) {
      validateString(suffix, "suffix");
    }
    validateString(path, "path");
    let start = 0;
    let end = -1;
    let matchedSlash = true;

    // Skip a drive letter prefix, so its separator is not taken for a
    // trailing one.
    if (
      path.length >= 2 &&
      isWindowsDeviceRoot(path.charCodeAt(0)) &&
      path.charCodeAt(1) === CHAR_COLON
    ) {
      start = 2;
    }

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) {
        return "";
      }
      let extIdx = suffix.length - 1;
      let firstNonSlashEnd = -1;
      for (let i = path.length - 1; i >= start; --i) {
        const code = path.charCodeAt(i);
        if (isPathSeparator(code)) {
          // A separator that is not part of the trailing ones ends the scan.
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            // Remember the end in case the suffix does not match.
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            // Try to match the explicit extension
            if (code === suffix.charCodeAt(extIdx)) {
              if (--extIdx === -1) {
                // We matched the extension: this is the end of our component.
                end = i;
              }
            } else {
              // No match: the result is the entire path component.
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }

      if (start === end) {
        end = firstNonSlashEnd;
      } else if (end === -1) {
        end = path.length;
      }
      return path.slice(start, end);
    }
    for (let i = path.length - 1; i >= start; --i) {
      if (isPathSeparator(path.charCodeAt(i))) {
        // A separator that is not part of the trailing ones ends the scan.
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        // The first non-separator: the end of our component.
        matchedSlash = false;
        end = i + 1;
      }
    }

    if (end === -1) {
      return "";
    }
    return path.slice(start, end);
  },

  extname(path: string): string {
    validateString(path, "path");
    let start = 0;
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    // The state of the characters before the first dot after any separator.
    let preDotState = 0;

    // Skip a drive letter prefix, so its separator is not taken for a
    // trailing one.
    if (
      path.length >= 2 &&
      path.charCodeAt(1) === CHAR_COLON &&
      isWindowsDeviceRoot(path.charCodeAt(0))
    ) {
      start = startPart = 2;
    }

    for (let i = path.length - 1; i >= start; --i) {
      const code = path.charCodeAt(i);
      if (isPathSeparator(code)) {
        // A separator that is not part of the trailing ones ends the scan.
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        // The first non-separator: the end of our extension.
        matchedSlash = false;
        end = i + 1;
      }
      if (code === CHAR_DOT) {
        // If this is our first dot, mark it as the start of our extension
        if (startDot === -1) {
          startDot = i;
        } else if (preDotState !== 1) {
          preDotState = 1;
        }
      } else if (startDot !== -1) {
        // A non-dot before our dot: likely a non-empty extension.
        preDotState = -1;
      }
    }

    if (
      startDot === -1 ||
      end === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      return "";
    }
    return path.slice(startDot, end);
  },

  format(pathObject: FormatInputPathObject): string {
    return formatWith("\\", pathObject);
  },

  parse(path: string): ParsedPath {
    validateString(path, "path");

    const ret: ParsedPath = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) {
      return ret;
    }

    const len = path.length;
    let rootEnd = 0;
    let code = path.charCodeAt(0);

    if (len === 1) {
      if (isPathSeparator(code)) {
        // `path` contains just a path separator: exit early.
        ret.root = ret.dir = path;
        return ret;
      }
      ret.base = ret.name = path;
      return ret;
    }
    // Try to match a root
    if (isPathSeparator(code)) {
      // Possible UNC root
      rootEnd = 1;
      if (isPathSeparator(path.charCodeAt(1))) {
        // Matched double path separator at beginning
        let j = 2;
        let last = j;
        // Match 1 or more non-path separators
        while (j < len && !isPathSeparator(path.charCodeAt(j))) {
          j++;
        }
        if (j < len && j !== last) {
          last = j;
          // Match 1 or more path separators
          while (j < len && isPathSeparator(path.charCodeAt(j))) {
            j++;
          }
          if (j < len && j !== last) {
            last = j;
            // Match 1 or more non-path separators
            while (j < len && !isPathSeparator(path.charCodeAt(j))) {
              j++;
            }
            if (j === len) {
              // We matched a UNC root only
              rootEnd = j;
            } else if (j !== last) {
              // We matched a UNC root with leftovers
              rootEnd = j + 1;
            }
          }
        }
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
      // Possible device root
      if (len <= 2) {
        // `path` contains just a drive root: exit early.
        ret.root = ret.dir = path;
        return ret;
      }
      rootEnd = 2;
      if (isPathSeparator(path.charCodeAt(2))) {
        if (len === 3) {
          // `path` contains just a drive root: exit early.
          ret.root = ret.dir = path;
          return ret;
        }
        rootEnd = 3;
      }
    }
    if (rootEnd > 0) {
      ret.root = path.slice(0, rootEnd);
    }

    let startDot = -1;
    let startPart = rootEnd;
    let end = -1;
    let matchedSlash = true;
    let i = path.length - 1;

    // The state of the characters before the first dot after any separator.
    let preDotState = 0;

    // Get non-dir info
    for (; i >= rootEnd; --i) {
      code = path.charCodeAt(i);
      if (isPathSeparator(code)) {
        // A separator that is not part of the trailing ones ends the scan.
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        // The first non-separator: the end of our extension.
        matchedSlash = false;
        end = i + 1;
      }
      if (code === CHAR_DOT) {
        // If this is our first dot, mark it as the start of our extension
        if (startDot === -1) {
          startDot = i;
        } else if (preDotState !== 1) {
          preDotState = 1;
        }
      } else if (startDot !== -1) {
        // A non-dot before our dot: likely a non-empty extension.
        preDotState = -1;
      }
    }

    if (end !== -1) {
      if (
        startDot === -1 ||
        // We saw a non-dot character immediately before the dot
        preDotState === 0 ||
        // The (right-most) trimmed path component is exactly '..'
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
      ) {
        ret.base = ret.name = path.slice(startPart, end);
      } else {
        ret.name = path.slice(startPart, startDot);
        ret.base = path.slice(startPart, end);
        ret.ext = path.slice(startDot, end);
      }
    }

    // A root directory keeps its trailing separator (`C:\abc` -> `C:\`);
    // any other directory drops it (`C:\abc\def` -> `C:\abc`).
    if (startPart > 0 && startPart !== rootEnd) {
      ret.dir = path.slice(0, startPart - 1);
    } else {
      ret.dir = ret.root;
    }

    return ret;
  },

  matchesGlob(_path: string, _pattern: string): boolean {
    return matchesGlobUnsupported();
  },

  sep: "\\" as const,
  delimiter: ";" as const,
} as PlatformPath;

/** `path.posix`. */
export const posix = {
  resolve(...args: string[]): string {
    if (args.length === 0 || (args.length === 1 && (args[0] === "" || args[0] === "."))) {
      const current = cwd();
      if (current.charCodeAt(0) === CHAR_FORWARD_SLASH) {
        return current;
      }
    }
    let resolvedPath = "";
    let resolvedAbsolute = false;

    for (let i = args.length - 1; i >= 0 && !resolvedAbsolute; i--) {
      const path = args[i];
      validateString(path, `paths[${i}]`);

      // Skip empty entries
      if (path.length === 0) {
        continue;
      }

      resolvedPath = `${path}/${resolvedPath}`;
      resolvedAbsolute = path[0] === "/";
    }

    if (!resolvedAbsolute) {
      const current = cwd();
      resolvedPath = `${current}/${resolvedPath}`;
      resolvedAbsolute = current.charCodeAt(0) === CHAR_FORWARD_SLASH;
    }

    // Normalize the path
    resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, "/", isPosixPathSeparator);

    if (resolvedAbsolute) {
      return `/${resolvedPath}`;
    }
    return resolvedPath.length > 0 ? resolvedPath : ".";
  },

  normalize(path: string): string {
    validateString(path, "path");

    if (path.length === 0) {
      return ".";
    }

    const isAbsolute = path[0] === "/";
    const trailingSeparator = path[path.length - 1] === "/";

    // Normalize the path
    path = normalizeString(path, !isAbsolute, "/", isPosixPathSeparator);

    if (path.length === 0) {
      if (isAbsolute) {
        return "/";
      }
      return trailingSeparator ? "./" : ".";
    }
    if (trailingSeparator) {
      path += "/";
    }

    return isAbsolute ? `/${path}` : path;
  },

  isAbsolute(path: string): boolean {
    validateString(path, "path");
    return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  },

  join(...args: string[]): string {
    if (args.length === 0) {
      return ".";
    }
    const paths: string[] = [];
    for (const arg of args) {
      validateString(arg, "path");
      if (arg.length > 0) {
        paths.push(arg);
      }
    }
    if (paths.length === 0) {
      return ".";
    }
    return posix.normalize(paths.join("/"));
  },

  relative(from: string, to: string): string {
    validateString(from, "from");
    validateString(to, "to");

    if (from === to) {
      return "";
    }

    // Trim leading forward slashes.
    from = posix.resolve(from);
    to = posix.resolve(to);

    if (from === to) {
      return "";
    }

    const fromStart = 1;
    const fromEnd = from.length;
    const fromLen = fromEnd - fromStart;
    const toStart = 1;
    const toLen = to.length - toStart;

    // Compare paths to find the longest common path from root
    const length = fromLen < toLen ? fromLen : toLen;
    let lastCommonSep = -1;
    let i = 0;
    for (; i < length; i++) {
      const fromCode = from.charCodeAt(fromStart + i);
      if (fromCode !== to.charCodeAt(toStart + i)) {
        break;
      } else if (fromCode === CHAR_FORWARD_SLASH) {
        lastCommonSep = i;
      }
    }
    if (i === length) {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) {
          // `from` is the exact base path for `to`: from='/foo/bar'; to='/foo/bar/baz'
          return to.slice(toStart + i + 1);
        }
        if (i === 0) {
          // `from` is the root: from='/'; to='/foo'
          return to.slice(toStart + i);
        }
      } else if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) {
          // `to` is the exact base path for `from`: from='/foo/bar/baz'; to='/foo/bar'
          lastCommonSep = i;
        } else if (i === 0) {
          // `to` is the root: from='/foo/bar'; to='/'
          lastCommonSep = 0;
        }
      }
    }

    let out = "";
    // One `..` for each segment of `from` after the common part.
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        out += out.length === 0 ? ".." : "/..";
      }
    }

    // Then the rest of `to` after the common part.
    return `${out}${to.slice(toStart + lastCommonSep)}`;
  },

  toNamespacedPath(path: string): string {
    // Non-op on posix systems
    return path;
  },

  dirname(path: string): string {
    validateString(path, "path");
    if (path.length === 0) {
      return ".";
    }
    const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
      if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
        // We saw the first non-path separator
        matchedSlash = false;
      }
    }

    if (end === -1) {
      return hasRoot ? "/" : ".";
    }
    if (hasRoot && end === 1) {
      return "//";
    }
    return path.slice(0, end);
  },

  basename(path: string, suffix?: string): string {
    if (suffix !== undefined) {
      validateString(suffix, "suffix");
    }
    validateString(path, "path");

    let start = 0;
    let end = -1;
    let matchedSlash = true;

    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) {
        return "";
      }
      let extIdx = suffix.length - 1;
      let firstNonSlashEnd = -1;
      for (let i = path.length - 1; i >= 0; --i) {
        const code = path.charCodeAt(i);
        if (code === CHAR_FORWARD_SLASH) {
          // A separator that is not part of the trailing ones ends the scan.
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            // Remember the end in case the suffix does not match.
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            // Try to match the explicit extension
            if (code === suffix.charCodeAt(extIdx)) {
              if (--extIdx === -1) {
                // We matched the extension: this is the end of our component.
                end = i;
              }
            } else {
              // No match: the result is the entire path component.
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }

      if (start === end) {
        end = firstNonSlashEnd;
      } else if (end === -1) {
        end = path.length;
      }
      return path.slice(start, end);
    }
    for (let i = path.length - 1; i >= 0; --i) {
      if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
        // A separator that is not part of the trailing ones ends the scan.
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        // The first non-separator: the end of our component.
        matchedSlash = false;
        end = i + 1;
      }
    }

    if (end === -1) {
      return "";
    }
    return path.slice(start, end);
  },

  extname(path: string): string {
    validateString(path, "path");
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    // The state of the characters before the first dot after any separator.
    let preDotState = 0;
    for (let i = path.length - 1; i >= 0; --i) {
      const char = path[i];
      if (char === "/") {
        // A separator that is not part of the trailing ones ends the scan.
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        // The first non-separator: the end of our extension.
        matchedSlash = false;
        end = i + 1;
      }
      if (char === ".") {
        // If this is our first dot, mark it as the start of our extension
        if (startDot === -1) {
          startDot = i;
        } else if (preDotState !== 1) {
          preDotState = 1;
        }
      } else if (startDot !== -1) {
        // A non-dot before our dot: likely a non-empty extension.
        preDotState = -1;
      }
    }

    if (
      startDot === -1 ||
      end === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      return "";
    }
    return path.slice(startDot, end);
  },

  format(pathObject: FormatInputPathObject): string {
    return formatWith("/", pathObject);
  },

  parse(path: string): ParsedPath {
    validateString(path, "path");

    const ret: ParsedPath = { root: "", dir: "", base: "", ext: "", name: "" };
    if (path.length === 0) {
      return ret;
    }
    const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
    let start: number;
    if (isAbsolute) {
      ret.root = "/";
      start = 1;
    } else {
      start = 0;
    }
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let i = path.length - 1;

    // The state of the characters before the first dot after any separator.
    let preDotState = 0;

    // Get non-dir info
    for (; i >= start; --i) {
      const char = path[i];
      if (char === "/") {
        // A separator that is not part of the trailing ones ends the scan.
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        // The first non-separator: the end of our extension.
        matchedSlash = false;
        end = i + 1;
      }
      if (char === ".") {
        // If this is our first dot, mark it as the start of our extension
        if (startDot === -1) {
          startDot = i;
        } else if (preDotState !== 1) {
          preDotState = 1;
        }
      } else if (startDot !== -1) {
        // A non-dot before our dot: likely a non-empty extension.
        preDotState = -1;
      }
    }

    if (end !== -1) {
      const begin = startPart === 0 && isAbsolute ? 1 : startPart;
      if (
        startDot === -1 ||
        // We saw a non-dot character immediately before the dot
        preDotState === 0 ||
        // The (right-most) trimmed path component is exactly '..'
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
      ) {
        ret.base = ret.name = path.slice(begin, end);
      } else {
        ret.name = path.slice(begin, startDot);
        ret.base = path.slice(begin, end);
        ret.ext = path.slice(startDot, end);
      }
    }

    if (startPart > 0) {
      ret.dir = path.slice(0, startPart - 1);
    } else if (isAbsolute) {
      ret.dir = "/";
    }

    return ret;
  },

  matchesGlob(_path: string, _pattern: string): boolean {
    return matchesGlobUnsupported();
  },

  sep: "/" as const,
  delimiter: ":" as const,
} as PlatformPath;

posix.win32 = win32.win32 = win32;
posix.posix = win32.posix = posix;

// Legacy internal API, docs-only deprecated: DEP0080
win32._makeLong = win32.toNamespacedPath;
posix._makeLong = posix.toNamespacedPath;

export default posix;
