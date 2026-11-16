// Package executables: each installed package's `bin` (a string or a map, or
// every file under `directories.bin`) becomes `<its node_modules>/.bin/<name>`,
// a relative symlink to the script, and the script is made executable.
import type { FsBackend } from "../../runtime";
import { binFileName } from "./names";
import { basename, dirname, join, normalize, relative } from "./paths";

/** The parts of a package.json that declare executables. */
export interface BinManifest {
  name?: string;
  bin?: string | Record<string, string>;
  directories?: { bin?: string };
}

/** An installed package: its absolute directory and its package.json. */
export interface InstalledPackage {
  dir: string;
  manifest: BinManifest;
}

/**
 * `[binName, pathInsidePackage]` for each executable `manifest` declares.
 * Names with a scope lose it; a name that holds a path (`/`, `..`) or a path
 * that would leave the package is dropped. `listDir` lists a `directories.bin` folder (file names).
 */
export function binEntries(
  manifest: BinManifest,
  listDir?: (path: string) => string[],
): [string, string][] {
  const entries: [string, string][] = [];
  const add = (rawName: string, rawPath: string) => {
    const name = binFileName(rawName);
    const path = normalize(rawPath.trim());
    if (name === null || path === ".." || path.startsWith("../") || path.startsWith("/")) {
      return;
    }
    entries.push([name, path]);
  };
  if (typeof manifest.bin === "string") {
    if (manifest.name) {
      add(manifest.name, manifest.bin);
    }
  } else if (manifest.bin && typeof manifest.bin === "object") {
    for (const [name, path] of Object.entries(manifest.bin)) {
      if (typeof path === "string") {
        add(name, path);
      }
    }
  } else if (manifest.directories?.bin && listDir) {
    const folder = normalize(manifest.directories.bin);
    if (!folder.startsWith("..")) {
      for (const file of listDir(folder)) {
        add(file, `${folder}/${file}`);
      }
    }
  }
  return entries;
}

/** The node_modules directory that holds the package at `dir` (handles `@scope/name`). */
export function nodeModulesOf(dir: string): string {
  const parent = dirname(dir);
  return basename(parent).startsWith("@") ? dirname(parent) : parent;
}

/**
 * Creates the `.bin` links for `packages`. Later entries win a name clash, so
 * pass the project's own dependencies last. Returns the links made, as
 * absolute paths.
 */
export function linkBins(fs: FsBackend, packages: InstalledPackage[]): string[] {
  const made: string[] = [];
  const binDirs = new Set<string>();
  for (const pkg of packages) {
    const listDir = (path: string) => {
      try {
        return fs
          .readdir(join(pkg.dir, path))
          .filter((entry) => entry.type !== "dir")
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    };
    const entries = binEntries(pkg.manifest, listDir);
    if (entries.length === 0) {
      continue;
    }
    const binDir = join(nodeModulesOf(pkg.dir), ".bin");
    if (!binDirs.has(binDir)) {
      fs.mkdir(binDir, true, 0o755);
      binDirs.add(binDir);
    }
    for (const [name, path] of entries) {
      const script = join(pkg.dir, path);
      const link = join(binDir, name);
      try {
        fs.rm(link, false, true);
      } catch {
        // Nothing to replace.
      }
      fs.symlink(relative(binDir, script), link);
      try {
        fs.chmod(script, 0o755, true);
      } catch {
        // A bin pointing at a missing file still gets its link, as npm does.
      }
      made.push(link);
    }
  }
  return made;
}
