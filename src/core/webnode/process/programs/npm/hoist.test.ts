// @vitest-environment node
import satisfies from "semver/functions/satisfies";
import { describe, expect, it } from "vitest";
import { hoist, lookup } from "./hoist";
import type { HoistInput, Layout } from "./hoist";

interface Spec {
  /** key → { dependency name → [range, resolved key] } */
  [key: string]: Record<string, [string, string]>;
}

function graph(root: Record<string, string>, spec: Spec): HoistInput & { ranges: Spec } {
  const nodes = new Map(
    Object.entries(spec).map(([key, deps]) => [
      key,
      {
        name: key.slice(0, key.lastIndexOf("@")),
        dependencies: new Map(Object.entries(deps).map(([name, [, target]]) => [name, target])),
      },
    ]),
  );
  return { root: new Map(Object.entries(root)), nodes, ranges: spec };
}

const versionOf = (key: string) => key.slice(key.lastIndexOf("@") + 1);

/** Every dependency of every placed package resolves to a version its range accepts. */
function assertResolvable(input: ReturnType<typeof graph>, layout: Layout): void {
  for (const [name, key] of input.root) {
    expect(layout.get(lookup(layout, "", name)!)).toBe(key);
  }
  for (const [location, key] of layout) {
    for (const [name, [range]] of Object.entries(input.ranges[key] ?? {})) {
      const found = lookup(layout, location, name);
      expect(found, `${location} requires ${name}`).not.toBeNull();
      expect(satisfies(versionOf(layout.get(found!)!), range), `${location} → ${found}`).toBe(true);
    }
  }
}

describe("hoist", () => {
  it("flattens a tree without conflicts", () => {
    const input = graph(
      { a: "a@1.0.0", b: "b@1.0.0" },
      {
        "a@1.0.0": { c: ["^1.0.0", "c@1.2.0"] },
        "b@1.0.0": { c: ["^1.1.0", "c@1.2.0"] },
        "c@1.2.0": {},
      },
    );
    const layout = hoist(input);
    expect([...layout]).toEqual([
      ["node_modules/a", "a@1.0.0"],
      ["node_modules/b", "b@1.0.0"],
      ["node_modules/c", "c@1.2.0"],
    ]);
    assertResolvable(input, layout);
  });

  it("nests a conflicting version under its dependent", () => {
    const input = graph(
      { a: "a@1.0.0", c: "c@2.0.0" },
      {
        "a@1.0.0": { c: ["^1.0.0", "c@1.0.0"] },
        "c@1.0.0": {},
        "c@2.0.0": {},
      },
    );
    const layout = hoist(input);
    expect(layout.get("node_modules/c")).toBe("c@2.0.0");
    expect(layout.get("node_modules/a/node_modules/c")).toBe("c@1.0.0");
    assertResolvable(input, layout);
  });

  it("does not shadow a version a deeper package resolves through a level", () => {
    // d@1 holds the root. a's own d@2 nests under a; c (hoisted to the root
    // beside a) cannot see a's copy, so it gets its own nested d@2.
    const input = graph(
      { a: "a@1.0.0", d: "d@1.0.0" },
      {
        "a@1.0.0": { b: ["1", "b@1.0.0"], c: ["1", "c@1.0.0"], d: ["^2.0.0", "d@2.0.0"] },
        "b@1.0.0": { d: ["^1.0.0", "d@1.0.0"] },
        "c@1.0.0": { d: ["^2.0.0", "d@2.0.0"] },
        "d@1.0.0": {},
        "d@2.0.0": {},
      },
    );
    const layout = hoist(input);
    expect(layout.get("node_modules/d")).toBe("d@1.0.0");
    expect(layout.get("node_modules/a/node_modules/d")).toBe("d@2.0.0");
    expect(layout.get("node_modules/c/node_modules/d")).toBe("d@2.0.0");
    assertResolvable(input, layout);
  });

  it("handles scoped names and cycles", () => {
    const input = graph(
      { "@s/a": "@s/a@1.0.0" },
      {
        "@s/a@1.0.0": { "@s/b": ["1", "@s/b@1.0.0"] },
        "@s/b@1.0.0": { "@s/a": ["1", "@s/a@1.0.0"], x: ["1", "x@1.0.0"] },
        "x@1.0.0": {},
      },
    );
    const layout = hoist(input);
    expect([...layout.keys()]).toEqual([
      "node_modules/@s/a",
      "node_modules/@s/b",
      "node_modules/x",
    ]);
    assertResolvable(input, layout);
  });

  it("places a package beside the copy of its peer that its dependent has", () => {
    // x depends on react@19 and on y, whose peer react is x's copy. y may not
    // sit at the root, where react@18 is visible: that would nest a second
    // react@19 under y, and x and y would load two Reacts.
    const nodes = new Map([
      [
        "x@1",
        {
          name: "x",
          dependencies: new Map([
            ["react", "react@19"],
            ["y", "y@1"],
          ]),
        },
      ],
      [
        "y@1",
        { name: "y", dependencies: new Map([["react", "react@19"]]), peers: new Set(["react"]) },
      ],
      ["react@18", { name: "react", dependencies: new Map() }],
      ["react@19", { name: "react", dependencies: new Map() }],
    ]);
    const layout = hoist({
      root: new Map([
        ["react", "react@18"],
        ["x", "x@1"],
      ]),
      nodes,
    });
    expect([...layout]).toEqual([
      ["node_modules/react", "react@18"],
      ["node_modules/x", "x@1"],
      ["node_modules/x/node_modules/react", "react@19"],
      ["node_modules/x/node_modules/y", "y@1"],
    ]);
    // With no conflict in the way the package is still hoisted.
    const flat = hoist({ root: new Map([["x", "x@1"]]), nodes });
    expect([...flat.keys()]).toEqual(["node_modules/react", "node_modules/x", "node_modules/y"]);
  });

  it("ends on a cycle between different versions", () => {
    const node = (name: string, deps: Record<string, string>) => ({
      name,
      dependencies: new Map(Object.entries(deps)),
    });
    const nodes = new Map([
      ["a@1", node("a", { b: "b@1" })],
      ["b@1", node("b", { a: "a@2" })],
      ["a@2", node("a", { b: "b@2" })],
      ["b@2", node("b", { a: "a@1" })],
    ]);
    // No finite node_modules tree gives each copy its version: every copy of
    // a@1 hides b@1 behind a b@2, and so on. It reports the cycle at once.
    expect(() => hoist({ root: new Map([["a", "a@1"]]), nodes })).toThrow(
      /dependency cycle: b@1 would be nested inside itself/,
    );
    // A cycle between the same versions reuses the copies above it.
    nodes.set("b@1", node("b", { a: "a@1" }));
    expect([...hoist({ root: new Map([["a", "a@1"]]), nodes }).keys()]).toEqual([
      "node_modules/a",
      "node_modules/b",
    ]);
  }, 2000);

  it("is deterministic and survives a randomized stress graph", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const names = ["p", "q", "r", "s", "t", "u"];
    const spec: Spec = {};
    for (const name of names) {
      for (const major of [1, 2, 3]) {
        spec[`${name}@${major}.0.0`] = {};
      }
    }
    for (const key of Object.keys(spec)) {
      const own = key.slice(0, key.indexOf("@"));
      for (const name of names) {
        if (name > own && random() < 0.5) {
          const major = 1 + Math.floor(random() * 3);
          spec[key][name] = [`^${major}.0.0`, `${name}@${major}.0.0`];
        }
      }
    }
    const input = graph({ p: "p@1.0.0", q: "q@2.0.0", r: "r@3.0.0" }, spec);
    const first = hoist(input);
    assertResolvable(input, first);
    expect([...hoist(input)]).toEqual([...first]);
  });
});
