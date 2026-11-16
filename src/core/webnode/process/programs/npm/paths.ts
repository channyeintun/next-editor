// POSIX path helpers for the package manager (it never imports Node's `path`).

/** Normalizes an absolute or relative POSIX path (`.`, `..`, `//`). */
export function normalize(path: string): string {
  const absolute = path.startsWith("/");
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
  return absolute ? `/${joined}` : joined || ".";
}

/** Joins path segments and normalizes the result. */
export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== "").join("/"));
}

/** Resolves `path` against the absolute directory `base`. */
export function resolvePath(base: string, path: string): string {
  return path.startsWith("/") ? normalize(path) : join(base, path);
}

/** The directory part of an absolute path (`/` for `/a`). */
export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** The last segment of a path, with an optional extension removed. */
export function basename(path: string, extension = ""): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return extension && name.endsWith(extension) ? name.slice(0, -extension.length) : name;
}

/** The relative path from absolute directory `from` to absolute path `to`. */
export function relative(from: string, to: string): string {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) {
    common++;
  }
  const up = a.slice(common).map(() => "..");
  return [...up, ...b.slice(common)].join("/") || ".";
}

/** Every directory from `start` up to `/`, nearest first. */
export function ancestors(start: string): string[] {
  const result: string[] = [];
  let current = normalize(start);
  for (;;) {
    result.push(current);
    if (current === "/") {
      return result;
    }
    current = dirname(current);
  }
}
