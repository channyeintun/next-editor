// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRegistryClient } from "./registry";
import { parseSpec, pickVersion, readOverrides, resolveDependencies } from "./resolve";
import type { RootDependency } from "./resolve";
import { createFakeRegistry } from "./testkit";
import type { FakePackage } from "./testkit";

async function resolveWith(
  packages: FakePackage[],
  dependencies: Record<string, string>,
  extra: { overrides?: Record<string, string>; tags?: Record<string, Record<string, string>> } = {},
) {
  const fake = await createFakeRegistry(packages, extra.tags);
  const registry = createRegistryClient({ fetch: fake.fetch, registry: fake.url });
  const warnings: string[] = [];
  const roots: RootDependency[] = Object.entries(dependencies).map(([name, spec]) => ({
    name,
    spec,
    type: "prod",
  }));
  const result = await resolveDependencies({
    registry,
    dependencies: roots,
    overrides: extra.overrides,
    warn: (message) => warnings.push(message),
  });
  return { ...result, warnings, fake, keys: [...result.nodes.keys()].sort() };
}

describe("parseSpec", () => {
  it("splits ranges, tags and aliases", () => {
    expect(parseSpec("a", "^1.2.0")).toEqual({ kind: "range", source: "a", range: "^1.2.0" });
    expect(parseSpec("a", "")).toEqual({ kind: "range", source: "a", range: "*" });
    expect(parseSpec("a", "next")).toEqual({ kind: "tag", source: "a", tag: "next" });
    expect(parseSpec("a", "npm:b@^2")).toEqual({ kind: "range", source: "b", range: "^2" });
    expect(parseSpec("a", "npm:@s/b@1.0.0")).toEqual({
      kind: "range",
      source: "@s/b",
      range: "1.0.0",
    });
    expect(parseSpec("a", "npm:b")).toEqual({ kind: "tag", source: "b", tag: "latest" });
  });

  it("names the specs it cannot install", () => {
    for (const spec of [
      "workspace:*",
      "file:../a",
      "link:../a",
      "github:u/r",
      "git+https://x/y.git",
      "u/r",
      "https://x/a.tgz",
    ]) {
      expect(parseSpec("a", spec).kind).toBe("unsupported");
    }
  });
});

describe("pickVersion", () => {
  const packument = {
    name: "a",
    "dist-tags": { latest: "1.2.0", next: "2.0.0-beta.1" },
    versions: Object.fromEntries(
      ["1.0.0", "1.2.0", "1.3.0", "2.0.0-beta.1"].map((version) => [
        version,
        { name: "a", version, dist: { tarball: "" } },
      ]),
    ),
  };

  it("prefers latest when it satisfies", () => {
    expect(pickVersion(packument, { range: "^1.0.0" })).toBe("1.2.0");
  });

  it("takes the highest satisfying version otherwise", () => {
    expect(pickVersion(packument, { range: ">=1.2.1 <2" })).toBe("1.3.0");
  });

  it("resolves exact versions and dist-tags", () => {
    expect(pickVersion(packument, { range: "1.0.0" })).toBe("1.0.0");
    expect(pickVersion(packument, { tag: "next" })).toBe("2.0.0-beta.1");
    expect(pickVersion(packument, { tag: "nope" })).toBeNull();
    expect(pickVersion(packument, { range: "^3.0.0" })).toBeNull();
  });
});

describe("readOverrides", () => {
  it("reads overrides, pnpm.overrides and resolutions", () => {
    expect(
      readOverrides({
        dependencies: { react: "^19.0.0" },
        overrides: { a: "1.0.0", b: { c: "1" }, react: "$react" },
        pnpm: { overrides: { d: "npm:e@2", "f@1>g": "1" } },
        resolutions: { "**/h": "3.0.0" },
      }),
    ).toEqual({ a: "1.0.0", react: "^19.0.0", d: "npm:e@2", h: "3.0.0" });
  });
});

describe("resolveDependencies", () => {
  it("follows dependencies and optional dependencies, not devDependencies", async () => {
    const { keys, root } = await resolveWith(
      [
        {
          name: "a",
          version: "1.0.0",
          dependencies: { b: "^1.0.0" },
          optionalDependencies: { c: "1" },
        },
        { name: "b", version: "1.1.0" },
        { name: "c", version: "1.0.0" },
      ],
      { a: "^1.0.0" },
    );
    expect(keys).toEqual(["a@1.0.0", "b@1.1.0", "c@1.0.0"]);
    expect([...root]).toEqual([["a", "a@1.0.0"]]);
  });

  it("resolves aliases under their own name", async () => {
    const { nodes, root } = await resolveWith([{ name: "real", version: "2.1.0" }], {
      alias: "npm:real@^2.0.0",
    });
    expect(root.get("alias")).toBe("alias@npm:real@2.1.0");
    expect(nodes.get("alias@npm:real@2.1.0")?.source).toBe("real");
  });

  it("applies overrides to transitive dependencies", async () => {
    const { keys } = await resolveWith(
      [
        { name: "a", version: "1.0.0", dependencies: { b: "^1.0.0" } },
        { name: "b", version: "1.0.0" },
        { name: "b", version: "2.0.0" },
      ],
      { a: "1.0.0" },
      { overrides: { b: "2.0.0" } },
    );
    expect(keys).toEqual(["a@1.0.0", "b@2.0.0"]);
  });

  it("resolves dist-tags", async () => {
    const { keys } = await resolveWith(
      [
        { name: "a", version: "1.0.0" },
        { name: "a", version: "2.0.0-rc.1" },
      ],
      { a: "next" },
      { tags: { a: { next: "2.0.0-rc.1" } } },
    );
    expect(keys).toEqual(["a@2.0.0-rc.1"]);
  });

  it("installs missing peers once at the top level and skips optional peers", async () => {
    const { root, keys } = await resolveWith(
      [
        {
          name: "plugin",
          version: "1.0.0",
          peerDependencies: { host: "^2.0.0", extra: "1" },
          peerDependenciesMeta: { extra: { optional: true } },
        },
        { name: "other", version: "1.0.0", peerDependencies: { host: "^2.1.0" } },
        { name: "host", version: "2.1.0" },
        { name: "extra", version: "1.0.0" },
      ],
      { plugin: "1.0.0", other: "1.0.0" },
    );
    expect(root.get("host")).toBe("host@2.1.0");
    expect(keys).not.toContain("extra@1.0.0");
  });

  it("does not add a peer the project already depends on", async () => {
    const { root } = await resolveWith(
      [
        { name: "plugin", version: "1.0.0", peerDependencies: { host: "^2.0.0" } },
        { name: "host", version: "2.0.0" },
        { name: "host", version: "2.5.0" },
      ],
      { plugin: "1.0.0", host: "2.0.0" },
    );
    expect(root.get("host")).toBe("host@2.0.0");
  });

  it("skips optional native binaries and keeps wasm32 builds", async () => {
    const { keys } = await resolveWith(
      [
        {
          name: "tool",
          version: "1.0.0",
          optionalDependencies: {
            "@tool/linux-x64": "1.0.0",
            "@tool/darwin-arm64": "1.0.0",
            "@tool/wasm32-wasi": "1.0.0",
            fsevents: "2.0.0",
          },
        },
        { name: "@tool/linux-x64", version: "1.0.0", os: ["linux"], cpu: ["x64"] },
        { name: "@tool/darwin-arm64", version: "1.0.0", os: ["darwin"], cpu: ["arm64"] },
        { name: "@tool/wasm32-wasi", version: "1.0.0", cpu: ["wasm32"] },
        { name: "fsevents", version: "2.0.0", os: ["darwin"] },
      ],
      { tool: "1.0.0" },
    );
    expect(keys).toEqual(["@tool/wasm32-wasi@1.0.0", "tool@1.0.0"]);
  });

  it("substitutes esbuild with esbuild-wasm at the same version", async () => {
    const { root, nodes } = await resolveWith(
      [
        {
          name: "esbuild",
          version: "0.21.5",
          optionalDependencies: { "@esbuild/linux-x64": "0.21.5" },
        },
        { name: "esbuild-wasm", version: "0.21.5" },
        { name: "esbuild-wasm", version: "0.21.4" },
      ],
      { esbuild: "^0.21.3" },
    );
    expect(root.get("esbuild")).toBe("esbuild@npm:esbuild-wasm@0.21.5");
    expect(nodes.get("esbuild@npm:esbuild-wasm@0.21.5")?.name).toBe("esbuild");
  });

  it("substitutes rollup 4, lightningcss, @swc/core and @parcel/watcher", async () => {
    const { root } = await resolveWith(
      [
        { name: "rollup", version: "4.20.0" },
        { name: "@rollup/wasm-node", version: "4.20.0" },
        { name: "lightningcss", version: "1.27.0" },
        { name: "lightningcss-wasm", version: "1.27.0" },
        { name: "@swc/core", version: "1.7.0" },
        { name: "@swc/wasm", version: "1.7.0" },
        { name: "@parcel/watcher", version: "2.4.1" },
        { name: "@parcel/watcher-wasm", version: "2.4.1" },
      ],
      {
        rollup: "^4.0.0",
        lightningcss: "^1.27.0",
        "@swc/core": "1.7.0",
        "@parcel/watcher": "^2.4.0",
      },
    );
    expect(root.get("rollup")).toBe("rollup@npm:@rollup/wasm-node@4.20.0");
    expect(root.get("lightningcss")).toBe("lightningcss@npm:lightningcss-wasm@1.27.0");
    expect(root.get("@swc/core")).toBe("@swc/core@npm:@swc/wasm@1.7.0");
    expect(root.get("@parcel/watcher")).toBe("@parcel/watcher@npm:@parcel/watcher-wasm@2.4.1");
  });

  it("falls back to the highest substitute in range and warns", async () => {
    const { root, warnings } = await resolveWith(
      [
        { name: "esbuild", version: "0.21.5" },
        { name: "esbuild-wasm", version: "0.21.4" },
      ],
      { esbuild: "^0.21.0" },
    );
    expect(root.get("esbuild")).toBe("esbuild@npm:esbuild-wasm@0.21.4");
    expect(warnings.join("\n")).toMatch(/esbuild-wasm@0\.21\.5 does not exist/);
  });

  it("adds @tailwindcss/oxide-wasm32-wasi beside @tailwindcss/oxide", async () => {
    const { nodes } = await resolveWith(
      [
        { name: "@tailwindcss/oxide", version: "4.1.0" },
        { name: "@tailwindcss/oxide-wasm32-wasi", version: "4.1.0", cpu: ["wasm32"] },
      ],
      { "@tailwindcss/oxide": "4.1.0" },
    );
    expect(
      nodes.get("@tailwindcss/oxide@4.1.0")?.dependencies.get("@tailwindcss/oxide-wasm32-wasi"),
    ).toBe("@tailwindcss/oxide-wasm32-wasi@4.1.0");
  });

  it("swaps a direct dependency on a platform family member for the wasm32-wasi member", async () => {
    const { nodes } = await resolveWith(
      [
        {
          name: "rolldown",
          version: "1.0.0",
          dependencies: { "@rolldown/binding-linux-x64-gnu": "1.0.0" },
        },
        { name: "@rolldown/binding-wasm32-wasi", version: "1.0.0", cpu: ["wasm32"] },
      ],
      { rolldown: "1.0.0" },
    );
    expect([...nodes.get("rolldown@1.0.0")!.dependencies]).toEqual([
      ["@rolldown/binding-wasm32-wasi", "@rolldown/binding-wasm32-wasi@1.0.0"],
    ]);
  });

  it("fails with E404 for a missing package and ETARGET for no matching version", async () => {
    await expect(resolveWith([], { nope: "1.0.0" })).rejects.toMatchObject({ code: "E404" });
    await expect(
      resolveWith([{ name: "a", version: "1.0.0" }], { a: "^2.0.0" }),
    ).rejects.toMatchObject({
      code: "ETARGET",
    });
  });

  it("names unsupported specs", async () => {
    await expect(resolveWith([], { local: "workspace:*" })).rejects.toThrow(
      /local: workspace: protocol/,
    );
  });

  it("warns instead of failing for a missing optional dependency", async () => {
    const { keys, warnings } = await resolveWith(
      [{ name: "a", version: "1.0.0", optionalDependencies: { gone: "1.0.0" } }],
      { a: "1.0.0" },
    );
    expect(keys).toEqual(["a@1.0.0"]);
    expect(warnings[0]).toMatch(/gone/);
  });

  it("reads exact versions and tags from version documents, not packuments", async () => {
    const { fake, root } = await resolveWith(
      [
        { name: "a", version: "1.0.0" },
        { name: "a", version: "2.0.0" },
        { name: "esbuild", version: "0.21.5" },
        { name: "esbuild-wasm", version: "0.21.5" },
        { name: "t", version: "3.0.0" },
      ],
      { a: "1.0.0", esbuild: "0.21.5", t: "latest" },
    );
    expect(root.get("esbuild")).toBe("esbuild@npm:esbuild-wasm@0.21.5");
    expect(fake.requests.map((url) => url.slice(fake.url.length))).toEqual(
      expect.arrayContaining(["/a/1.0.0", "/esbuild/0.21.5", "/esbuild-wasm/0.21.5", "/t/latest"]),
    );
    expect(fake.requests).toHaveLength(4);
  });

  it("lets the project's exact pin satisfy a dependency's range on the same name", async () => {
    const { keys, fake } = await resolveWith(
      [
        { name: "vitest", version: "2.1.8", dependencies: { vite: "^5.0.0" } },
        { name: "vite", version: "5.4.21" },
        { name: "vite", version: "5.4.22" },
      ],
      { vitest: "2.1.8", vite: "5.4.21" },
    );
    expect(keys).toEqual(["vite@5.4.21", "vitest@2.1.8"]);
    expect(fake.requests.some((url) => url.endsWith("/vite"))).toBe(false);
  });

  it("requests each packument once", async () => {
    const { fake } = await resolveWith(
      [
        { name: "a", version: "1.0.0", dependencies: { c: "^1.0.0" } },
        { name: "b", version: "1.0.0", dependencies: { c: "^1.0.0" } },
        { name: "c", version: "1.0.0" },
      ],
      { a: "1.0.0", b: "1.0.0" },
    );
    expect(fake.requests.filter((url) => url.endsWith("/c"))).toHaveLength(1);
  });
});

describe("registry client", () => {
  it("retries a failed request twice", async () => {
    let calls = 0;
    const registry = createRegistryClient({
      registry: "https://r.test/",
      fetch: async () => {
        calls++;
        if (calls < 3) {
          return new Response("busy", { status: 503 });
        }
        return new Response(JSON.stringify({ name: "a", "dist-tags": {}, versions: {} }));
      },
    });
    await expect(registry.packument("a")).resolves.toMatchObject({ name: "a" });
    expect(calls).toBe(3);
  });

  it("encodes scoped names and sends the abbreviated Accept header", async () => {
    const seen: { url: string; accept: string | null }[] = [];
    const registry = createRegistryClient({
      registry: "https://r.test",
      fetch: async (url, init) => {
        seen.push({ url, accept: new Headers(init?.headers).get("accept") });
        return new Response(JSON.stringify({ name: "@s/a", "dist-tags": {}, versions: {} }));
      },
    });
    await registry.packument("@s/a");
    expect(seen[0].url).toBe("https://r.test/@s%2Fa");
    expect(seen[0].accept).toMatch(/application\/vnd\.npm\.install-v1\+json/);
  });
});

describe("resolveDependencies: review fixes", () => {
  it("refuses dependency names and alias targets that are not package names", async () => {
    const packages: FakePackage[] = [
      { name: "evil", version: "1.0.0", dependencies: { "..": "npm:payload@1.0.0" } },
      { name: "payload", version: "1.0.0" },
    ];
    await expect(resolveWith(packages, { evil: "1.0.0" })).rejects.toMatchObject({
      code: "EINVALIDPACKAGENAME",
    });
    for (const name of ["../../src", "@../x", "_x", ".x", "a/b"]) {
      await expect(resolveWith(packages, { [name]: "npm:payload@1.0.0" })).rejects.toMatchObject({
        code: "EINVALIDPACKAGENAME",
      });
    }
    await expect(resolveWith(packages, { ok: "npm:../payload@1.0.0" })).rejects.toMatchObject({
      code: "EINVALIDPACKAGENAME",
    });
  });

  it("skips an invalid name below an optional edge with a warning", async () => {
    const { keys, warnings } = await resolveWith(
      [
        { name: "a", version: "1.0.0", optionalDependencies: { "../x": "npm:b@1.0.0" } },
        { name: "b", version: "1.0.0" },
      ],
      { a: "1.0.0" },
    );
    expect(keys).toEqual(["a@1.0.0"]);
    expect(warnings.join("\n")).toMatch(/Invalid package name/);
  });

  it("fails a required path through a node whose dependency failed under an optional edge", async () => {
    const fake = await createFakeRegistry([
      { name: "a", version: "1.0.0", dependencies: { c: "^1.0.0" } },
      { name: "b", version: "1.0.0", dependencies: { c: "^1.0.0" } },
      { name: "c", version: "1.0.0", dependencies: { d: "^9.0.0" } },
      { name: "d", version: "1.0.0" },
    ]);
    const registry = createRegistryClient({ fetch: fake.fetch, registry: fake.url });
    await expect(
      resolveDependencies({
        registry,
        dependencies: [
          { name: "a", spec: "1.0.0", type: "optional" },
          { name: "b", spec: "1.0.0", type: "prod" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ETARGET" });
  });

  it("applies an override to the project's own dependency too", async () => {
    const { root, keys } = await resolveWith(
      [
        { name: "react", version: "18.2.0" },
        { name: "react", version: "18.3.1" },
        { name: "lib", version: "1.0.0", dependencies: { react: "^18.0.0" } },
      ],
      { react: "^18.0.0", lib: "1.0.0" },
      { overrides: { react: "18.2.0" } },
    );
    expect(root.get("react")).toBe("react@18.2.0");
    expect(keys).toEqual(["lib@1.0.0", "react@18.2.0"]);
  });

  it("substitutes rollup for a wide range that resolves to 4", async () => {
    const { root } = await resolveWith(
      [
        { name: "rollup", version: "3.29.0" },
        { name: "rollup", version: "4.20.0" },
        { name: "@rollup/wasm-node", version: "4.20.0" },
      ],
      { rollup: "*" },
    );
    expect(root.get("rollup")).toBe("rollup@npm:@rollup/wasm-node@4.20.0");
  });
});
