// Lexical path helpers for the filesystem: normalizing a path string and taking
// its parent, with no lookups. Symbolic links are resolved by the Vfs itself.

const SLASH = 47;

/**
 * Normalizes a path lexically: collapses `//`, drops `.`, applies `..` (which
 * stays at `/` for an absolute path) and removes a trailing slash. An empty
 * path becomes `.`.
 */
export function normalizePath(path: string): string {
  if (isNormal(path)) {
    return path;
  }
  const absolute = path.charCodeAt(0) === SLASH;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) {
    return `/${joined}`;
  }
  return joined === "" ? "." : joined;
}

/** True when `path` is already in the form `normalizePath` returns. */
function isNormal(path: string): boolean {
  if (path === "/") {
    return true;
  }
  if (path.length === 0 || path.charCodeAt(path.length - 1) === SLASH) {
    return false;
  }
  if (path.includes("//") || path.includes("/./") || path.includes("/../")) {
    return false;
  }
  if (path.endsWith("/.") || path.endsWith("/..")) {
    return false;
  }
  return !(path === "." || path === ".." || path.startsWith("./") || path.startsWith("../"));
}

/** The index of the last component that is not empty or `.`, or -1. */
export function lastComponentIndex(parts: readonly string[]): number {
  let end = parts.length - 1;
  while (end >= 0 && (parts[end] === "" || parts[end] === ".")) {
    end--;
  }
  return end;
}

/**
 * The parent of `path` by its text alone, as `mkdir -p` walks upward:
 * trailing slashes are ignored and `/` is its own parent.
 */
export function lexicalParent(path: string): string {
  const trimmed = trimTrailingSlashes(path);
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) {
    return "/";
  }
  return trimTrailingSlashes(trimmed.slice(0, cut));
}

/** The last part of `path` as written, trailing slashes ignored (`.` and `..` included); empty for `/`. */
export function lastPart(path: string): string {
  const trimmed = trimTrailingSlashes(path);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** `path` without trailing slashes; `/` stays `/`. */
export function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === SLASH) {
    end--;
  }
  return end === path.length ? path : path.slice(0, end);
}
