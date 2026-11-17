// The project's package.json: finding it, reading it (with the errors each tool
// gives for a missing or broken one), listing its dependencies, and editing
// them for `add` / `remove` while keeping the file's indentation.
import type { FsBackend } from "../../runtime";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { PmError } from "./errors";
import { ancestors, join } from "./paths";
import type { RootDependency } from "./resolve";

/** A package.json as parsed; unknown fields are kept untouched. */
export type Manifest = Record<string, unknown> & {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Which dependency list `add` writes to. */
export type SaveType = "prod" | "dev" | "optional" | "peer";

const FIELDS: Readonly<Record<SaveType, string>> = {
  prod: "dependencies",
  dev: "devDependencies",
  optional: "optionalDependencies",
  peer: "peerDependencies",
};

/** The nearest directory from `cwd` upward that has a package.json, or null. */
export function findProjectDir(fs: FsBackend, cwd: string): string | null {
  for (const dir of ancestors(cwd)) {
    if (fs.exists(join(dir, "package.json"))) {
      return dir;
    }
  }
  return null;
}

/** Reads and parses `<dir>/package.json`. */
export function readManifest(fs: FsBackend, dir: string): Manifest {
  const path = join(dir, "package.json");
  let text: string;
  try {
    text = new TextDecoder().decode(fs.readFile(path));
  } catch {
    throw new PmError("ENOPKG", `No package.json found in ${dir}`);
  }
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Manifest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PmError("EJSONPARSE", `Invalid package.json in ${dir}: ${reason}`);
  }
}

/** The indentation a JSON text uses (two spaces when it cannot tell). */
export function detectIndent(text: string): string {
  const match = /^[{[]\r?\n([ \t]+)/.exec(text);
  return match ? match[1] : "  ";
}

/** Writes `manifest` to `<dir>/package.json`, keeping the existing file's indentation. */
export function writeManifest(fs: FsBackend, dir: string, manifest: Manifest): void {
  const path = join(dir, "package.json");
  let indent = "  ";
  try {
    indent = detectIndent(new TextDecoder().decode(fs.readFile(path)));
  } catch {
    // A new file.
  }
  const text = `${JSON.stringify(manifest, null, indent)}\n`;
  fs.writeFile(path, new TextEncoder().encode(text), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
}

/**
 * The project's dependencies to install: `dependencies`, `devDependencies`
 * and `optionalDependencies` (a name in several lists counts once; the
 * optional list wins, then the production list, as npm does).
 */
export function rootDependencies(manifest: Manifest): RootDependency[] {
  const byName = new Map<string, RootDependency>();
  const lists: [SaveType, Record<string, string> | undefined][] = [
    ["dev", manifest.devDependencies],
    ["prod", manifest.dependencies],
    ["optional", manifest.optionalDependencies],
  ];
  for (const [type, list] of lists) {
    if (!list || typeof list !== "object") {
      continue;
    }
    for (const [name, spec] of Object.entries(list)) {
      if (typeof spec === "string") {
        byName.set(name, { name, spec, type });
      }
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Sorts an object's keys, as npm and pnpm keep dependency lists. */
function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The list an already-listed name stays in when no save flag is given (npm's inferSaveType). */
function listedType(manifest: Manifest, name: string): SaveType {
  for (const type of ["dev", "optional", "prod"] as const) {
    const list = manifest[FIELDS[type]];
    if (list && typeof list === "object" && name in list) {
      return type;
    }
  }
  return "prod";
}

/**
 * Records `entries` (name → spec) in the `type` list, removing the name from
 * the other install lists. With no `type`, each name goes to the list that
 * already has it, else to `dependencies`. Returns a new manifest.
 */
export function addToManifest(
  manifest: Manifest,
  entries: Record<string, string>,
  type: SaveType | null,
): Manifest {
  if (type === null) {
    let next = manifest;
    for (const [name, spec] of Object.entries(entries)) {
      next = addToManifest(next, { [name]: spec }, listedType(manifest, name));
    }
    return next;
  }
  const next: Manifest = { ...manifest };
  for (const other of ["prod", "dev", "optional"] as const) {
    if (other === type) {
      continue;
    }
    const field = FIELDS[other];
    const list = next[field] as Record<string, string> | undefined;
    if (list && Object.keys(entries).some((name) => name in list)) {
      const copy = { ...list };
      for (const name of Object.keys(entries)) {
        delete copy[name];
      }
      if (Object.keys(copy).length === 0) {
        delete next[field];
      } else {
        next[field] = copy;
      }
    }
  }
  const field = FIELDS[type];
  next[field] = sorted({
    ...(next[field] as Record<string, string> | undefined),
    ...entries,
  });
  return next;
}

/** Removes `names` from every dependency list. Returns the new manifest and the names it found. */
export function removeFromManifest(
  manifest: Manifest,
  names: string[],
): { manifest: Manifest; removed: string[] } {
  const next: Manifest = { ...manifest };
  const removed = new Set<string>();
  for (const field of Object.values(FIELDS)) {
    const list = next[field] as Record<string, string> | undefined;
    if (!list) {
      continue;
    }
    const copy = { ...list };
    for (const name of names) {
      if (name in copy) {
        delete copy[name];
        removed.add(name);
      }
    }
    if (Object.keys(copy).length !== Object.keys(list).length) {
      next[field] = copy;
    }
  }
  return { manifest: next, removed: [...removed] };
}
