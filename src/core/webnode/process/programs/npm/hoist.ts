// npm-style hoisting, as a pure function: places every package of a resolved
// graph at the highest `node_modules` where Node's lookup from each dependent
// still finds the version that dependent resolved to. A conflicting version
// nests under its dependent. Breadth-first, names in order: deterministic.
import { PmError } from "./errors";

/** What hoisting needs to know about a package: its name and its dependency edges. */
export interface HoistNode {
  name: string;
  /** Dependency name → key of the node it resolved to. */
  dependencies: Map<string, string>;
  /**
   * The dependency names that are peer edges: they must resolve to the very
   * copy the package's dependent has, so the package is placed where that copy
   * is the one Node's lookup finds.
   */
  peers?: ReadonlySet<string>;
}

export interface HoistInput {
  /** The project's top-level edges: name → node key. */
  root: Map<string, string>;
  nodes: Map<string, HoistNode>;
}

/** Location (relative to the project, e.g. `node_modules/a/node_modules/b`) → node key, in location order. */
export type Layout = Map<string, string>;

interface Level {
  /** "" for the project; otherwise the package's location. */
  location: string;
  /** The key of the package at `location` ("" for the project). */
  key: string;
  parent: Level | null;
  /** Name → key of the package placed in this level's node_modules. */
  placed: Map<string, string>;
  /** Name → key that some package below resolves through this level to a higher one. */
  passing: Map<string, string>;
}

/** The location of package `name` in `level`'s node_modules. */
function childLocation(level: string, name: string): string {
  return level === "" ? `node_modules/${name}` : `${level}/node_modules/${name}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lays out a resolved graph into node_modules directories. */
export function hoist(input: HoistInput): Layout {
  const rootLevel: Level = {
    location: "",
    key: "",
    parent: null,
    placed: new Map(),
    passing: new Map(),
  };
  const queue: { level: Level; key: string }[] = [];
  const layout = new Map<string, string>();

  const place = (level: Level, name: string, key: string) => {
    // A copy of a package inside its own subtree repeats that subtree, and so
    // on without end (a@1 → b@1 → a@2 → b@2 → a@1): no node_modules layout
    // gives every package the version it resolved to.
    for (let above: Level | null = level; above; above = above.parent) {
      if (above.key === key) {
        throw new PmError(
          "EOTHER",
          `Cannot lay out a dependency cycle: ${key} would be nested inside itself at ${childLocation(level.location, name)}`,
        );
      }
    }
    level.placed.set(name, key);
    const location = childLocation(level.location, name);
    layout.set(location, key);
    queue.push({
      level: { location, key, parent: level, placed: new Map(), passing: new Map() },
      key,
    });
  };

  /** True when, from `level` upward, each of `key`'s peers is the copy it was linked to. */
  const peersVisible = (levels: Level[], from: number, key: string): boolean => {
    const node = input.nodes.get(key);
    for (const peer of node?.peers ?? []) {
      const wanted = node!.dependencies.get(peer);
      for (let i = from; i < levels.length; i++) {
        const placed = levels[i].placed.get(peer);
        if (placed !== undefined) {
          if (placed !== wanted) {
            return false;
          }
          break;
        }
      }
    }
    return true;
  };

  for (const [name, key] of [...input.root].sort(([a], [b]) => compare(a, b))) {
    place(rootLevel, name, key);
  }

  for (let index = 0; index < queue.length; index++) {
    const { level: from, key } = queue[index];
    const node = input.nodes.get(key);
    if (!node) {
      continue;
    }
    for (const [name, wanted] of [...node.dependencies].sort(([a], [b]) => compare(a, b))) {
      // The levels Node's lookup walks from this package, nearest first.
      const levels: Level[] = [];
      for (let level: Level | null = from; level; level = level.parent) {
        levels.push(level);
      }
      let found = levels.length;
      for (let i = 0; i < levels.length; i++) {
        if (levels[i].placed.has(name)) {
          found = i;
          break;
        }
      }
      if (found < levels.length && levels[found].placed.get(name) === wanted) {
        for (let i = 0; i < found; i++) {
          levels[i].passing.set(name, wanted);
        }
        continue;
      }
      // Highest level below `found` where placing it breaks no one passing
      // through and where its peers are its dependent's copies. When no level
      // gives it those peers (two dependents with different copies), the
      // first rule alone decides.
      let target = -1;
      let highest = -1;
      for (let i = found - 1; i >= 0; i--) {
        const passing = levels[i].passing.get(name);
        if (passing === undefined || passing === wanted) {
          if (highest === -1) {
            highest = i;
          }
          if (peersVisible(levels, i, wanted)) {
            target = i;
            break;
          }
        }
      }
      if (target === -1) {
        target = Math.max(highest, 0);
      }
      for (let i = 0; i < target; i++) {
        levels[i].passing.set(name, wanted);
      }
      place(levels[target], name, wanted);
    }
  }

  return new Map([...layout].sort(([a], [b]) => compare(a, b)));
}

/**
 * The location Node's lookup finds for `name` when required from the package
 * at `from` ("" for the project), or null.
 */
export function lookup(layout: Layout, from: string, name: string): string | null {
  let level: string | null = from;
  while (level !== null) {
    const candidate = childLocation(level, name);
    if (layout.has(candidate)) {
      return candidate;
    }
    level = parentLevel(level);
  }
  return null;
}

/** The package location that contains `location`'s node_modules, "" for the project, null above it. */
function parentLevel(location: string): string | null {
  if (location === "") {
    return null;
  }
  const index = location.lastIndexOf("/node_modules/");
  return index === -1 ? "" : location.slice(0, index);
}
