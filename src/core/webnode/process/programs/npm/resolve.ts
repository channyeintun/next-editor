// Dependency resolution: from the project's dependency lists to a graph of
// exact package versions. Each version is chosen by a pure rule (the `latest`
// dist-tag when it satisfies, else the highest satisfying version), so the
// graph is deterministic however the packument requests interleave. Native
// packages are swapped through substitutions.ts before they are resolved.
import maxSatisfying from "semver/ranges/max-satisfying";
import validRange from "semver/ranges/valid";
import satisfies from "semver/functions/satisfies";
import valid from "semver/functions/valid";
import gt from "semver/functions/gt";
import { PmError, isPmError } from "./errors";
import { assertPackageName, isValidPackageName } from "./names";
import type { PackageVersion, Packument, RegistryClient } from "./registry";
import {
  companionOf,
  platformDecision,
  substituteFor,
  TARGET,
  wasiFamilyMember,
} from "./substitutions";

/** One resolved package, keyed by its install name and exact version. */
export interface ResolvedNode {
  /** `name@version`, or `name@npm:source@version` when installed under another name. */
  key: string;
  /** The directory name it is installed as. */
  name: string;
  /** The registry package its contents come from. */
  source: string;
  version: string;
  manifest: PackageVersion;
  /** Dependency name → the key of the node it resolved to, in name order. */
  dependencies: Map<string, string>;
  /** Dependency name → the range it was requested with (after overrides). */
  ranges: Map<string, string>;
}

/** The project's own dependency on a package. */
export interface RootDependency {
  name: string;
  spec: string;
  type: "prod" | "dev" | "optional" | "peer";
}

/** The resolved graph. */
export interface ResolveResult {
  /** Top-level dependency name → node key (the project's dependencies plus hoisted peers). */
  root: Map<string, string>;
  nodes: Map<string, ResolvedNode>;
}

export interface ResolveOptions {
  registry: Pick<RegistryClient, "packument" | "prefetch" | "version" | "hasPackument">;
  dependencies: RootDependency[];
  /** Package name → spec, applied to every transitive dependency on that name. */
  overrides?: Record<string, string>;
  /** Runs once per newly resolved node, as soon as its version is known. */
  onResolved?: (node: ResolvedNode) => void;
  warn?: (message: string) => void;
}

/** A dependency spec, split into the registry package it names and a range or tag. */
export type ParsedSpec =
  | { kind: "range"; source: string; range: string }
  | { kind: "tag"; source: string; tag: string }
  | { kind: "unsupported"; what: string };

/** Parses the spec `spec` of dependency `name`. */
export function parseSpec(name: string, spec: string): ParsedSpec {
  let source = name;
  let rest = spec.trim();
  if (rest.startsWith("npm:")) {
    const aliased = rest.slice(4);
    const at = aliased.indexOf("@", aliased.startsWith("@") ? 1 : 0);
    if (at === -1) {
      source = aliased;
      rest = "latest";
    } else {
      source = aliased.slice(0, at);
      rest = aliased.slice(at + 1);
    }
  }
  const protocol = /^([a-z+]+):/.exec(rest)?.[1];
  if (protocol) {
    const kinds: Record<string, string> = {
      workspace: "workspace: protocol",
      file: "file: dependency",
      link: "link: dependency",
      portal: "portal: dependency",
      patch: "patch: dependency",
      catalog: "catalog: protocol",
      http: "tarball URL",
      https: "tarball URL",
    };
    return { kind: "unsupported", what: kinds[protocol] ?? "git dependency" };
  }
  if (rest.includes("://") || rest.startsWith("git@")) {
    return { kind: "unsupported", what: "git dependency" };
  }
  if (rest === "" || rest === "*" || rest === "x") {
    return { kind: "range", source, range: "*" };
  }
  if (validRange(rest)) {
    return { kind: "range", source, range: rest };
  }
  if (/^[^@/\s]+\/[^\s]+$/.test(rest)) {
    return { kind: "unsupported", what: "git dependency" };
  }
  if (/^[A-Za-z][\w.-]*$/.test(rest)) {
    return { kind: "tag", source, tag: rest };
  }
  return { kind: "unsupported", what: `spec "${rest}"` };
}

/**
 * The version of `packument` that `range` (or `tag`) selects: the `latest`
 * dist-tag when it satisfies the range, else the highest satisfying version.
 * Null when none does.
 */
export function pickVersion(
  packument: Packument,
  spec: { range: string } | { tag: string },
): string | null {
  const versions = packument.versions;
  if ("tag" in spec) {
    const tagged = packument["dist-tags"][spec.tag];
    return tagged !== undefined && versions[tagged] ? tagged : null;
  }
  const exact = valid(spec.range);
  if (exact) {
    return versions[exact] ? exact : null;
  }
  const latest = packument["dist-tags"].latest;
  if (latest !== undefined && versions[latest] && satisfies(latest, spec.range)) {
    return latest;
  }
  return maxSatisfying(Object.keys(versions), spec.range);
}

/** Reads the simple `name → spec` forms of `overrides`, `pnpm.overrides` and `resolutions`. */
export function readOverrides(manifest: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const direct: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (deps && typeof deps === "object") {
      Object.assign(direct, deps);
    }
  }
  const add = (table: unknown, keyFilter: (key: string) => string | null) => {
    if (!table || typeof table !== "object") {
      return;
    }
    for (const [rawKey, value] of Object.entries(table as Record<string, unknown>)) {
      const key = keyFilter(rawKey);
      if (key === null || typeof value !== "string") {
        continue;
      }
      result[key] = value.startsWith("$") ? (direct[value.slice(1)] ?? value) : value;
    }
  };
  const plainName = (key: string) => (/^(@[^/@]+\/)?[^/@>]+$/.test(key) ? key : null);
  const pnpm = manifest.pnpm as { overrides?: unknown } | undefined;
  add(manifest.resolutions, (key) => plainName(key.replace(/^\*\*\//, "")));
  add(pnpm?.overrides, plainName);
  add(manifest.overrides, plainName);
  return result;
}

/** The key for a resolved package. */
export function nodeKey(name: string, version: PackageVersion): string {
  return name === version.name
    ? `${name}@${version.version}`
    : `${name}@npm:${version.name}@${version.version}`;
}

interface Selection {
  name: string;
  version: PackageVersion;
  range: string;
}

interface Edge {
  name: string;
  spec: string;
  /** Declared in `optionalDependencies` (or a companion). */
  optional: boolean;
  /** Somewhere below an optional edge: failures are warnings. */
  underOptional: boolean;
}

/** Resolves the whole dependency graph of a project. */
export async function resolveDependencies(options: ResolveOptions): Promise<ResolveResult> {
  const { registry } = options;
  const overrides = options.overrides ?? {};
  const warn = options.warn ?? (() => {});
  const nodes = new Map<string, ResolvedNode>();
  const selections = new Map<string, Promise<Selection | null>>();
  const root = new Map<string, string>();
  const requested = new Set(options.dependencies.map((dependency) => dependency.name));
  // The project's exact pins satisfy a dependency's range on the same name
  // without loading that name's packument (npm keeps the top-level copy too).
  const pins = new Map<string, string>();
  for (const dependency of options.dependencies) {
    const parsed = parseSpec(dependency.name, overrides[dependency.name] ?? dependency.spec);
    const exact =
      parsed.kind === "range" && parsed.source === dependency.name ? valid(parsed.range) : null;
    if (exact) {
      pins.set(dependency.name, exact);
    }
  }
  const preferPinned = (name: string, spec: string): string => {
    const pin = pins.get(name);
    if (pin === undefined) {
      return spec;
    }
    const parsed = parseSpec(name, spec);
    return parsed.kind === "range" && parsed.source === name && satisfies(pin, parsed.range)
      ? pin
      : spec;
  };

  /**
   * An exact version or a dist-tag is looked up as one small version document
   * instead of the whole packument (react's is megabytes), unless the packument
   * is already loaded. Null means "use the packument".
   */
  async function direct(source: string, spec: ParsedSpec): Promise<PackageVersion | null> {
    if (registry.hasPackument(source)) {
      return null;
    }
    if (spec.kind === "tag") {
      return registry.version(source, spec.tag);
    }
    const exact = spec.kind === "range" ? valid(spec.range) : null;
    return exact ? registry.version(source, exact) : null;
  }

  async function choose(name: string, source: string, spec: ParsedSpec): Promise<PackageVersion> {
    if (spec.kind === "unsupported") {
      throw new PmError("EUNSUPPORTED", `${name}: ${spec.what} is not supported by this installer`);
    }
    const request = spec.kind === "tag" ? { tag: spec.tag } : { range: spec.range };
    const wanted = spec.kind === "tag" ? spec.tag : spec.range;
    const substitution = substituteFor(source, wanted);
    if (!substitution) {
      const found = await direct(source, spec);
      if (found) {
        return found;
      }
      const packument = await registry.packument(source);
      const version = pickVersion(packument, request);
      if (version === null) {
        throw noMatch(source, wanted, packument);
      }
      return packument.versions[version];
    }
    if (spec.kind === "range" && !valid(spec.range)) {
      // A range: substitutes publish the original's versions, so the
      // substitute's own pick is the same version, without also loading the
      // original's packument. The original's small `latest` document tells
      // whether the substitute lags behind it.
      const [substitute, latest] = await Promise.all([
        registry.packument(substitution.source),
        registry.version(source, "latest").catch(() => null),
      ]);
      const picked = pickVersion(substitute, request);
      if (picked === null) {
        throw noMatch(substitution.source, wanted, substitute);
      }
      if (
        latest &&
        latest.version !== picked &&
        satisfies(latest.version, spec.range) &&
        gt(latest.version, picked)
      ) {
        warn(
          `${substitution.source}@${latest.version} does not exist; installing ${substitution.source}@${picked} as ${source}`,
        );
      }
      return substitute.versions[picked];
    }
    const originalDirect = await direct(source, spec);
    if (originalDirect) {
      const same = await direct(substitution.source, {
        kind: "range",
        source: substitution.source,
        range: originalDirect.version,
      });
      if (same) {
        return same;
      }
    }
    const [original, substitute] = await Promise.all([
      registry.packument(source),
      registry.packument(substitution.source),
    ]);
    const originalVersion = pickVersion(original, request);
    if (originalVersion === null) {
      throw noMatch(source, wanted, original);
    }
    if (substitute.versions[originalVersion]) {
      return substitute.versions[originalVersion];
    }
    const fallback =
      spec.kind === "range" ? maxSatisfying(Object.keys(substitute.versions), spec.range) : null;
    if (fallback === null) {
      throw new PmError(
        "ETARGET",
        `No ${substitution.source} version for ${source}@${originalVersion} (requested ${wanted})`,
        [`${source} is native and is installed from ${substitution.source} here.`],
      );
    }
    warn(
      `${substitution.source}@${originalVersion} does not exist; installing ${substitution.source}@${fallback} as ${source}`,
    );
    return substitute.versions[fallback];
  }

  function select(edge: Edge): Promise<Selection | null> {
    const memo = `${edge.name}\0${edge.spec}\0${edge.optional}`;
    let pending = selections.get(memo);
    if (!pending) {
      pending = (async () => {
        let name = edge.name;
        assertPackageName(name);
        const parsed = parseSpec(name, edge.spec);
        const source = parsed.kind === "unsupported" ? name : parsed.source;
        assertPackageName(source);
        if (!edge.optional && source === name) {
          const member = wasiFamilyMember(name);
          if (member) {
            name = member;
          }
        }
        const sourceName = name === edge.name ? source : name;
        const spec: ParsedSpec =
          parsed.kind === "unsupported" ? parsed : { ...parsed, source: sourceName };
        const version = await choose(name, sourceName, spec);
        const decision = platformDecision(version, edge.optional);
        if (decision !== "install") {
          if (!edge.optional && decision === "skip-platform" && version.name !== "fsevents") {
            warn(
              `Skipping ${version.name}@${version.version}: it does not support ${TARGET.os}/${TARGET.cpu}`,
            );
          }
          return null;
        }
        return {
          name,
          version,
          range: parsed.kind === "tag" ? parsed.tag : parsed.kind === "range" ? parsed.range : "",
        };
      })();
      selections.set(memo, pending);
    }
    return pending;
  }

  /**
   * Node key → whether its dependencies have been visited as required (true)
   * or only from below an optional edge (false). A failure below an optional
   * edge is only a warning, so a node first reached that way may be missing a
   * dependency; when a required path reaches it later, its dependencies are
   * visited again as required, and the same failure then fails the install.
   */
  const expandedAs = new Map<string, boolean>();

  async function visit(edge: Edge, parent: ResolvedNode | null): Promise<void> {
    const underOptional = edge.optional || edge.underOptional;
    let selection: Selection | null;
    try {
      selection = await select(edge);
    } catch (error) {
      if (underOptional && isPmError(error)) {
        warn(`Skipping optional dependency ${edge.name}@${edge.spec}: ${error.message}`);
        return;
      }
      throw error;
    }
    if (!selection) {
      return;
    }
    const key = nodeKey(selection.name, selection.version);
    if (parent) {
      parent.dependencies.set(selection.name, key);
      parent.ranges.set(selection.name, selection.range);
    } else {
      root.set(selection.name, key);
    }
    const expanded = expandedAs.get(key);
    if (expanded !== undefined) {
      if (expanded || underOptional) {
        return;
      }
      expandedAs.set(key, true);
      await expand(nodes.get(key)!, false);
      return;
    }
    expandedAs.set(key, !underOptional);
    const manifest = selection.version;
    const node: ResolvedNode = {
      key,
      name: selection.name,
      source: manifest.name,
      version: manifest.version,
      manifest,
      dependencies: new Map(),
      ranges: new Map(),
    };
    nodes.set(key, node);
    options.onResolved?.(node);
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      // A peer the project does not list is installed later from its range:
      // start loading its packument now.
      if (
        !requested.has(peer) &&
        !manifest.dependencies?.[peer] &&
        !manifest.peerDependenciesMeta?.[peer]?.optional &&
        isValidPackageName(peer) &&
        parseSpec(peer, range).kind === "range"
      ) {
        registry.prefetch(peer);
      }
    }
    await expand(node, underOptional);
  }

  /** Visits the dependencies of `node`. */
  async function expand(node: ResolvedNode, underOptional: boolean): Promise<void> {
    const manifest = node.manifest;
    const edges = new Map<string, Edge>();
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      edges.set(name, {
        name,
        spec: preferPinned(name, overrides[name] ?? spec),
        optional: false,
        underOptional,
      });
    }
    for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) {
      edges.set(name, {
        name,
        spec: preferPinned(name, overrides[name] ?? spec),
        optional: true,
        underOptional,
      });
    }
    const companion = companionOf(manifest.name);
    if (companion && !edges.has(companion.name)) {
      edges.set(companion.name, {
        name: companion.name,
        spec: manifest.version,
        optional: true,
        underOptional,
      });
    }
    await Promise.all([...edges.values()].map((child) => visit(child, node)));
  }

  const rootEdges = [...options.dependencies].sort((a, b) => compare(a.name, b.name));
  await Promise.all(
    rootEdges.map((dependency) =>
      visit(
        {
          name: dependency.name,
          spec: overrides[dependency.name] ?? dependency.spec,
          optional: dependency.type === "optional",
          underOptional: false,
        },
        null,
      ),
    ),
  );

  /**
   * A peer dependency is the copy the package's own dependent already has: when
   * `a` depends on `b` and on `c`, and `b` names `c` as a peer, `b` uses `a`'s
   * `c`. (napi's wasm runtime names the emnapi packages as peers, and the
   * binding that depends on it pins them; a second, newer emnapi beside the
   * pinned one does not load.)
   */
  const linkPeers = () => {
    const dependents = new Map<string, ResolvedNode[]>();
    for (const key of [...nodes.keys()].sort(compare)) {
      const node = nodes.get(key)!;
      for (const dependency of node.dependencies.values()) {
        const list = dependents.get(dependency) ?? [];
        list.push(node);
        dependents.set(dependency, list);
      }
    }
    const rootKeys = new Set(root.values());
    for (const key of [...nodes.keys()].sort(compare)) {
      const node = nodes.get(key)!;
      for (const [peer, range] of Object.entries(node.manifest.peerDependencies ?? {})) {
        if (node.dependencies.has(peer)) {
          continue;
        }
        let provided = rootKeys.has(key) ? root.get(peer) : undefined;
        for (const dependent of dependents.get(key) ?? []) {
          provided ??= dependent.dependencies.get(peer);
        }
        if (provided !== undefined && provided !== key) {
          node.dependencies.set(peer, provided);
          node.ranges.set(peer, range);
        }
      }
    }
  };

  // Missing peers are installed once, at the top level, as npm 7+ and pnpm do.
  const tried = new Set<string>();
  for (;;) {
    linkPeers();
    const missing = new Map<string, string>();
    for (const key of [...nodes.keys()].sort(compare)) {
      const node = nodes.get(key)!;
      const manifest = node.manifest;
      for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (
          manifest.peerDependenciesMeta?.[peer]?.optional ||
          node.dependencies.has(peer) ||
          root.has(peer) ||
          requested.has(peer) ||
          tried.has(peer) ||
          missing.has(peer)
        ) {
          continue;
        }
        missing.set(peer, preferPinned(peer, overrides[peer] ?? range));
      }
    }
    if (missing.size === 0) {
      break;
    }
    await Promise.all(
      [...missing].map(async ([name, spec]) => {
        tried.add(name);
        try {
          await visit({ name, spec, optional: false, underOptional: false }, null);
        } catch (error) {
          if (!isPmError(error)) {
            throw error;
          }
          warn(`Could not install peer dependency ${name}@${spec}: ${error.message}`);
        }
      }),
    );
  }

  // Dependencies are recorded in name order, whichever request finished first.
  for (const node of nodes.values()) {
    node.dependencies = sortMap(node.dependencies);
    node.ranges = sortMap(node.ranges);
  }
  return { root: sortMap(root), nodes };
}

function noMatch(name: string, wanted: string, packument: Packument): PmError {
  const latest = packument["dist-tags"].latest;
  return new PmError("ETARGET", `No matching version found for ${name}@${wanted}`, [
    latest ? `The latest release of ${name} is "${latest}".` : `${name} has no releases.`,
  ]);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortMap<V>(map: Map<string, V>): Map<string, V> {
  return new Map([...map].sort(([a], [b]) => compare(a, b)));
}
