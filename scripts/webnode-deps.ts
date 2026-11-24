// Prepared installs: the plans and archives webnode's installer reads in place
// of the npm registry (src/core/webnode/process/programs/npm/plan.ts and
// prepared.ts), built here under bun with no browser.
//
//   bun scripts/webnode-deps.ts list                       every manifest the lessons and starters install, and its plan
//   bun scripts/webnode-deps.ts build [filter …] [--refresh] build the plans not built yet (only the matching ones, with filters)
//   bun scripts/webnode-deps.ts check                      ask the registry whether every planned version is still as it was
//   bun scripts/webnode-deps.ts upload --remote|--local [--all] [--dry-run]
//                                                          put the objects this machine has not put to that bucket before (a person runs this)
//
// A filter is a label ("vite 5"), a user (a lesson's slug, starter:<name>) or
// the start of a manifest hash. --refresh builds a matching manifest again
// although it has a plan.
//
// A build installs the manifest with webnode's own installer, in the fake
// runtime the installer's tests use, from the real registry and without the
// project's own scripts. It keeps each tarball as the registry sent it; a
// package's archive is exactly the tarball gunzipped, named by the SHA-256 of
// that tar and stored Brotli-compressed. The plan is what resolving gave. The
// build then installs again, in a fresh runtime, from the plan and the stored
// objects alone, with a registry that refuses every request, and fails unless
// both trees are the same byte for byte. Last it writes the index the runtime
// bundles (plans.generated.ts) from every plan built.
//
// The local store is node_modules/.cache/webnode-deps/: objects/<id>.br (what
// the harness serves and upload puts) and plans/<manifestHash>.json (what was
// built, for whom, from which installer sources). upload keeps a ledger there
// for each destination and bucket (uploaded-<destination>-<bucket>.json) of
// what it has put, so a second run puts only new objects. It never asks the
// bucket what it has, which would take one wrangler call per object: --all
// ignores the ledger and puts every object, for a bucket that was emptied or
// replaced.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompressSync, constants as zlib } from "node:zlib";
import { depsObjectIdOfPath, depsObjectKey, isDepsObjectId } from "../src/core/webnode/depsObjects";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../src/core/webnode/kernel/vfs/types";
import { setRuntime } from "../src/core/webnode/process/runtime";
import type { FsBackend } from "../src/core/webnode/process/runtime";
import { createFakeRuntime } from "../src/core/webnode/process/testing/fakeRuntime";
import type { FakeRuntime } from "../src/core/webnode/process/testing/fakeRuntime";
import { install, manifestHash } from "../src/core/webnode/process/programs/npm/install";
import type { RegistryResolution } from "../src/core/webnode/process/programs/npm/install";
import { readManifest } from "../src/core/webnode/process/programs/npm/manifest";
import type { Manifest } from "../src/core/webnode/process/programs/npm/manifest";
import { Reporter, createRuntimeSink } from "../src/core/webnode/process/programs/npm/output";
import { decodePlan, encodePlan, planOf } from "../src/core/webnode/process/programs/npm/plan";
import type { DependencyPlan, PackageArchive } from "../src/core/webnode/process/programs/npm/plan";
import {
  createPreparedInstalls,
  depsObjectIdOf,
} from "../src/core/webnode/process/programs/npm/prepared";
import {
  DEFAULT_REGISTRY,
  createRegistryClient,
} from "../src/core/webnode/process/programs/npm/registry";
import type { FetchLike, RegistryClient } from "../src/core/webnode/process/programs/npm/registry";
import { gunzip } from "../src/core/webnode/process/programs/npm/tar";
import {
  DEPS_STORE_DIR,
  DEPS_STORE_OBJECTS_DIR,
  DEPS_STORE_OBJECT_SUFFIX,
  DEPS_STORE_PLANS_DIR,
  depsStoreObjectFile,
} from "./webnode-deps-store";
import { boundBucketName } from "./r2Bucket";
import { runtimeLessons, starterWorkspaces } from "./webnode-scenarios/workspaces";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM_SOURCES = resolve(ROOT, "src/core/webnode/process/programs/npm");
const INDEX_FILE = join(NPM_SOURCES, "plans.generated.ts");
const WRANGLER_CONFIG = resolve(ROOT, "infra/wrangler.toml");
const PROJECT = "/project";

const encoder = new TextEncoder();

// ---------------------------------------------------------------- manifests

/** One distinct manifest that installs something, and who installs it. */
interface ManifestEntry {
  hash: string;
  label: string;
  /** package.json exactly as the lesson or starter has it. */
  text: string;
  /** Lesson slugs, then starter:<name>. */
  users: string[];
  lessons: number;
  starters: number;
}

/** What a build recorded about one manifest: plans/<manifestHash>.json. */
interface PlanRecord {
  manifestHash: string;
  label: string;
  users: string[];
  planId: string;
  planBytes: number;
  planCompressedBytes: number;
  packages: { key: string; archive: string; tarBytes: number; compressedBytes: number }[];
  files: number;
  links: number;
  warnings: string[];
  /** Optional dependencies the registry does not have, left out of the plan. */
  skippedOptional: { name: string; spec: string; message: string }[];
  builtAt: string;
  /** The fingerprint of the installer's sources that built it. */
  installer: string;
}

/**
 * The manifest as the installer reads it: through its own reader, so the hash
 * below is the one the installer computes in the browser for the same file.
 */
function parseManifest(text: string): Manifest {
  const fs = { readFile: () => encoder.encode(text) } as unknown as FsBackend;
  return readManifest(fs, PROJECT);
}

function installsSomething(manifest: Manifest): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
    (list) => list && Object.keys(list).length > 0,
  );
}

/** "vite 5 + typescript 6": each dependency with the major version its spec names. */
function dependencyLabel(manifest: Manifest): string {
  const names = Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  });
  return names
    .map(([name, spec]) => {
      const major = /(\d+)/.exec(String(spec))?.[1];
      return major ? `${name} ${major}` : name;
    })
    .join(" + ");
}

/** Every distinct manifest the runtime lessons and the starters install, by hash. */
async function allManifests(): Promise<ManifestEntry[]> {
  const byHash = new Map<string, ManifestEntry & { manifest: Manifest }>();
  const add = async (user: string, text: string | undefined, starter: boolean) => {
    if (text === undefined) {
      return;
    }
    const manifest = parseManifest(text);
    if (!installsSomething(manifest)) {
      return;
    }
    const hash = await manifestHash(manifest, DEFAULT_REGISTRY);
    let entry = byHash.get(hash);
    if (!entry) {
      entry = { hash, label: "", text, users: [], lessons: 0, starters: 0, manifest };
      byHash.set(hash, entry);
    }
    entry.users.push(user);
    entry[starter ? "starters" : "lessons"]++;
  };
  for (const [slug, script] of runtimeLessons()) {
    if (script.runtime?.initCommand) {
      await add(slug, script.lesson.workspace.files["package.json"], false);
    }
  }
  for (const starter of await starterWorkspaces()) {
    await add(`starter:${starter.name}`, starter.files["package.json"], true);
  }
  const entries = [...byHash.values()];
  for (const entry of entries) {
    const starter = entry.users.find((user) => user.startsWith("starter:"));
    entry.label = starter ?? dependencyLabel(entry.manifest);
  }
  // Two lesson manifests that differ only below the major version keep apart by their users.
  for (const entry of entries) {
    if (entries.some((other) => other !== entry && other.label === entry.label)) {
      entry.label = `${entry.label} (${entry.users[0]})`;
    }
  }
  return entries
    .map(({ manifest: _manifest, ...entry }) => entry)
    .sort(
      (a, b) => a.starters - b.starters || b.lessons - a.lessons || a.label.localeCompare(b.label),
    );
}

function matches(entry: ManifestEntry, filter: string): boolean {
  return (
    entry.label === filter ||
    entry.users.includes(filter) ||
    (filter.length >= 6 && entry.hash.startsWith(filter))
  );
}

// ---------------------------------------------------------------- the store

function planFile(hash: string): string {
  return join(DEPS_STORE_PLANS_DIR, `${hash}.json`);
}

function readRecord(hash: string): PlanRecord | null {
  try {
    return JSON.parse(readFileSync(planFile(hash), "utf8")) as PlanRecord;
  } catch {
    return null;
  }
}

function allRecords(): PlanRecord[] {
  if (!existsSync(DEPS_STORE_PLANS_DIR)) {
    return [];
  }
  return readdirSync(DEPS_STORE_PLANS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) => JSON.parse(readFileSync(join(DEPS_STORE_PLANS_DIR, name), "utf8")) as PlanRecord,
    );
}

/** Writes a file whole or not at all: an interrupted build leaves no half object. */
function writeAtomically(path: string, bytes: Uint8Array | string): void {
  const partial = `${path}.partial-${process.pid}`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

const compress = promisify(brotliCompress);

/** An object as the store keeps it and the host serves it: Brotli at its smallest. */
async function brotli(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await compress(bytes, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: 11,
        [zlib.BROTLI_PARAM_LGWIN]: 24,
        [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  );
}

/** The stored object `id`, decoded as `fetch` decodes `Content-Encoding: br`; null when missing. */
function readObject(id: string): Uint8Array | null {
  const path = depsStoreObjectFile(id);
  return existsSync(path) ? new Uint8Array(brotliDecompressSync(readFileSync(path))) : null;
}

/** The sources that decide what a plan says: which packages, where each goes, and the plan's form. */
const PLAN_SOURCES = ["hoist.ts", "plan.ts", "resolve.ts", "substitutions.ts"];

/**
 * Which installer sources made a plan: a plan from other sources may place
 * other things, and is built again after the resolver or the hoisting changes.
 * Only those sources count, so a change elsewhere in the installer does not
 * mark every plan as old.
 */
function installerFingerprint(): string {
  const hash = createHash("sha256");
  for (const name of PLAN_SOURCES) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(join(NPM_SOURCES, name)));
  }
  return hash.digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- trees

/** One path of an installed tree: its kind, mode, and its bytes' hash or its link's target. */
type Tree = Map<string, string>;

function treeOf(rt: FakeRuntime, dir: string, into: Tree = new Map()): Tree {
  for (const entry of rt.fs.readdir(dir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = `${dir}/${entry.name}`;
    const mode = (rt.fs.stat(path, false).mode & 0o7777).toString(8);
    if (entry.type === "dir") {
      into.set(path, `dir ${mode}`);
      treeOf(rt, path, into);
    } else if (entry.type === "symlink") {
      into.set(path, `link ${mode} -> ${rt.fs.readlink(path)}`);
    } else {
      const digest = createHash("sha256").update(rt.fs.readFile(path)).digest("hex");
      into.set(path, `${entry.type} ${mode} ${digest}`);
    }
  }
  return into;
}

/** The paths where two trees differ, each with what both sides have there. */
function treeDifferences(first: Tree, second: Tree): string[] {
  const differences: string[] = [];
  for (const path of [...new Set([...first.keys(), ...second.keys()])].sort()) {
    const a = first.get(path) ?? "(missing)";
    const b = second.get(path) ?? "(missing)";
    if (a !== b) {
      differences.push(`${path}\n      registry: ${a}\n      plan:     ${b}`);
    }
  }
  return differences;
}

function countOf(tree: Tree, kind: string): number {
  let count = 0;
  for (const [path, value] of tree) {
    if (path.startsWith(`${PROJECT}/node_modules/`) && value.startsWith(`${kind} `)) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- installs

function freshRuntime(text: string): FakeRuntime {
  const rt = createFakeRuntime({ cwd: PROJECT });
  rt.vfs.mkdir(PROJECT, true, 0o755);
  rt.fs.writeFile(
    `${PROJECT}/package.json`,
    encoder.encode(text),
    O_WRONLY | O_CREAT | O_TRUNC,
    0o644,
  );
  setRuntime(rt);
  return rt;
}

/** A registry that fails every request: a check install that reaches it is a failed check. */
function refusingRegistry(): RegistryClient {
  const refuse = (what: string): never => {
    throw new Error(`the check install asked the registry for ${what}`);
  };
  return {
    registry: DEFAULT_REGISTRY,
    packument: async (name) => refuse(`the packument of ${name}`),
    prefetch: (name) => refuse(`the packument of ${name}`),
    hasPackument: () => false,
    version: async (name, version) => refuse(`${name}@${version}`),
    tarball: async (url) => refuse(url),
    remember: async (url) => refuse(`to keep ${url}`),
    forget: async (url) => refuse(`to forget ${url}`),
  };
}

/** Serves the stored objects as the runtime host does, decoded as `fetch` hands them over. */
const storeFetch: FetchLike = async (url) => {
  const id = depsObjectIdOfPath(new URL(url).pathname);
  const bytes = id ? readObject(id) : null;
  return bytes
    ? new Response(bytes as Uint8Array<ArrayBuffer>)
    : new Response(null, { status: 404, statusText: "Not Found" });
};

function failInstall(rt: FakeRuntime, error: unknown): never {
  const output = `${rt.stdout()}${rt.stderr()}`.split("\n").filter((line) => line.trim());
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n${output.slice(-20).join("\n")}`,
  );
}

// ---------------------------------------------------------------- build

const MB = 1024 * 1024;

function size(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Runs `task` over `items`, at most `limit` at once. */
async function eachLimited<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await task(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * How many archives are compressed at once: Brotli at quality 11 with a 16 MB
 * window takes a few hundred MB per stream, and this machine has 8 GB.
 */
const COMPRESS_CONCURRENCY = 2;

/** The registry install of `text`: what it resolved, the tree it wrote, and every tarball as it arrived. */
async function registryInstall(text: string): Promise<{
  resolution: RegistryResolution;
  tree: Tree;
  tarballs: Map<string, Uint8Array>;
}> {
  const rt = freshRuntime(text);
  const client = createRegistryClient({
    fetch: (url, init) => fetch(url, init),
    registry: DEFAULT_REGISTRY,
  });
  const tarballs = new Map<string, Uint8Array>();
  const keeping: RegistryClient = {
    ...client,
    async tarball(url, options) {
      const fetched = await client.tarball(url, options);
      tarballs.set(url, fetched.bytes);
      return fetched;
    },
  };
  const seen: { resolution?: RegistryResolution } = {};
  try {
    await install({
      projectDir: PROJECT,
      registry: keeping,
      reporter: new Reporter("pnpm", createRuntimeSink()),
      runScripts: false,
      onRegistryResolution: (resolution) => {
        seen.resolution = resolution;
      },
    });
    if (!seen.resolution) {
      throw new Error("the install did not resolve from the registry");
    }
    return { resolution: seen.resolution, tree: treeOf(rt, PROJECT), tarballs };
  } catch (error) {
    failInstall(rt, error);
  } finally {
    setRuntime(null);
  }
}

/** The install of `text` from plan `planId` and the store alone; the tree it wrote. */
async function planInstall(text: string, hash: string, planId: string): Promise<Tree> {
  const rt = freshRuntime(text);
  try {
    await install({
      projectDir: PROJECT,
      registry: refusingRegistry(),
      reporter: new Reporter("pnpm", createRuntimeSink()),
      runScripts: false,
      prepared: createPreparedInstalls({
        fetch: storeFetch,
        origin: "http://localhost",
        index: { [hash]: planId },
        cache: null,
      }),
    });
    return treeOf(rt, PROJECT);
  } catch (error) {
    failInstall(rt, error);
  } finally {
    setRuntime(null);
  }
}

async function build(entry: ManifestEntry): Promise<void> {
  const times: [string, number][] = [];
  let mark = Date.now();
  const lap = (step: string) => {
    const now = Date.now();
    times.push([step, now - mark]);
    mark = now;
  };
  console.log(`\n${entry.label}  ${entry.hash}`);

  // 1. The registry install, keeping every tarball as it arrived.
  const { resolution, tree: registryTree, tarballs } = await registryInstall(entry.text);
  const { resolved, warnings, skippedOptional } = resolution;
  lap("install from the registry");

  // 2. A request that failed must not leave a package out of a plan for good.
  const failed = skippedOptional.filter((skipped) => skipped.error.code !== "E404");
  if (failed.length > 0) {
    throw new Error(
      `resolving left out optional dependencies for a reason other than a missing package:\n${failed
        .map((skipped) => `  ${skipped.name}@${skipped.spec}: ${skipped.error.message}`)
        .join("\n")}`,
    );
  }

  // 3. The archives: gunzipped, named, compressed; only a few tars in memory at once.
  mkdirSync(DEPS_STORE_OBJECTS_DIR, { recursive: true });
  mkdirSync(DEPS_STORE_PLANS_DIR, { recursive: true });
  const storedBefore = new Set(readdirSync(DEPS_STORE_OBJECTS_DIR));
  const archives = new Map<string, PackageArchive>();
  /** Archive id → its compressed size, once for each archive however many packages share it. */
  const objects = new Map<string, number>();
  const packages: PlanRecord["packages"] = [];
  await eachLimited([...resolved.nodes.values()], COMPRESS_CONCURRENCY, async (pkg) => {
    const tarball = tarballs.get(pkg.dist.tarball);
    if (!tarball) {
      throw new Error(`no tarball was fetched for ${pkg.key}`);
    }
    const tar = await gunzip(tarball);
    const id = await depsObjectIdOf(tar);
    const path = depsStoreObjectFile(id);
    if (!existsSync(path)) {
      writeAtomically(path, await brotli(tar));
    }
    const stored = statSync(path).size;
    objects.set(id, stored);
    archives.set(pkg.key, { id, size: tar.length });
    packages.push({ key: pkg.key, archive: id, tarBytes: tar.length, compressedBytes: stored });
  });
  tarballs.clear();
  packages.sort((a, b) => (a.key < b.key ? -1 : 1));
  const tarSizes = new Map(packages.map((pkg) => [pkg.archive, pkg.tarBytes]));
  const tarBytes = [...tarSizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const compressedBytes = [...objects.values()].reduce((sum, bytes) => sum + bytes, 0);
  const sharedBytes = [...objects]
    .filter(([id]) => storedBefore.has(`${id}${DEPS_STORE_OBJECT_SUFFIX}`))
    .reduce((sum, [, bytes]) => sum + bytes, 0);
  lap("archives");

  // 4. The plan object.
  const plan = planOf({ manifestHash: entry.hash, resolved, archives, warnings });
  const planBytes = encodePlan(plan);
  const planId = await depsObjectIdOf(planBytes);
  const compressedPlan = await brotli(planBytes);
  if (!existsSync(depsStoreObjectFile(planId))) {
    writeAtomically(depsStoreObjectFile(planId), compressedPlan);
  }
  lap("plan");

  // 5. The same install from the plan and the store alone.
  const planTree = await planInstall(entry.text, entry.hash, planId);
  const differences = treeDifferences(registryTree, planTree);
  if (differences.length > 0) {
    throw new Error(
      `the install from the plan differs from the registry's in ${differences.length} paths; the first:\n  ${differences
        .slice(0, 10)
        .join("\n  ")}`,
    );
  }
  lap("check install from the plan");

  // The record is written only once the check passed: a manifest whose
  // check failed is built again next time.
  const record: PlanRecord = {
    manifestHash: entry.hash,
    label: entry.label,
    users: entry.users,
    planId,
    planBytes: planBytes.length,
    planCompressedBytes: compressedPlan.length,
    packages,
    files: countOf(registryTree, "file"),
    links: countOf(registryTree, "link"),
    warnings,
    skippedOptional: skippedOptional.map((skipped) => ({
      name: skipped.name,
      spec: skipped.spec,
      message: skipped.error.message,
    })),
    builtAt: new Date().toISOString(),
    installer: installerFingerprint(),
  };
  writeAtomically(planFile(entry.hash), `${JSON.stringify(record, null, 2)}\n`);

  console.log(
    `  ${packages.length} packages, ${record.files} files, ${record.links} links\n` +
      `  tar ${size(tarBytes)} (${tarBytes} B) → Brotli ${size(compressedBytes)} (${compressedBytes} B), ` +
      `${size(sharedBytes)} (${sharedBytes} B) of it already stored for manifests built before\n` +
      `  plan ${planId}: ${size(planBytes.length)} (${planBytes.length} B), ${compressedPlan.length} B compressed\n` +
      `  skipped optional (not in the registry): ${record.skippedOptional.map((one) => one.name).join(", ") || "none"}\n` +
      `  ${times.map(([step, ms]) => `${step} ${seconds(ms)}`).join(", ")}`,
  );
}

/** Writes the index the runtime bundles from every plan built, and formats it. */
function writeIndex(): void {
  const rows = allRecords()
    .sort((a, b) => (a.manifestHash < b.manifestHash ? -1 : 1))
    .map(
      (record) =>
        `  // ${record.label.replace(/\s+/g, " ")}\n  ${JSON.stringify(record.manifestHash)}: ${JSON.stringify(record.planId)},`,
    );
  writeFileSync(
    INDEX_FILE,
    "/** manifestHash → the id of its plan. Generated by scripts/webnode-deps.ts; do not edit. */\n" +
      `export const DEPENDENCY_PLANS: Readonly<Record<string, string>> = {${rows.length ? `\n${rows.join("\n")}\n` : ""}};\n`,
  );
  const formatted = spawnSync("npx", ["vp", "fmt", INDEX_FILE], { cwd: ROOT, stdio: "inherit" });
  if (formatted.status !== 0) {
    throw new Error(`npx vp fmt ${INDEX_FILE} failed`);
  }
  console.log(`\nwrote ${INDEX_FILE} (${rows.length} plans)`);
}

// ---------------------------------------------------------------- commands

async function list(): Promise<void> {
  const manifests = await allManifests();
  const fingerprint = installerFingerprint();
  const fromLessons = manifests.filter((entry) => entry.lessons > 0).length;
  console.log(
    `${manifests.length} manifests install something (${fromLessons} from lessons, ` +
      `${manifests.length - fromLessons} from starters); the installer's sources are ${fingerprint}:`,
  );
  for (const entry of manifests) {
    const record = readRecord(entry.hash);
    const plan = !record
      ? "no plan"
      : `plan ${record.planId.slice(0, 12)}, ${record.installer === fingerprint ? "built by these sources" : `built by other sources (${record.installer})`}`;
    const lessons = entry.users.filter((user) => !user.startsWith("starter:"));
    const starters = entry.users.filter((user) => user.startsWith("starter:"));
    const users = [
      lessons.length
        ? `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}: ${lessons.slice(0, 3).join(", ")}${lessons.length > 3 ? ", …" : ""}`
        : "",
      starters.join(", "),
    ]
      .filter(Boolean)
      .join("; ");
    console.log(
      `${entry.hash.slice(0, 12)}  ${entry.label}\n` +
        (users === entry.label ? "" : `              ${users}\n`) +
        `              ${plan}`,
    );
  }
}

async function buildCommand(args: string[]): Promise<number> {
  const refresh = args.includes("--refresh");
  const filters = args.filter((arg) => !arg.startsWith("--"));
  const manifests = await allManifests();
  for (const filter of filters) {
    if (!manifests.some((entry) => matches(entry, filter))) {
      throw new Error(`no manifest matches ${filter} (see list)`);
    }
  }
  const chosen = manifests.filter(
    (entry) =>
      (filters.length === 0 || filters.some((filter) => matches(entry, filter))) &&
      (refresh || !existsSync(planFile(entry.hash))),
  );
  let failures = 0;
  try {
    // The index is written however little was built, so it can always be made
    // again from the store's plans alone.
    if (chosen.length === 0) {
      console.log("every chosen manifest has a plan (--refresh builds them again)");
    }
    for (const entry of chosen) {
      try {
        await build(entry);
      } catch (error) {
        failures++;
        setRuntime(null);
        console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    writeIndex();
  }
  return failures > 0 ? 1 : 0;
}

/** The plan `record` names, read back from the store and checked as the installer checks it. */
function storedPlan(record: PlanRecord): DependencyPlan {
  const bytes = readObject(record.planId);
  const plan = bytes ? decodePlan(bytes, record.manifestHash) : null;
  if (!plan) {
    throw new Error(`the plan ${record.planId} of ${record.label} is missing or unreadable`);
  }
  return plan;
}

async function check(): Promise<number> {
  const records = allRecords();
  const wanted = new Map<
    string,
    { source: string; version: string; integrity?: string; shasum?: string; labels: Set<string> }
  >();
  for (const record of records) {
    for (const pkg of Object.values(storedPlan(record).packages)) {
      const source = pkg.source ?? pkg.name;
      const id = `${source}@${pkg.version}`;
      const known = wanted.get(id) ?? {
        source,
        version: pkg.version,
        integrity: pkg.integrity,
        shasum: pkg.shasum,
        labels: new Set<string>(),
      };
      known.labels.add(record.label);
      wanted.set(id, known);
    }
  }
  const client = createRegistryClient({
    fetch: (url, init) => fetch(url, init),
    registry: DEFAULT_REGISTRY,
  });
  const problems: string[] = [];
  const deprecated: string[] = [];
  await Promise.all(
    [...wanted].map(async ([id, pkg]) => {
      const found = await client.version(pkg.source, pkg.version);
      const where = [...pkg.labels].join(", ");
      if (!found) {
        problems.push(`${id} is no longer published (${where})`);
      } else if (
        (found.dist.integrity ?? null) !== (pkg.integrity ?? null) ||
        (found.dist.shasum ?? null) !== (pkg.shasum ?? null)
      ) {
        problems.push(`${id} has another integrity value now (${where})`);
      } else if (found.deprecated) {
        deprecated.push(`${id}: ${found.deprecated}`);
      }
    }),
  );
  console.log(`${records.length} plans, ${wanted.size} package versions asked for again`);
  for (const line of deprecated.sort()) {
    console.log(`  deprecated: ${line}`);
  }
  for (const line of problems.sort()) {
    console.log(`  FAILED: ${line}`);
  }
  return problems.length > 0 ? 1 : 0;
}

/** The bucket the Worker binds as BUCKET, as infra/wrangler.toml names it. */
function bucketName(): string {
  return boundBucketName(WRANGLER_CONFIG);
}

async function upload(args: string[]): Promise<number> {
  const remote = args.includes("--remote");
  const local = args.includes("--local");
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  if (remote === local) {
    throw new Error(
      "upload needs exactly one of --remote (the real bucket) or --local (wrangler dev's)",
    );
  }
  if ((await check()) !== 0) {
    console.error("upload stopped: check failed");
    return 1;
  }
  const destination = remote ? "remote" : "local";
  const bucket = bucketName();
  // What was put is known only from this ledger: the bucket is not asked.
  const ledgerFile = join(DEPS_STORE_DIR, `uploaded-${destination}-${bucket}.json`);
  const ledger = new Set<string>(
    !all && existsSync(ledgerFile)
      ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as string[])
      : [],
  );
  const plans = new Set(allRecords().map((record) => record.planId));
  const ids = (existsSync(DEPS_STORE_OBJECTS_DIR) ? readdirSync(DEPS_STORE_OBJECTS_DIR) : [])
    .filter((name) => name.endsWith(DEPS_STORE_OBJECT_SUFFIX))
    .map((name) => name.slice(0, -DEPS_STORE_OBJECT_SUFFIX.length))
    .filter((id) => isDepsObjectId(id) && !ledger.has(id))
    // Archives first: a plan in the bucket then never names an archive that is not.
    .sort((a, b) => Number(plans.has(a)) - Number(plans.has(b)) || (a < b ? -1 : 1));
  console.log(
    all
      ? `${ids.length} objects to put in ${bucket} (${destination}): all of them (--all)`
      : `${ids.length} objects this machine has not put to ${bucket} (${destination}) before; ` +
          `${ledger.size} put before by its ledger (--all puts every object, for a bucket that was emptied or replaced)`,
  );
  for (const id of ids) {
    const command = [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${depsObjectKey(id)}`,
      "--file",
      depsStoreObjectFile(id),
      "--content-type",
      "application/octet-stream",
      "--config",
      WRANGLER_CONFIG,
      `--${destination}`,
    ];
    console.log(command.join(" "));
    if (dryRun) {
      continue;
    }
    const result = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`upload stopped: putting ${id} failed`);
      return 1;
    }
    ledger.add(id);
    writeAtomically(ledgerFile, `${JSON.stringify([...ledger].sort(), null, 2)}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "list":
      await list();
      return 0;
    case "build":
      return buildCommand(args);
    case "check":
      return check();
    case "upload":
      return upload(args);
    default:
      console.error(
        "usage: bun scripts/webnode-deps.ts <list|build [filter …] [--refresh]|check|upload --remote|--local [--all] [--dry-run]>",
      );
      return 2;
  }
}

process.exit(
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }),
);
