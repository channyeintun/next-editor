// Package and bin names. Every package name the installer reads (the project's
// dependencies, a dependency's dependencies, an alias target, a name on the
// command line) becomes a directory under node_modules and a registry URL, so
// each one is checked against npm's rule (validate-npm-package-name) before it
// is used. A bin name becomes a file in `.bin` and may not hold a path.
import { PmError } from "./errors";

const MAX_LENGTH = 214;
const BLOCKED = new Set(["node_modules", "favicon.ico"]);

function urlSafe(part: string): boolean {
  return part !== "" && encodeURIComponent(part) === part;
}

/**
 * Why `name` is not a valid package name, or null when it is. The rule is
 * npm's: an optional `@scope/` prefix, URL-safe characters, no leading `.` or
 * `_` (on the name or the scope), no surrounding spaces, at most 214
 * characters, and not `node_modules` or `favicon.ico`. Capital letters are
 * accepted, as npm accepts them for existing packages (`JSONStream`).
 */
export function packageNameProblem(name: string): string | null {
  if (name === "") {
    return "name is empty";
  }
  if (name.trim() !== name) {
    return "name has leading or trailing spaces";
  }
  if (name.length > MAX_LENGTH) {
    return `name is longer than ${MAX_LENGTH} characters`;
  }
  if (BLOCKED.has(name.toLowerCase())) {
    return `${name} is a blocked name`;
  }
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
  const parts = scoped ? [scoped[1], scoped[2]] : name.includes("/") ? null : [name];
  if (!parts) {
    return "name can only contain URL-friendly characters";
  }
  for (const part of parts) {
    if (part.startsWith(".") || part.startsWith("_")) {
      return "name cannot start with a period or an underscore";
    }
    if (!urlSafe(part)) {
      return "name can only contain URL-friendly characters";
    }
  }
  return null;
}

/** True when `name` is a valid package name. */
export function isValidPackageName(name: string): boolean {
  return packageNameProblem(name) === null;
}

/** Throws `PmError("EINVALIDPACKAGENAME")` unless `name` is a valid package name. */
export function assertPackageName(name: string): void {
  const problem = packageNameProblem(name);
  if (problem !== null) {
    throw new PmError("EINVALIDPACKAGENAME", `Invalid package name "${name}": ${problem}`);
  }
}

/**
 * The `.bin` file name for a declared bin name, or null when it is not one.
 * A leading `@scope/` is dropped (as npm does); what is left may not contain
 * `/`, `\`, `..`, a NUL byte, or be empty or `.`.
 */
export function binFileName(raw: string): string | null {
  const name = raw.trim().replace(/^@[^/]+\//, "");
  if (
    name === "" ||
    name === "." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    return null;
  }
  return name;
}
