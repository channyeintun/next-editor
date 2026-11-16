// Native-binary substitutions, applied to a dependency before it is resolved.
// Nothing native can execute in the browser, so — mirroring the polyfill table
// WebContainer applies at install time — packages that ship a native binary are
// installed from their WebAssembly builds under the original name, and napi-rs
// platform families get their `wasm32-wasi` member. The generic rule for
// optional platform packages (skip native, keep wasm32) is `platformDecision`.
import intersects from "semver/ranges/intersects";
import validRange from "semver/ranges/valid";
import type { PackageVersion } from "./registry";

/** What to fetch for a dependency instead of the package it names. */
export interface Substitution {
  /** The registry package whose contents are installed (under the original name). */
  source: string;
  /**
   * `same-version`: resolve the original's version, then install the
   * substitute at that version (falling back to the highest substitute version
   * the range accepts, with a warning).
   */
  version: "same-version";
}

/** A package installed beside another one at the same version. */
export interface Companion {
  name: string;
}

interface TableEntry {
  source: string;
  /**
   * Applies only when the requested range can match this major version or a
   * later one; such a range is installed from the substitute, whose highest
   * satisfying version is then at least this major.
   */
  minMajor?: number;
}

/** Package name → its WebAssembly build. */
const TABLE: Readonly<Record<string, TableEntry>> = {
  esbuild: { source: "esbuild-wasm" },
  rollup: { source: "@rollup/wasm-node", minMajor: 4 },
  lightningcss: { source: "lightningcss-wasm" },
  "@swc/core": { source: "@swc/wasm" },
  "@parcel/watcher": { source: "@parcel/watcher-wasm" },
};

/** Package name → the package installed beside it at the same version. */
const COMPANIONS: Readonly<Record<string, string>> = {
  "@tailwindcss/oxide": "@tailwindcss/oxide-wasm32-wasi",
};

/**
 * napi-rs style families whose platform members are interchangeable: a direct
 * dependency on any member installs the family's `wasm32-wasi` member.
 */
const WASI_FAMILIES: readonly string[] = [
  "@rolldown/binding-",
  "@oxc-parser/binding-",
  "@oxc-resolver/binding-",
  "@oxc-transform/binding-",
  "@oxc-minify/binding-",
  "@tailwindcss/oxide-",
  "@napi-rs/canvas-",
  "@unrs/resolver-binding-",
];

const PLATFORM_PREFIX =
  /^(?:linux|darwin|win32|freebsd|openbsd|netbsd|sunos|aix|android|openharmony)-/;

/** Packages whose native install step the substitution table covers. */
export function coveredBySubstitution(name: string): boolean {
  return name in TABLE || name in COMPANIONS;
}

/**
 * The substitute for dependency `name` requested with `range`, or null when it
 * installs as itself. `range` is a semver range or a dist-tag.
 */
export function substituteFor(name: string, range: string): Substitution | null {
  const entry = TABLE[name];
  if (!entry) {
    return null;
  }
  if (entry.minMajor !== undefined && validRange(range)) {
    try {
      if (!intersects(range, `>=${entry.minMajor}.0.0`)) {
        return null;
      }
    } catch {
      // An odd range: substitute anyway; the substitute's resolution reports problems.
    }
  }
  return { source: entry.source, version: "same-version" };
}

/** The `wasm32-wasi` member to install in place of platform member `name`, or null. */
export function wasiFamilyMember(name: string): string | null {
  for (const prefix of WASI_FAMILIES) {
    if (name.startsWith(prefix)) {
      const suffix = name.slice(prefix.length);
      if (PLATFORM_PREFIX.test(suffix)) {
        return `${prefix}wasm32-wasi`;
      }
    }
  }
  return null;
}

/** The package added beside `name` at the same version, or null. */
export function companionOf(name: string): Companion | null {
  const companion = COMPANIONS[name];
  return companion ? { name: companion } : null;
}

/** What the installer does with one resolved version, for this platform. */
export type PlatformDecision = "install" | "skip-platform" | "skip-native";

/** The platform the runtime reports. */
export const TARGET = { os: "linux", cpu: "x64", libc: "glibc" } as const;

function excludes(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) {
    return false;
  }
  const allowed = list.filter((item) => !item.startsWith("!"));
  const denied = list.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
  if (denied.includes(value)) {
    return true;
  }
  return allowed.length > 0 && !allowed.includes(value);
}

/** True for a package built as WebAssembly for WASI (runs here). */
export function isWasmPackage(version: Pick<PackageVersion, "name" | "cpu">): boolean {
  return (version.cpu ?? []).includes("wasm32") || version.name.endsWith("-wasm32-wasi");
}

/**
 * Whether to install `version`. `optional` is true for an edge declared in
 * `optionalDependencies`. `fsevents` is always skipped. Optional packages that
 * declare `os` or `cpu` are native platform binaries and are skipped even for
 * linux/x64, except WebAssembly builds. A non-optional package is skipped only
 * when its `os`/`cpu`/`libc` excludes linux/x64/glibc.
 */
export function platformDecision(
  version: Pick<PackageVersion, "name" | "os" | "cpu" | "libc">,
  optional: boolean,
): PlatformDecision {
  if (version.name === "fsevents") {
    return "skip-platform";
  }
  if (isWasmPackage(version)) {
    return "install";
  }
  if (
    excludes(version.os, TARGET.os) ||
    excludes(version.cpu, TARGET.cpu) ||
    excludes(version.libc, TARGET.libc)
  ) {
    return "skip-platform";
  }
  if (optional && ((version.os?.length ?? 0) > 0 || (version.cpu?.length ?? 0) > 0)) {
    return "skip-native";
  }
  return "install";
}
