// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { setRuntime } from "../../runtime";
import type { SpawnRequest } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import type { FakeRuntime } from "../../testing/fakeRuntime";
import { LOCK_NAME, install } from "./install";
import { Reporter, createRuntimeSink } from "./output";
import type { Tool } from "./output";
import { createRegistryClient } from "./registry";
import type { TarballCache } from "./registry";
import { createFakeRegistry } from "./testkit";
import type { FakePackage } from "./testkit";

const PACKAGES: FakePackage[] = [
  {
    name: "react-dom",
    version: "19.0.0",
    dependencies: { scheduler: "^0.25.0" },
    peerDependencies: { react: "^19.0.0" },
    files: { "index.js": "module.exports = 'react-dom';" },
  },
  { name: "react", version: "19.0.0", files: { "index.js": "module.exports = 'react';" } },
  { name: "scheduler", version: "0.25.0" },
  {
    name: "vite",
    version: "5.4.21",
    bin: { vite: "bin/vite.js" },
    dependencies: { esbuild: "^0.21.3", rollup: "^4.20.0", nanoid: "^3.3.7" },
    files: { "bin/vite.js": "#!/usr/bin/env node\nconsole.log('vite')" },
  },
  { name: "esbuild", version: "0.21.5", scripts: { postinstall: "node install.js" } },
  {
    name: "esbuild-wasm",
    version: "0.21.5",
    bin: { esbuild: "bin/esbuild" },
    files: { "bin/esbuild": { data: "#!/usr/bin/env node", mode: 0o755 } },
  },
  { name: "rollup", version: "4.24.0" },
  { name: "@rollup/wasm-node", version: "4.24.0", optionalDependencies: { fsevents: "~2.3.2" } },
  { name: "fsevents", version: "2.3.3", os: ["darwin"] },
  { name: "nanoid", version: "3.3.7", bin: "bin/nanoid.cjs", files: { "bin/nanoid.cjs": "" } },
  { name: "nanoid", version: "5.0.9" },
  { name: "postcss", version: "8.4.49", dependencies: { nanoid: "^5.0.0" } },
  { name: "sharp", version: "0.33.0", scripts: { install: "node build.js" } },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Setup {
  rt: FakeRuntime;
  spawned: SpawnRequest[];
  run: (options?: {
    tool?: Tool;
    cache?: TarballCache;
    force?: boolean;
  }) => ReturnType<typeof install>;
  fake: Awaited<ReturnType<typeof createFakeRegistry>>;
  read: (path: string) => string;
  writeManifest: (manifest: Record<string, unknown>) => void;
}

async function setup(
  manifest: Record<string, unknown>,
  options: { tty?: boolean; status?: (request: SpawnRequest) => number } = {},
): Promise<Setup> {
  const spawned: SpawnRequest[] = [];
  const rt = createFakeRuntime({
    cwd: "/project",
    tty: options.tty,
    spawn: (request) => {
      spawned.push(request);
      return options.status?.(request) ?? 0;
    },
  });
  rt.vfs.mkdir("/project", true, 0o755);
  const writeManifest = (next: Record<string, unknown>) =>
    rt.fs.writeFile(
      "/project/package.json",
      encoder.encode(JSON.stringify(next, null, 2)),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
  writeManifest(manifest);
  setRuntime(rt);
  const fake = await createFakeRegistry(PACKAGES);
  return {
    rt,
    spawned,
    fake,
    writeManifest,
    read: (path) => decoder.decode(rt.fs.readFile(path)),
    run: async ({ tool = "pnpm", cache, force } = {}) => {
      const registry = createRegistryClient({ fetch: fake.fetch, registry: fake.url, cache });
      const result = await install({
        projectDir: "/project",
        registry,
        reporter: new Reporter(tool, createRuntimeSink()),
        force,
      });
      return result;
    },
  };
}

afterEach(() => setRuntime(null));

const APP = {
  name: "app",
  version: "0.0.0",
  dependencies: { "react-dom": "19.0.0", react: "19.0.0" },
  devDependencies: { vite: "5.4.21", postcss: "8.4.49" },
};

describe("install", () => {
  it("lays out, extracts and links a project", async () => {
    const { rt, run, read } = await setup(APP);
    const result = await run();
    expect(result.status).toBe(0);
    expect(read("/project/node_modules/react/index.js")).toBe("module.exports = 'react';");
    // esbuild is installed from esbuild-wasm, under its own name.
    expect(JSON.parse(read("/project/node_modules/esbuild/package.json")).name).toBe(
      "esbuild-wasm",
    );
    expect(JSON.parse(read("/project/node_modules/rollup/package.json")).name).toBe(
      "@rollup/wasm-node",
    );
    expect(rt.fs.exists("/project/node_modules/fsevents")).toBe(false);
    // postcss comes first by name: its nanoid 5 takes the top, vite's nanoid 3 nests.
    expect(JSON.parse(read("/project/node_modules/nanoid/package.json")).version).toBe("5.0.9");
    expect(
      JSON.parse(read("/project/node_modules/vite/node_modules/nanoid/package.json")).version,
    ).toBe("3.3.7");
    // Bins are relative symlinks, and their targets are executable.
    expect(rt.fs.readlink("/project/node_modules/.bin/vite")).toBe("../vite/bin/vite.js");
    expect(rt.fs.readlink("/project/node_modules/.bin/esbuild")).toBe("../esbuild/bin/esbuild");
    expect(rt.fs.readlink("/project/node_modules/vite/node_modules/.bin/nanoid")).toBe(
      "../nanoid/bin/nanoid.cjs",
    );
    expect(rt.fs.stat("/project/node_modules/vite/bin/vite.js", true).mode & 0o111).toBe(0o111);
    expect(rt.fs.stat("/project/node_modules/esbuild/bin/esbuild", true).mode & 0o100).toBe(0o100);
    expect(rt.fs.stat("/project/node_modules/react/index.js", true).mode & 0o111).toBe(0);
    // State lives in node_modules; nothing is written beside package.json.
    const lock = JSON.parse(read(`/project/node_modules/${LOCK_NAME}`));
    expect(lock.packages["node_modules/esbuild"]).toMatchObject({
      source: "esbuild-wasm",
      version: "0.21.5",
    });
    expect(rt.fs.readdir("/project").map((entry) => entry.name)).toEqual([
      "node_modules",
      "package.json",
    ]);
    expect(rt.fs.exists("/project/node_modules/.webnode-staging")).toBe(false);
  });

  it("prints pnpm's summary and the ignored build scripts", async () => {
    const { rt, run, writeManifest } = await setup(APP);
    writeManifest({ ...APP, dependencies: { ...APP.dependencies, sharp: "0.33.0" } });
    await run();
    const out = rt.stdout();
    expect(out).toMatch(/^Progress: resolved 10, reused 0, downloaded 10, added 10, done$/m);
    expect(out).toContain("Ignored build scripts: sharp.");
    expect(out).toMatch(/Packages: \+10\n\+{10}\n/);
    expect(out).toContain("dependencies:\n+ react 19.0.0\n+ react-dom 19.0.0\n+ sharp 0.33.0\n");
    expect(out).toContain("devDependencies:\n+ postcss 8.4.49\n+ vite 5.4.21\n");
    expect(out).toMatch(/\nDone in \d+(ms|\.\ds)\n$/);
  });

  it("redraws pnpm progress in place on a terminal", async () => {
    const { rt, run } = await setup({ dependencies: { react: "19.0.0" } }, { tty: true });
    await run();
    expect(rt.stdout()).toContain(
      "\x1b[2K\x1b[1GProgress: resolved 1, reused 0, downloaded 1, added 1, done\n",
    );
  });

  it("installs a project that has no dependencies", async () => {
    const { rt, run } = await setup({});
    expect((await run()).status).toBe(0);
    expect(rt.vfs.exists("/project/node_modules/.webnode-lock.json")).toBe(true);
  });

  it("prints npm's and yarn's summaries", async () => {
    const npm = await setup({ dependencies: { react: "19.0.0" } });
    await npm.run({ tool: "npm" });
    expect(npm.rt.stdout()).toMatch(/^\nadded 1 package in \d+m?s\n$/);

    const yarn = await setup({ dependencies: { react: "19.0.0" } });
    await yarn.run({ tool: "yarn" });
    expect(yarn.rt.stdout()).toMatch(
      /^yarn install v1\.22\.22\n\[1\/4\] Resolving packages\.\.\.\n\[2\/4\] Fetching packages\.\.\.\n\[3\/4\] Linking dependencies\.\.\.\n\[4\/4\] Building fresh packages\.\.\.\nDone in \d+\.\d\ds\.\n$/,
    );
  });

  it("finishes at once when nothing changed", async () => {
    const { rt, run, fake } = await setup(APP);
    await run();
    const requests = fake.requests.length;
    const result = await run();
    expect(result.upToDate).toBe(true);
    expect(fake.requests.length).toBe(requests);
    expect(rt.stdout()).toContain("Already up to date");
  });

  it("reinstalls when a recorded package directory is gone", async () => {
    const { rt, run } = await setup(APP);
    await run();
    rt.fs.rm("/project/node_modules/react", true, false);
    const result = await run();
    expect(result.upToDate).toBe(false);
    expect(rt.fs.exists("/project/node_modules/react/index.js")).toBe(true);
  });

  it("keeps unchanged packages and removes dropped ones on a later install", async () => {
    const { rt, run, fake, writeManifest } = await setup(APP);
    await run();
    writeManifest({ ...APP, devDependencies: { vite: "5.4.21" } });
    const before = fake.requests.length;
    await run();
    expect(fake.requests.slice(before).filter((url) => url.endsWith(".tgz"))).toEqual([]);
    expect(rt.fs.exists("/project/node_modules/postcss")).toBe(false);
    expect(rt.fs.exists("/project/node_modules/vite/bin/vite.js")).toBe(true);
    expect(rt.fs.readlink("/project/node_modules/.bin/vite")).toBe("../vite/bin/vite.js");
  });

  it("moves a kept package when its location changes", async () => {
    const { rt, run, fake, writeManifest } = await setup({ dependencies: { vite: "5.4.21" } });
    await run();
    const version = (path: string) => JSON.parse(decoder.decode(rt.fs.readFile(path))).version;
    expect(version("/project/node_modules/nanoid/package.json")).toBe("3.3.7");
    writeManifest({ dependencies: { postcss: "8.4.49", vite: "5.4.21" } });
    const before = fake.requests.length;
    await run();
    expect(version("/project/node_modules/nanoid/package.json")).toBe("5.0.9");
    expect(version("/project/node_modules/vite/node_modules/nanoid/package.json")).toBe("3.3.7");
    expect(fake.requests.slice(before).filter((url) => url.includes("nanoid-3"))).toEqual([]);
    expect(rt.fs.readlink("/project/node_modules/vite/node_modules/.bin/nanoid")).toBe(
      "../nanoid/bin/nanoid.cjs",
    );
    expect(rt.fs.exists("/project/node_modules/.bin/nanoid")).toBe(false);
  });

  it("fails on an integrity mismatch without touching node_modules", async () => {
    const { run, fake, rt } = await setup({ dependencies: { bad: "1.0.0" } });
    await fake.add({ name: "bad", version: "1.0.0", corrupt: true });
    await expect(run()).rejects.toMatchObject({ code: "EINTEGRITY" });
    expect(rt.fs.exists("/project/node_modules/bad")).toBe(false);
  });

  it("reads tarballs from the cache and counts them as reused", async () => {
    const store = new Map<string, Uint8Array>();
    const cache: TarballCache = {
      match: async (url) => {
        const bytes = store.get(url);
        return bytes ? new Response(bytes.slice().buffer) : undefined;
      },
      put: async (url, response) => {
        store.set(url, new Uint8Array(await response.arrayBuffer()));
      },
      delete: async (url) => store.delete(url),
    };
    const first = await setup({ dependencies: { react: "19.0.0" } });
    await first.run({ cache });
    await Promise.resolve();
    const second = await setup({ dependencies: { react: "19.0.0" } });
    await second.run({ cache });
    expect(second.fake.requests.some((url) => url.endsWith(".tgz"))).toBe(false);
    expect(second.rt.stdout()).toMatch(/reused 1, downloaded 0, added 1/);
  });

  it("runs the root project's lifecycle scripts through the shell", async () => {
    const { run, spawned } = await setup({
      name: "app",
      dependencies: { react: "19.0.0" },
      scripts: { postinstall: "echo done", prepare: "husky" },
    });
    await run();
    expect(spawned.map((request) => [request.command, ...request.args])).toEqual([
      ["sh", "-c", "echo done"],
      ["sh", "-c", "husky"],
    ]);
    expect(spawned[0].env.npm_lifecycle_event).toBe("postinstall");
  });

  it("reports a missing or broken package.json", async () => {
    const { rt, run } = await setup({});
    rt.fs.writeFile("/project/package.json", encoder.encode("{ nope"), O_WRONLY | O_TRUNC, 0o644);
    await expect(run()).rejects.toMatchObject({ code: "EJSONPARSE" });
    rt.fs.unlink("/project/package.json");
    await expect(run()).rejects.toMatchObject({ code: "ENOPKG" });
  });

  it("re-resolves on update even when the state file matches", async () => {
    const { run, fake, read } = await setup({ dependencies: { nanoid: "^5.0.0" } });
    await run();
    await fake.add({ name: "nanoid", version: "5.1.0" });
    expect((await run()).upToDate).toBe(true);
    const result = await run({ force: true });
    expect(result.upToDate).toBe(false);
    expect(JSON.parse(read("/project/node_modules/nanoid/package.json")).version).toBe("5.1.0");
  });

  it("runs the root lifecycle scripts when nothing changed too", async () => {
    const { run, spawned } = await setup({
      dependencies: { react: "19.0.0" },
      scripts: { preinstall: "echo pre", postinstall: "echo post" },
    });
    await run();
    spawned.length = 0;
    const result = await run();
    expect(result.upToDate).toBe(true);
    expect(spawned.map((request) => request.args[1])).toEqual(["echo pre", "echo post"]);
  });

  it("runs preinstall before resolving, and stops when it fails", async () => {
    const { rt, run, fake, spawned } = await setup(
      { dependencies: { react: "19.0.0" }, scripts: { preinstall: "exit 3", postinstall: "x" } },
      { status: (request) => (request.args[1] === "exit 3" ? 3 : 0) },
    );
    const result = await run();
    expect(result.status).toBe(3);
    expect(fake.requests).toEqual([]);
    expect(rt.fs.exists("/project/node_modules")).toBe(false);
    expect(spawned.map((request) => request.args[1])).toEqual(["exit 3"]);
  });

  it("ignores state-file locations outside node_modules instead of deleting them", async () => {
    const { rt, run, writeManifest } = await setup({ dependencies: { react: "19.0.0" } });
    await run();
    rt.fs.mkdir("/project/src", true, 0o755);
    rt.fs.writeFile("/project/src/a.js", encoder.encode("keep"), O_WRONLY | O_CREAT, 0o644);
    const lockPath = `/project/node_modules/${LOCK_NAME}`;
    const lock = JSON.parse(decoder.decode(rt.fs.readFile(lockPath)));
    for (const location of ["node_modules/../src", "node_modules/.webnode-staging", "src"]) {
      lock.packages[location] = { key: "x@1.0.0", name: "x", version: "1.0.0" };
    }
    rt.fs.writeFile(lockPath, encoder.encode(JSON.stringify(lock)), O_WRONLY | O_TRUNC, 0o644);
    writeManifest({ dependencies: { scheduler: "0.25.0" } });
    await run();
    expect(decoder.decode(rt.fs.readFile("/project/src/a.js"))).toBe("keep");
    expect(rt.fs.exists("/project/node_modules/react")).toBe(false);
  });

  it("re-fetches a cached tarball that fails its integrity check and replaces it", async () => {
    const store = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const cache: TarballCache = {
      match: async (url) => {
        const bytes = store.get(url);
        return bytes ? new Response(bytes.slice().buffer) : undefined;
      },
      put: async (url, response) => {
        store.set(url, new Uint8Array(await response.arrayBuffer()));
      },
      delete: async (url) => {
        deleted.push(url);
        return store.delete(url);
      },
    };
    const { run, fake, read } = await setup({ dependencies: { react: "19.0.0" } });
    const url = `${fake.url}/react/-/react-19.0.0.tgz`;
    store.set(url, new TextEncoder().encode("poisoned"));
    await run({ cache });
    expect(read("/project/node_modules/react/index.js")).toBe("module.exports = 'react';");
    expect(deleted).toEqual([url]);
    expect(fake.requests.filter((request) => request === url)).toHaveLength(1);
    await Promise.resolve();
    expect(new TextDecoder().decode(store.get(url)!.subarray(0, 2))).not.toBe("po");
  });

  it("does not read or fill the cache for a tarball with no integrity to check", async () => {
    const store = new Map<string, Uint8Array>();
    const cache: TarballCache = {
      match: async (url) => {
        const bytes = store.get(url);
        return bytes ? new Response(bytes.slice().buffer) : undefined;
      },
      put: async (url, response) => {
        store.set(url, new Uint8Array(await response.arrayBuffer()));
      },
      delete: async (url) => store.delete(url),
    };
    const { rt, run, fake } = await setup({ dependencies: { react: "19.0.0" } });
    const original = fake.fetch;
    // A registry that publishes no integrity and no shasum for this version.
    fake.fetch = async (url, init) => {
      const response = await original(url, init);
      if (url.endsWith(".tgz") || response.status !== 200) {
        return response;
      }
      const document = (await response.json()) as Record<string, unknown>;
      const strip = (version: { dist: Record<string, unknown> }) => {
        delete version.dist.integrity;
        delete version.dist.shasum;
      };
      if ("versions" in document) {
        for (const version of Object.values(document.versions as Record<string, never>)) {
          strip(version);
        }
      } else {
        strip(document as never);
      }
      return new Response(JSON.stringify(document), { status: 200 });
    };
    const url = `${fake.url}/react/-/react-19.0.0.tgz`;
    store.set(url, new TextEncoder().encode("poisoned"));
    await run({ cache });
    expect(decoder.decode(rt.fs.readFile("/project/node_modules/react/index.js"))).toBe(
      "module.exports = 'react';",
    );
    await Promise.resolve();
    expect(decoder.decode(store.get(url)!)).toBe("poisoned");
  });
});
