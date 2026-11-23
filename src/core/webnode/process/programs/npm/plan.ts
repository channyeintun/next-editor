// Dependency plans: what resolving and hoisting one manifest gave, kept as one
// object so that a later install of the same manifest makes no metadata
// request. A plan names, for each package, the archive that holds its tar
// (prepared.ts) and the registry tarball to fall back on. A plan and the
// resolver fill the same shape, ResolvedInstall, which the installer works
// from once the layout is known, so what it places does not depend on where
// the layout came from.
import { isDepsObjectId } from "../../../depsObjects";
import type { Layout } from "./hoist";
import { LOCK_VERSION, isPackageLocation } from "./install";
import type { ResolveResult, ResolvedNode } from "./resolve";

/** The plan format this installer reads and writes. */
export const PLAN_VERSION = 1;

/** One package of a plan. */
export interface PlanPackage {
  name: string;
  /** The registry package, when it differs from `name` (aliases, substitutions). */
  source?: string;
  version: string;
  /** The registry's own tarball URL and check values: the fallback when the archive cannot be had. */
  tarball: string;
  integrity?: string;
  shasum?: string;
  /** The id of the package's archive, and the size of its tar in bytes. */
  archive: string;
  size: number;
}

/** What resolving and hoisting one manifest gave. */
export interface DependencyPlan {
  planVersion: 1;
  /** LOCK_VERSION of the installer that made it. */
  lockfileVersion: number;
  manifestHash: string;
  /** key → package (key as the installer's graph and state file use it). */
  packages: Record<string, PlanPackage>;
  /** [location, key] in the layout's order. */
  layout: [string, string][];
  /** The project's direct dependencies: name → key. */
  root: Record<string, string>;
  /** The warnings resolving printed, replayed in order. */
  warnings: string[];
}

/** Where a package's tarball is and what it must hash to. */
export interface PackageDist {
  tarball: string;
  integrity?: string;
  shasum?: string;
}

/** A package's prepared archive: the id of its tar and the tar's size in bytes. */
export interface PackageArchive {
  id: string;
  size: number;
}

/** One package to install, whichever source resolved it. */
export interface ResolvedPackage {
  key: string;
  /** The directory name it is installed as. */
  name: string;
  /** The registry package its contents come from. */
  source: string;
  version: string;
  dist: PackageDist;
  /** Its archive, when the install comes from a plan. */
  archive?: PackageArchive;
}

/** What an install places: the packages by key, the project's own, and where each goes. */
export interface ResolvedInstall {
  nodes: Map<string, ResolvedPackage>;
  /** Top-level dependency name → key, in name order. */
  root: Map<string, string>;
  layout: Layout;
}

/** The package a resolved node installs. */
export function packageOfNode(node: ResolvedNode): ResolvedPackage {
  return {
    key: node.key,
    name: node.name,
    source: node.source,
    version: node.version,
    dist: distOf(node.manifest.dist),
  };
}

/** The resolver's graph and its layout, as the installer works from them. */
export function resolvedFromGraph(graph: ResolveResult, layout: Layout): ResolvedInstall {
  const nodes = new Map<string, ResolvedPackage>();
  for (const [key, node] of graph.nodes) {
    nodes.set(key, packageOfNode(node));
  }
  return { nodes, root: new Map(graph.root), layout: new Map(layout) };
}

/** A checked plan (decodePlan), as the installer works from it. */
export function resolvedFromPlan(plan: DependencyPlan): ResolvedInstall {
  const nodes = new Map<string, ResolvedPackage>();
  for (const key of Object.keys(plan.packages).sort(compare)) {
    const pkg = plan.packages[key];
    nodes.set(key, {
      key,
      name: pkg.name,
      source: pkg.source ?? pkg.name,
      version: pkg.version,
      dist: distOf(pkg),
      archive: { id: pkg.archive, size: pkg.size },
    });
  }
  // Sorted here because an object puts names that look like numbers first.
  const root = new Map(Object.entries(plan.root).sort(([a], [b]) => compare(a, b)));
  return { nodes, root, layout: new Map(plan.layout) };
}

/**
 * The plan of a registry install: its resolution, each package's archive (by
 * key) and the warnings resolving printed. Every package needs an archive.
 */
export function planOf(input: {
  manifestHash: string;
  resolved: ResolvedInstall;
  archives: ReadonlyMap<string, PackageArchive>;
  warnings: readonly string[];
}): DependencyPlan {
  const packages: [string, PlanPackage][] = [];
  for (const [key, pkg] of input.resolved.nodes) {
    const archive = input.archives.get(key);
    if (!archive) {
      throw new Error(`No archive for ${key}`);
    }
    packages.push([
      key,
      {
        name: pkg.name,
        ...(pkg.source !== pkg.name ? { source: pkg.source } : {}),
        version: pkg.version,
        ...distOf(pkg.dist),
        archive: archive.id,
        size: archive.size,
      },
    ]);
  }
  return {
    planVersion: PLAN_VERSION,
    lockfileVersion: LOCK_VERSION,
    manifestHash: input.manifestHash,
    packages: Object.fromEntries(packages),
    layout: [...input.resolved.layout],
    root: Object.fromEntries(input.resolved.root),
    warnings: [...input.warnings],
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A plan's bytes: JSON with every object's keys in order and no spacing, so
 * the same plan always gives the same bytes, and so the same object id.
 */
export function encodePlan(plan: DependencyPlan): Uint8Array {
  return encoder.encode(canonicalJson(plan));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    // Written by hand: JSON.stringify puts keys that look like numbers first.
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The plan in `bytes` when it is one this installer can use for the manifest
 * `hash`, else null. Its bytes were checked against their id, but its contents
 * are checked here too: a plan never places anything outside node_modules,
 * names a package it does not describe, or falls back to a tarball that is
 * not fetched over https.
 */
export function decodePlan(bytes: Uint8Array, hash: string): DependencyPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const { planVersion, lockfileVersion, manifestHash, packages, layout, root, warnings } = value;
  if (planVersion !== PLAN_VERSION || lockfileVersion !== LOCK_VERSION || manifestHash !== hash) {
    return null;
  }
  if (!isRecord(packages) || !Array.isArray(layout) || !isRecord(root)) {
    return null;
  }
  if (!Array.isArray(warnings) || !warnings.every((warning) => typeof warning === "string")) {
    return null;
  }
  const decoded: [string, PlanPackage][] = [];
  for (const [key, raw] of Object.entries(packages)) {
    const pkg = decodePackage(raw);
    if (!pkg) {
      return null;
    }
    decoded.push([key, pkg]);
  }
  const keys = new Set(decoded.map(([key]) => key));
  const locations = new Set<string>();
  const places: [string, string][] = [];
  for (const entry of layout) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return null;
    }
    const [location, key] = entry as unknown[];
    if (
      typeof location !== "string" ||
      typeof key !== "string" ||
      !isPackageLocation(location) ||
      locations.has(location) ||
      !keys.has(key)
    ) {
      return null;
    }
    locations.add(location);
    places.push([location, key]);
  }
  const direct: [string, string][] = [];
  for (const [name, key] of Object.entries(root)) {
    if (typeof key !== "string" || !keys.has(key)) {
      return null;
    }
    direct.push([name, key]);
  }
  return {
    planVersion: PLAN_VERSION,
    lockfileVersion: LOCK_VERSION,
    manifestHash: hash,
    packages: Object.fromEntries(decoded),
    layout: places,
    root: Object.fromEntries(direct),
    warnings: [...(warnings as string[])],
  };
}

function decodePackage(raw: unknown): PlanPackage | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { name, source, version, tarball, integrity, shasum, archive, size } = raw;
  if (
    !isText(name) ||
    !isText(version) ||
    (source !== undefined && !isText(source)) ||
    !isHttpsUrl(tarball) ||
    (integrity !== undefined && typeof integrity !== "string") ||
    (shasum !== undefined && typeof shasum !== "string") ||
    typeof archive !== "string" ||
    !isDepsObjectId(archive) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    return null;
  }
  return {
    name,
    ...(source !== undefined ? { source } : {}),
    version,
    tarball,
    ...(integrity !== undefined ? { integrity } : {}),
    ...(shasum !== undefined ? { shasum } : {}),
    archive,
    size,
  };
}

function distOf(dist: PackageDist): PackageDist {
  return {
    tarball: dist.tarball,
    ...(dist.integrity ? { integrity: dist.integrity } : {}),
    ...(dist.shasum ? { shasum: dist.shasum } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
