// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LOCK_VERSION } from "./install";
import { PLAN_VERSION, decodePlan, encodePlan, planOf, resolvedFromPlan } from "./plan";
import type { DependencyPlan, ResolvedInstall } from "./plan";

const HASH = "a".repeat(64);
const ID_A = "1".repeat(64);
const ID_B = "2".repeat(64);

function samplePlan(): DependencyPlan {
  return {
    planVersion: PLAN_VERSION,
    lockfileVersion: LOCK_VERSION,
    manifestHash: HASH,
    packages: {
      "a@1.0.0": {
        name: "a",
        version: "1.0.0",
        tarball: "https://registry.test/a/-/a-1.0.0.tgz",
        integrity: "sha512-x",
        archive: ID_A,
        size: 1024,
      },
      "esbuild@npm:esbuild-wasm@0.21.5": {
        name: "esbuild",
        source: "esbuild-wasm",
        version: "0.21.5",
        tarball: "https://registry.test/esbuild-wasm/-/esbuild-wasm-0.21.5.tgz",
        shasum: "abc",
        archive: ID_B,
        size: 0,
      },
    },
    layout: [
      ["node_modules/a", "a@1.0.0"],
      ["node_modules/a/node_modules/esbuild", "esbuild@npm:esbuild-wasm@0.21.5"],
      ["node_modules/esbuild", "esbuild@npm:esbuild-wasm@0.21.5"],
    ],
    root: { esbuild: "esbuild@npm:esbuild-wasm@0.21.5", a: "a@1.0.0" },
    warnings: ["one", "two"],
  };
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("encodePlan", () => {
  it("gives the same bytes for the same plan, whatever order its keys were made in", () => {
    const plan = samplePlan();
    const reordered = JSON.parse(JSON.stringify(plan), function (_key, value: unknown) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).reverse());
      }
      return value;
    }) as DependencyPlan;
    expect(encodePlan(reordered)).toEqual(encodePlan(plan));
    const text = new TextDecoder().decode(encodePlan(plan));
    expect(text).not.toMatch(/\s"/);
    expect(text.startsWith('{"layout":')).toBe(true);
    // Keys that look like numbers are in order too, not first.
    expect(
      new TextDecoder().decode(encodePlan({ ...plan, root: { b: "a@1.0.0", "10": "a@1.0.0" } })),
    ).toContain('"root":{"10":"a@1.0.0","b":"a@1.0.0"}');
  });

  it("decodes what it encodes", () => {
    const plan = samplePlan();
    expect(decodePlan(encodePlan(plan), HASH)).toEqual(plan);
  });
});

describe("decodePlan", () => {
  const broken: [string, (plan: Record<string, any>) => void][] = [
    ["another plan version", (plan) => (plan.planVersion = 2)],
    ["another state-file version", (plan) => (plan.lockfileVersion = LOCK_VERSION + 1)],
    ["another manifest", (plan) => (plan.manifestHash = "b".repeat(64))],
    ["a location outside node_modules", (plan) => (plan.layout[0][0] = "node_modules/../src")],
    ["the project itself", (plan) => (plan.layout[0][0] = "node_modules")],
    ["a dot-led location", (plan) => (plan.layout[0][0] = "node_modules/.webnode-staging")],
    ["a location twice", (plan) => plan.layout.push(["node_modules/a", "a@1.0.0"])],
    ["a layout key it does not describe", (plan) => (plan.layout[0][1] = "b@1.0.0")],
    ["a root key it does not describe", (plan) => (plan.root.a = "b@1.0.0")],
    ["an archive that is not an id", (plan) => (plan.packages["a@1.0.0"].archive = "A".repeat(64))],
    ["a negative size", (plan) => (plan.packages["a@1.0.0"].size = -1)],
    ["a fractional size", (plan) => (plan.packages["a@1.0.0"].size = 1.5)],
    ["an unsafe size", (plan) => (plan.packages["a@1.0.0"].size = 2 ** 53)],
    [
      "a tarball over http",
      (plan) => (plan.packages["a@1.0.0"].tarball = "http://registry.test/a.tgz"),
    ],
    ["a tarball that is no URL", (plan) => (plan.packages["a@1.0.0"].tarball = "a.tgz")],
    ["a package with no name", (plan) => delete plan.packages["a@1.0.0"].name],
    ["a layout entry that is not a pair", (plan) => plan.layout.push(["node_modules/x"])],
    ["a warning that is not text", (plan) => plan.warnings.push(1)],
    ["no packages", (plan) => delete plan.packages],
  ];

  it.each(broken)("refuses %s", (_what, change) => {
    const plan = JSON.parse(JSON.stringify(samplePlan())) as Record<string, any>;
    change(plan);
    expect(decodePlan(bytesOf(plan), HASH)).toBeNull();
  });

  it("refuses bytes that are not a JSON object", () => {
    expect(decodePlan(new TextEncoder().encode("{ nope"), HASH)).toBeNull();
    expect(decodePlan(bytesOf([samplePlan()]), HASH)).toBeNull();
    expect(decodePlan(bytesOf(null), HASH)).toBeNull();
  });

  it("keeps only the fields it knows", () => {
    const plan = JSON.parse(JSON.stringify(samplePlan())) as Record<string, any>;
    plan.extra = true;
    plan.packages["a@1.0.0"].extra = true;
    expect(decodePlan(bytesOf(plan), HASH)).toEqual(samplePlan());
  });
});

describe("planOf and resolvedFromPlan", () => {
  it("make a plan of a resolution and give the same resolution back", () => {
    const plan = samplePlan();
    const resolved: ResolvedInstall = resolvedFromPlan(plan);
    expect([...resolved.root]).toEqual([
      ["a", "a@1.0.0"],
      ["esbuild", "esbuild@npm:esbuild-wasm@0.21.5"],
    ]);
    expect([...resolved.layout]).toEqual(plan.layout);
    expect(resolved.nodes.get("esbuild@npm:esbuild-wasm@0.21.5")).toEqual({
      key: "esbuild@npm:esbuild-wasm@0.21.5",
      name: "esbuild",
      source: "esbuild-wasm",
      version: "0.21.5",
      dist: { tarball: plan.packages["esbuild@npm:esbuild-wasm@0.21.5"].tarball, shasum: "abc" },
      archive: { id: ID_B, size: 0 },
    });
    const archives = new Map([...resolved.nodes].map(([key, pkg]) => [key, pkg.archive!] as const));
    const again = planOf({ manifestHash: HASH, resolved, archives, warnings: plan.warnings });
    expect(encodePlan(again)).toEqual(encodePlan(plan));
  });

  it("refuses to make a plan with a package that has no archive", () => {
    const resolved = resolvedFromPlan(samplePlan());
    expect(() =>
      planOf({ manifestHash: HASH, resolved, archives: new Map(), warnings: [] }),
    ).toThrow(/No archive/);
  });
});
