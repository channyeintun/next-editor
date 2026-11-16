// The installer: package.json → resolved graph → hoisted layout → tarballs
// fetched, verified and extracted → node_modules, `.bin` links, the root
// project's lifecycle scripts, and node_modules/.webnode-lock.json. Tarballs
// download as soon as their version is known (into a staging directory) and
// move into place once the layout is fixed; packages already installed at the
// same version are kept or moved, not fetched again.
import { runtime } from "../../runtime";
import type { FsBackend } from "../../runtime";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { linkBins, nodeModulesOf } from "./bins";
import type { InstalledPackage } from "./bins";
import { PmError } from "./errors";
import { hoist } from "./hoist";
import { sha256Hex, verifyIntegrity } from "./integrity";
import { readManifest, rootDependencies } from "./manifest";
import type { Manifest } from "./manifest";
import type { Counts, DirectDependency, Reporter } from "./output";
import { dirname, join } from "./paths";
import type { RegistryClient } from "./registry";
import { readOverrides, resolveDependencies } from "./resolve";
import type { ResolvedNode } from "./resolve";
import { runLifecycle } from "./scripts";
import { coveredBySubstitution } from "./substitutions";
import { gunzip, parseTar } from "./tar";
import type { TarEntry } from "./tar";

/** The state file the installer keeps in node_modules (never a lockfile in the project). */
export const LOCK_NAME = ".webnode-lock.json";
const STAGING_NAME = ".webnode-staging";
const LOCK_VERSION = 1;
/** The root project's install lifecycle, in the order npm runs it. */
const ROOT_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

/** One installed package, as the state file records it. */
export interface LockPackage {
  key: string;
  name: string;
  /** The registry package, when it differs from `name` (aliases, substitutions). */
  source?: string;
  version: string;
  integrity?: string;
}

/** node_modules/.webnode-lock.json. */
export interface LockFile {
  lockfileVersion: number;
  /** Fingerprint of the manifest fields that decide the install. */
  manifestHash: string;
  /** Location relative to the project → package. */
  packages: Record<string, LockPackage>;
}

export interface InstallOptions {
  projectDir: string;
  registry: RegistryClient;
  reporter: Reporter;
  /** Print only warnings and errors (npx's temporary installs). */
  quiet?: boolean;
  /** Run the root project's install lifecycle scripts (default true). */
  runScripts?: boolean;
  /**
   * Resolve again even when the state file matches the manifest (`update`):
   * ranges are re-read from the registry, so newer matching versions land.
   */
  force?: boolean;
}

export interface InstallResult {
  /** Exit status: non-zero when a root lifecycle script failed. */
  status: number;
  /** Top-level package name → installed version. */
  installed: Map<string, string>;
  upToDate: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WRITE_FLAGS = O_WRONLY | O_CREAT | O_TRUNC;

/** The fingerprint of what decides an install. */
export async function manifestHash(manifest: Manifest, registry: string): Promise<string> {
  const pnpm = manifest.pnpm as { overrides?: unknown } | undefined;
  return sha256Hex(
    JSON.stringify([
      manifest.dependencies ?? null,
      manifest.devDependencies ?? null,
      manifest.optionalDependencies ?? null,
      manifest.overrides ?? null,
      pnpm?.overrides ?? null,
      manifest.resolutions ?? null,
      registry,
    ]),
  );
}

/** Reads the state file, or null when it is missing or unreadable. */
export function readLock(fs: FsBackend, projectDir: string): LockFile | null {
  try {
    const parsed = JSON.parse(
      decoder.decode(fs.readFile(join(projectDir, "node_modules", LOCK_NAME))),
    ) as LockFile;
    return parsed.lockfileVersion === LOCK_VERSION && parsed.packages ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the state file matches `hash` and every package it records is on disk. */
export function isUpToDate(
  fs: FsBackend,
  projectDir: string,
  lock: LockFile | null,
  hash: string,
): boolean {
  if (!lock || lock.manifestHash !== hash) {
    return false;
  }
  return Object.keys(lock.packages).every((location) =>
    fs.exists(join(projectDir, location, "package.json")),
  );
}

/** Writes tar entries under `dir`, creating each directory once. */
export function writeEntries(fs: FsBackend, dir: string, entries: TarEntry[]): void {
  const made = new Set<string>();
  const ensure = (path: string) => {
    if (!made.has(path)) {
      fs.mkdir(path, true, 0o755);
      made.add(path);
    }
  };
  ensure(dir);
  for (const entry of entries) {
    const target = join(dir, entry.path);
    if (entry.type === "directory") {
      ensure(target);
      continue;
    }
    ensure(dirname(target));
    fs.writeFile(target, entry.data, WRITE_FLAGS, entry.mode & 0o111 ? 0o755 : 0o644);
  }
}

/** Copies a directory tree (files, directories and symlinks). */
export function copyTree(fs: FsBackend, from: string, to: string): void {
  fs.mkdir(to, true, 0o755);
  for (const entry of fs.readdir(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.type === "dir") {
      copyTree(fs, source, target);
    } else if (entry.type === "symlink") {
      fs.symlink(fs.readlink(source), target);
    } else {
      fs.copyFile(source, target, 0);
    }
  }
}

/**
 * True when `location` (from the layout or a state file) names a package
 * directory inside the project's node_modules: `node_modules/...`, with no
 * empty, `.`, `..` or other dot-led segment, so it is never the project, the
 * staging directory or anything outside node_modules.
 */
export function isPackageLocation(location: string): boolean {
  const parts = location.split("/");
  return (
    parts.length >= 2 &&
    parts[0] === "node_modules" &&
    parts.every((part) => part !== "" && !part.startsWith("."))
  );
}

function stagingKey(key: string): string {
  return key.replace(/\//g, "+");
}

function readJson(fs: FsBackend, path: string): Manifest {
  try {
    return JSON.parse(decoder.decode(fs.readFile(path))) as Manifest;
  } catch {
    return {};
  }
}

/** Installs the dependencies of the project at `options.projectDir`. */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const started = Date.now();
  const fs = runtime().fs;
  const { projectDir, registry, reporter } = options;
  const quiet = options.quiet ?? false;
  const manifest = readManifest(fs, projectDir);
  const nodeModules = join(projectDir, "node_modules");
  const lockPath = join(nodeModules, LOCK_NAME);
  const staging = join(nodeModules, STAGING_NAME);
  const hash = await manifestHash(manifest, registry.registry);
  const oldLock = readLock(fs, projectDir);
  const directs = rootDependencies(manifest);

  const runScripts = options.runScripts ?? true;
  const scriptContext = { tool: reporter.tool, reporter, projectDir, manifest };
  /** Runs the root project's lifecycle `events` in order; the first failure's status. */
  const runRootScripts = async (events: string[]): Promise<number> => {
    if (!runScripts) {
      return 0;
    }
    for (const event of events) {
      const status = await runLifecycle(scriptContext, event, []);
      if (status !== 0) {
        reporter.sink.write(2, `${event} script failed with exit code ${status}\n`);
        return status;
      }
    }
    return 0;
  };

  if (!options.force && isUpToDate(fs, projectDir, oldLock, hash)) {
    const installed = new Map<string, string>();
    for (const [location, entry] of Object.entries(oldLock!.packages)) {
      if (location === `node_modules/${entry.name}`) {
        installed.set(entry.name, entry.version);
      }
    }
    if (!quiet) {
      reporter.upToDate(Date.now() - started, Object.keys(oldLock!.packages).length);
    }
    // npm runs the project's own install scripts on every install.
    const status = await runRootScripts(ROOT_SCRIPTS);
    return { status, installed, upToDate: true };
  }

  // `preinstall` runs before anything is resolved or placed, as in npm.
  const preinstallStatus = await runRootScripts(["preinstall"]);
  if (preinstallStatus !== 0) {
    return { status: preinstallStatus, installed: new Map(), upToDate: false };
  }

  if (!quiet) {
    reporter.installStart();
  }
  fs.rm(staging, true, true);

  // A state file is only data inside node_modules: a location in it that is
  // not a package directory is ignored, never removed or copied from.
  const oldPackages: Record<string, LockPackage> = Object.fromEntries(
    Object.entries(oldLock?.packages ?? {}).filter(([location]) => isPackageLocation(location)),
  );
  // Packages already on disk at the same version: key → an old location.
  const onDisk = new Map<string, string>();
  for (const [location, entry] of Object.entries(oldPackages)) {
    if (!onDisk.has(entry.key) && fs.exists(join(projectDir, location, "package.json"))) {
      onDisk.set(entry.key, location);
    }
  }

  const counts: Counts = { resolved: 0, reused: 0, downloaded: 0, added: 0 };
  const progress = () => {
    if (!quiet) {
      reporter.progress(counts);
    }
  };
  const downloads = new Map<string, Promise<Manifest>>();
  const failures: unknown[] = [];

  const fetchPackage = async (node: ResolvedNode): Promise<Manifest> => {
    const { tarball, integrity, shasum } = node.manifest.dist;
    // The tarball cache is shared by every runtime session in the browser, so
    // cached bytes are checked exactly like downloaded ones; a version with
    // nothing to check against is never read from or written to the cache.
    const verifiable = Boolean(integrity || shasum);
    let fetched = await registry.tarball(tarball, { cache: verifiable });
    let check = await verifyIntegrity(fetched.bytes, integrity, shasum);
    if (!check.ok && fetched.cached) {
      await registry.forget(tarball);
      fetched = await registry.tarball(tarball, { cache: false });
      check = await verifyIntegrity(fetched.bytes, integrity, shasum);
    }
    if (!check.ok) {
      throw new PmError(
        "EINTEGRITY",
        `Tarball integrity check failed for ${node.source}@${node.version}`,
        [
          `Expected ${check.algorithm}-${check.expected}`,
          `Received ${check.algorithm}-${check.actual}`,
          `URL: ${tarball}`,
        ],
      );
    }
    if (fetched.cached) {
      counts.reused++;
    } else {
      counts.downloaded++;
      if (verifiable) {
        void registry.remember(tarball, fetched.bytes);
      }
    }
    progress();
    let entries: TarEntry[];
    try {
      entries = parseTar(await gunzip(fetched.bytes));
    } catch (error) {
      if (error instanceof PmError) {
        throw error;
      }
      throw new PmError(
        "ETAR",
        `Could not read the tarball of ${node.source}@${node.version}: ${String(error)}`,
      );
    }
    writeEntries(fs, join(staging, stagingKey(node.key)), entries);
    const packageJson = entries.find((entry) => entry.path === "package.json");
    if (!packageJson) {
      return {};
    }
    try {
      return JSON.parse(decoder.decode(packageJson.data)) as Manifest;
    } catch {
      return {};
    }
  };

  const graph = await resolveDependencies({
    registry,
    dependencies: directs,
    overrides: readOverrides(manifest),
    warn: (message) => reporter.warn(message),
    onResolved: (node) => {
      counts.resolved++;
      if (onDisk.has(node.key)) {
        counts.reused++;
      } else {
        const pending = fetchPackage(node);
        pending.catch((error: unknown) => failures.push(error));
        downloads.set(node.key, pending);
      }
      progress();
    },
  });
  if (!quiet) {
    reporter.step(2);
  }

  const layout = hoist(graph);
  for (const location of layout.keys()) {
    if (!isPackageLocation(location)) {
      throw new PmError("EOTHER", `Refusing to install outside node_modules: ${location}`);
    }
  }

  // A location is kept when the same package is already there and so is every
  // package directory above it.
  const kept = new Set<string>();
  for (const [location, key] of layout) {
    if (
      oldPackages[location]?.key !== key ||
      !fs.exists(join(projectDir, location, "package.json"))
    ) {
      continue;
    }
    const parentEnd = location.lastIndexOf("/node_modules/");
    if (parentEnd === -1 || kept.has(location.slice(0, parentEnd))) {
      kept.add(location);
    }
  }

  // Wait for every download, so a failure stops the install before node_modules changes.
  await Promise.allSettled(downloads.values());
  if (failures.length > 0) {
    fs.rm(staging, true, true);
    throw failures[0];
  }
  if (!quiet) {
    reporter.step(3);
  }

  const uses = new Map<string, number>();
  for (const [location, key] of layout) {
    if (!kept.has(location)) {
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }

  // node_modules changes from here on; until the new state file is written,
  // the next install must not trust the old one.
  fs.rm(lockPath, false, true);

  // Old locations that go away, deepest first: stash the ones still needed.
  const staged = new Set(downloads.keys());
  let removed = 0;
  const oldLocations = Object.keys(oldPackages)
    .filter((location) => !kept.has(location))
    .sort((a, b) => b.length - a.length);
  for (const location of oldLocations) {
    const key = oldPackages[location].key;
    const dir = join(projectDir, location);
    if (!fs.exists(dir)) {
      continue;
    }
    if (!layout.has(location)) {
      removed++;
    }
    if (uses.has(key) && !staged.has(key)) {
      fs.mkdir(staging, true, 0o755);
      fs.rename(dir, join(staging, stagingKey(key)));
      staged.add(key);
    } else {
      fs.rm(dir, true, true);
    }
  }

  // Place every package that is not already in place, parents before children.
  const manifests = new Map<string, Manifest>();
  for (const [key, pending] of downloads) {
    manifests.set(key, await pending);
  }
  for (const [location, key] of layout) {
    if (kept.has(location)) {
      continue;
    }
    const dir = join(projectDir, location);
    fs.rm(dir, true, true);
    fs.mkdir(dirname(dir), true, 0o755);
    const remaining = uses.get(key)!;
    uses.set(key, remaining - 1);
    if (staged.has(key)) {
      const source = join(staging, stagingKey(key));
      if (remaining > 1) {
        copyTree(fs, source, dir);
      } else {
        fs.rename(source, dir);
      }
    } else {
      const keptLocation = [...kept].find((candidate) => layout.get(candidate) === key);
      if (!keptLocation) {
        throw new PmError("EOTHER", `Internal error: no contents for ${key}`);
      }
      copyTree(fs, join(projectDir, keptLocation), dir);
    }
    counts.added++;
    progress();
  }
  fs.rm(staging, true, true);

  // `.bin` links, rebuilt for every node_modules that holds packages.
  const installedPackages: (InstalledPackage & {
    manifest: Manifest;
    location: string;
    key: string;
  })[] = [];
  for (const [location, key] of layout) {
    let packageJson = manifests.get(key);
    if (!packageJson) {
      packageJson = readJson(fs, join(projectDir, location, "package.json"));
      manifests.set(key, packageJson);
    }
    installedPackages.push({
      dir: join(projectDir, location),
      manifest: packageJson,
      location,
      key,
    });
  }
  const binHosts = new Set<string>([nodeModules]);
  for (const location of [...layout.keys(), ...Object.keys(oldPackages)]) {
    binHosts.add(nodeModulesOf(join(projectDir, location)));
  }
  for (const host of binHosts) {
    fs.rm(join(host, ".bin"), true, true);
  }
  const topLevel = (pkg: { location: string; key: string }) =>
    graph.root.get(pkg.location.slice("node_modules/".length)) === pkg.key;
  linkBins(fs, [
    ...installedPackages.filter((pkg) => !topLevel(pkg)),
    ...installedPackages.filter(topLevel),
  ]);

  // Dependencies' install scripts never run here; say which were skipped.
  const ignored = new Set<string>();
  for (const pkg of installedPackages) {
    const name = graph.nodes.get(pkg.key)?.name ?? "";
    const scripts = pkg.manifest.scripts ?? {};
    if (
      (scripts.preinstall || scripts.install || scripts.postinstall) &&
      !coveredBySubstitution(name)
    ) {
      ignored.add(name);
    }
  }

  const lock: LockFile = { lockfileVersion: LOCK_VERSION, manifestHash: hash, packages: {} };
  for (const [location, key] of layout) {
    const node = graph.nodes.get(key)!;
    lock.packages[location] = {
      key,
      name: node.name,
      ...(node.source !== node.name ? { source: node.source } : {}),
      version: node.version,
      ...(node.manifest.dist.integrity ? { integrity: node.manifest.dist.integrity } : {}),
    };
  }
  // A project with no dependencies has no node_modules until now.
  fs.mkdir(nodeModules, true, 0o755);
  fs.writeFile(lockPath, encoder.encode(`${JSON.stringify(lock, null, 2)}\n`), WRITE_FLAGS, 0o644);

  const installed = new Map<string, string>();
  for (const [name, key] of graph.root) {
    installed.set(name, graph.nodes.get(key)!.version);
  }

  if (!quiet) {
    reporter.step(4);
    reporter.progressDone(counts);
    if (ignored.size > 0) {
      reporter.line(`Ignored build scripts: ${[...ignored].sort().join(", ")}.`);
    }
  }

  const status = await runRootScripts(ROOT_SCRIPTS.slice(1));

  if (!quiet) {
    const direct: DirectDependency[] = directs
      .filter((dependency) => installed.has(dependency.name))
      .map((dependency) => ({
        name: dependency.name,
        version: installed.get(dependency.name)!,
        type: dependency.type,
      }));
    reporter.summary({
      added: counts.added,
      removed,
      direct,
      elapsedMs: Date.now() - started,
    });
  }
  return { status, installed, upToDate: false };
}
