// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { depsObjectPath } from "../../../depsObjects";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { setRuntime } from "../../runtime";
import type { SpawnRequest } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import type { FakeRuntime } from "../../testing/fakeRuntime";
import { LOCK_NAME, STAGING_NAME, install } from "./install";
import type { InstallOptions, RegistryResolution } from "./install";
import { Reporter, createRuntimeSink } from "./output";
import type { Tool } from "./output";
import { encodePlan, planOf } from "./plan";
import type { DependencyPlan, PackageArchive } from "./plan";
import { createPreparedInstalls, depsObjectIdOf } from "./prepared";
import type { PreparedInstalls } from "./prepared";
import { createRegistryClient } from "./registry";
import type { FetchLike, TarballCache } from "./registry";
import { gunzip, parseTar } from "./tar";
import { createFakeRegistry, scriptLine, writeTar } from "./testkit";
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
    prepared?: InstallOptions["prepared"];
    onRegistryResolution?: (resolution: RegistryResolution) => void;
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
    run: async ({ tool = "pnpm", cache, force, prepared, onRegistryResolution } = {}) => {
      const registry = createRegistryClient({ fetch: fake.fetch, registry: fake.url, cache });
      const result = await install({
        projectDir: "/project",
        registry,
        reporter: new Reporter(tool, createRuntimeSink()),
        force,
        prepared,
        onRegistryResolution,
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
      // A store that takes its time, as Cache Storage does: the install
      // waits for it, so a process that exits right after has cached them.
      put: async (url, response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        await new Promise((resolve) => setTimeout(resolve, 20));
        store.set(url, bytes);
      },
      delete: async (url) => store.delete(url),
    };
    const first = await setup({ dependencies: { react: "19.0.0" } });
    await first.run({ cache });
    expect(store.size).toBe(1);
    // The next registry packs the same package seconds later: the same bytes.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5000);
    let second: Setup;
    try {
      second = await setup({ dependencies: { react: "19.0.0" } });
    } finally {
      clock.mockRestore();
    }
    await second.run({ cache });
    expect(second.fake.requests.some((url) => url.endsWith(".tgz"))).toBe(false);
    expect(second.rt.stdout()).toMatch(/reused 1, downloaded 0, added 1/);
  });

  it("runs the root project's lifecycle scripts, as a shell runs them", async () => {
    const { run, spawned } = await setup({
      name: "app",
      dependencies: { react: "19.0.0" },
      scripts: { postinstall: "echo done", prepare: "husky" },
    });
    await run();
    // `echo` is the shell's own; `husky` is a program, started without a shell.
    expect(spawned.map((request) => [request.command, ...request.args])).toEqual([
      ["sh", "-c", "echo done"],
      ["husky"],
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
    expect(spawned.map((request) => scriptLine(request))).toEqual(["echo pre", "echo post"]);
  });

  it("reports a failed root script as the tool does, and ends without its summary", async () => {
    // npm 10.9.2 and 11.20.0, `npm install` with postinstall "exit 7": the
    // block below on standard error, no "up to date" line, status 7, both
    // when it installs and when nothing changed. pnpm 9.12.1 prints
    // " ELIFECYCLE  Command failed with exit code 7." and no "Done in".
    const scripts = { preinstall: "echo PRE", postinstall: "exit 7", prepare: "echo PREPARE" };
    const status = (request: SpawnRequest) => (scriptLine(request) === "exit 7" ? 7 : 0);
    const npm = await setup({ name: "inst", version: "1.0.0", scripts }, { status });
    for (const upToDate of [false, true]) {
      const printed = { out: npm.rt.stdout().length, err: npm.rt.stderr().length };
      const result = await npm.run({ tool: "npm" });
      expect(result).toMatchObject({ status: 7, upToDate });
      expect(npm.spawned.map((request) => scriptLine(request))).toEqual(["echo PRE", "exit 7"]);
      expect(npm.rt.stdout().slice(printed.out)).toBe(
        "\n> inst@1.0.0 preinstall\n> echo PRE\n\n\n> inst@1.0.0 postinstall\n> exit 7\n\n",
      );
      expect(npm.rt.stderr().slice(printed.err)).toBe(
        "npm error code 7\n" +
          "npm error path /project\n" +
          "npm error command failed\n" +
          "npm error command sh -c exit 7\n",
      );
      npm.spawned.length = 0;
    }

    const pnpm = await setup({ name: "inst", version: "1.0.0", scripts }, { status });
    expect((await pnpm.run()).status).toBe(7);
    expect((await pnpm.run()).status).toBe(7);
    expect(pnpm.rt.stderr()).toBe(" ELIFECYCLE  Command failed with exit code 7.\n".repeat(2));
    expect(pnpm.rt.stdout()).toContain("Already up to date\n\n> inst@1.0.0 preinstall /project\n");
    expect(pnpm.rt.stdout()).not.toContain("Done in");
  });

  it("prints the summary after the root scripts have run", async () => {
    // npm 11.20.0: "up to date in 151ms" follows the prepare script's output.
    // pnpm 9.12.1: "Already up to date", the scripts, then "Done in 173ms".
    const scripts = { preinstall: "echo PRE", prepare: "echo PREPARE" };
    const npm = await setup({ name: "inst", version: "1.0.0", scripts });
    for (const upToDate of [false, true]) {
      const printed = npm.rt.stdout().length;
      expect(await npm.run({ tool: "npm" })).toMatchObject({ status: 0, upToDate });
      expect(npm.rt.stdout().slice(printed)).toMatch(
        /^\n> inst@1\.0\.0 preinstall\n> echo PRE\n\n\n> inst@1\.0\.0 prepare\n> echo PREPARE\n\n\nup to date in \d+ms\n$/,
      );
    }
    const pnpm = await setup({ name: "inst", version: "1.0.0", scripts });
    await pnpm.run();
    const printed = pnpm.rt.stdout().length;
    expect((await pnpm.run()).upToDate).toBe(true);
    expect(pnpm.rt.stdout().slice(printed)).toMatch(
      /^Already up to date\n\n> inst@1\.0\.0 preinstall \/project\n> echo PRE\n\n\n> inst@1\.0\.0 prepare \/project\n> echo PREPARE\n\n\nDone in \d+ms\n$/,
    );
  });

  it("runs preinstall before resolving, and stops when it fails", async () => {
    const { rt, run, fake, spawned } = await setup(
      { dependencies: { react: "19.0.0" }, scripts: { preinstall: "exit 3", postinstall: "x" } },
      { status: (request) => (scriptLine(request) === "exit 3" ? 3 : 0) },
    );
    const result = await run();
    expect(result.status).toBe(3);
    expect(fake.requests).toEqual([]);
    expect(rt.fs.exists("/project/node_modules")).toBe(false);
    expect(spawned.map((request) => scriptLine(request))).toEqual(["exit 3"]);
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

describe("install: peers and failed resolves", () => {
  it("gives a peer its dependent's copy, not a second one", async () => {
    // react-dom-like y names react as a peer; x pins react 19 while the
    // project has react 18. One react 19 must serve both x and y.
    const { run, read, fake } = await setup({
      name: "app",
      dependencies: { react: "19.0.0", x: "1.0.0" },
    });
    await fake.add({ name: "react", version: "18.3.1" });
    await fake.add({ name: "x", version: "1.0.0", dependencies: { react: "18.3.1", y: "1.0.0" } });
    await fake.add({ name: "y", version: "1.0.0", peerDependencies: { react: "*" } });
    expect((await run()).status).toBe(0);
    const lock = JSON.parse(read(`/project/node_modules/${LOCK_NAME}`)) as {
      packages: Record<string, { key: string }>;
    };
    const where = (key: string) =>
      Object.entries(lock.packages)
        .filter(([, entry]) => entry.key === key)
        .map(([location]) => location);
    expect(where("react@18.3.1")).toEqual(["node_modules/x/node_modules/react"]);
    expect(where("y@1.0.0")).toEqual(["node_modules/x/node_modules/y"]);
  });

  it("removes the staging directory when resolving fails, and on an up-to-date install", async () => {
    const { rt, run, fake, writeManifest } = await setup({
      name: "app",
      dependencies: { a: "1.0.0" },
    });
    await fake.add({ name: "a", version: "1.0.0" });
    await fake.add({ name: "big", version: "1.0.0", dependencies: { missing: "^9.0.0" } });
    await fake.add({ name: "missing", version: "1.0.0" });
    expect((await run()).status).toBe(0);
    writeManifest({ name: "app", dependencies: { a: "1.0.0", big: "1.0.0" } });
    await expect(run()).rejects.toMatchObject({ code: "ETARGET" });
    // Let the download that started before the failure finish.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rt.fs.exists(`/project/node_modules/${STAGING_NAME}`)).toBe(false);
    // A directory left by an earlier session goes on the next install.
    rt.fs.mkdir(`/project/node_modules/${STAGING_NAME}/old`, true, 0o755);
    writeManifest({ name: "app", dependencies: { a: "1.0.0" } });
    expect((await run()).upToDate).toBe(true);
    expect(rt.fs.exists(`/project/node_modules/${STAGING_NAME}`)).toBe(false);
  });
});

describe("install: modes", () => {
  const locked = (version: string): FakePackage => ({
    name: "locked",
    version,
    bin: { locked: "bin/cli.js" },
    files: {
      "lib/": { data: "", mode: 0o555 },
      "lib/index.js": { data: `module.exports = "${version}";`, mode: 0o444 },
      "lib/run.sh": { data: "#!/bin/sh\n", mode: 0o511 },
      "bin/cli.js": { data: "#!/usr/bin/env node\n", mode: 0o444 },
    },
  });

  it("installs whatever modes a tarball has, installs over it and removes it", async () => {
    const { rt, run, fake, writeManifest, read } = await setup({
      dependencies: { locked: "1.0.0" },
    });
    await fake.add(locked("1.0.0"));
    await fake.add(locked("2.0.0"));
    expect((await run()).status).toBe(0);
    const mode = (path: string) =>
      rt.fs.stat(`/project/node_modules/locked/${path}`, true).mode & 0o777;
    // Directories 0755, files 0644 or 0755, and what a bin names executable, as npm does.
    expect([mode("lib"), mode("lib/index.js"), mode("lib/run.sh"), mode("bin/cli.js")]).toEqual([
      0o755, 0o644, 0o755, 0o755,
    ]);
    rt.fs.access("/project/node_modules/.bin/locked", 1);
    writeManifest({ dependencies: { locked: "2.0.0" } });
    expect((await run()).status).toBe(0);
    expect(read("/project/node_modules/locked/lib/index.js")).toBe('module.exports = "2.0.0";');
    writeManifest({ dependencies: {} });
    expect((await run()).status).toBe(0);
    expect(rt.fs.exists("/project/node_modules/locked")).toBe(false);
    // `rm -rf node_modules` as the user runs it.
    rt.fs.rm("/project/node_modules", true, false);
    expect(rt.fs.exists("/project/node_modules")).toBe(false);
  });
});

describe("install: from a plan", () => {
  const RUNTIME = "https://runtime.test";
  /** react 18 nests under both x and z (one key, two locations); vite has a bin. */
  const EXTRA: FakePackage[] = [
    { name: "react", version: "18.3.1", files: { "index.js": "module.exports = 18;" } },
    { name: "x", version: "1.0.0", dependencies: { react: "18.3.1" } },
    {
      name: "z",
      version: "1.0.0",
      dependencies: { react: "18.3.1" },
      optionalDependencies: { "not-published": "1.0.0" },
    },
  ];
  const MANIFEST = {
    name: "app",
    dependencies: { ...APP.dependencies, x: "1.0.0", z: "1.0.0" },
    devDependencies: APP.devDependencies,
    // Not applied, so the installer warns about it on every install.
    overrides: { "a>b": "1.0.0" },
  };

  async function fresh(manifest: Record<string, unknown> = MANIFEST): Promise<Setup> {
    const made = await setup(manifest);
    for (const pkg of EXTRA) {
      await made.fake.add(pkg);
    }
    return made;
  }

  type Entry = { kind: string; mode: number; data?: string; target?: string };

  /** Everything under the project: every path's kind, mode, bytes and link target. */
  function tree(rt: FakeRuntime): Record<string, Entry> {
    const entries: Record<string, Entry> = {};
    const walk = (dir: string) => {
      for (const entry of rt.fs.readdir(dir)) {
        const path = `${dir}/${entry.name}`;
        const mode = rt.fs.stat(path, false).mode & 0o7777;
        if (entry.type === "dir") {
          entries[path] = { kind: "dir", mode };
          walk(path);
        } else if (entry.type === "symlink") {
          entries[path] = { kind: "symlink", mode, target: rt.fs.readlink(path) };
        } else {
          entries[path] = { kind: entry.type, mode, data: decoder.decode(rt.fs.readFile(path)) };
        }
      }
    };
    walk("/project");
    return entries;
  }

  interface Prepared {
    /** What the registry install wrote, and printed. */
    tree: Record<string, Entry>;
    stdout: string;
    stderr: string;
    resolution: RegistryResolution;
    plan: DependencyPlan;
    planId: string;
    hash: string;
    /** The objects the runtime host serves: id → bytes. */
    objects: Map<string, Uint8Array>;
    /** Each package's registry tarball URL, by key. */
    tarballs: Map<string, string>;
  }

  /** Installs `manifest` from the registry and makes its plan and archives from what it fetched. */
  async function prepare(
    options: { tool?: Tool; manifest?: Record<string, unknown> } = {},
  ): Promise<Prepared> {
    const made = await fresh(options.manifest);
    let resolution: RegistryResolution | undefined;
    await made.run({ tool: options.tool, onRegistryResolution: (found) => (resolution = found) });
    const objects = new Map<string, Uint8Array>();
    const archives = new Map<string, PackageArchive>();
    const tarballs = new Map<string, string>();
    for (const [key, pkg] of resolution!.resolved.nodes) {
      const response = await made.fake.fetch(pkg.dist.tarball);
      const tar = await gunzip(new Uint8Array(await response.arrayBuffer()));
      const id = await depsObjectIdOf(tar);
      objects.set(id, tar);
      archives.set(key, { id, size: tar.length });
      tarballs.set(key, pkg.dist.tarball);
    }
    const hash = JSON.parse(made.read(`/project/node_modules/${LOCK_NAME}`)).manifestHash;
    const plan = planOf({
      manifestHash: hash,
      resolved: resolution!.resolved,
      archives,
      warnings: resolution!.warnings,
    });
    const bytes = encodePlan(plan);
    const planId = await depsObjectIdOf(bytes);
    objects.set(planId, bytes);
    return {
      tree: tree(made.rt),
      stdout: made.rt.stdout(),
      stderr: made.rt.stderr(),
      resolution: resolution!,
      plan,
      planId,
      hash,
      objects,
      tarballs,
    };
  }

  /** A runtime host that serves `objects`, and the URLs asked of it. */
  function objectHost(objects: Map<string, Uint8Array>): { fetch: FetchLike; requests: string[] } {
    const requests: string[] = [];
    return {
      requests,
      fetch: async (url) => {
        requests.push(url);
        const bytes = objects.get(url.slice(`${RUNTIME}${depsObjectPath("")}`.length));
        return bytes
          ? new Response(bytes.slice().buffer, { status: 200 })
          : new Response("", { status: 404 });
      },
    };
  }

  function preparedFor(
    made: Prepared,
    host: { fetch: FetchLike },
    options: { index?: Record<string, string>; cache?: TarballCache } = {},
  ): PreparedInstalls {
    return createPreparedInstalls({
      fetch: host.fetch,
      origin: RUNTIME,
      index: options.index ?? { [made.hash]: made.planId },
      cache: options.cache,
      retryDelayMs: 0,
    });
  }

  function memoryCache() {
    const store = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const cache: TarballCache = {
      match: async (url) => {
        const bytes = store.get(url);
        return bytes ? new Response(bytes.slice().buffer) : undefined;
      },
      put: async (url, response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        await new Promise((resolve) => setTimeout(resolve, 10));
        store.set(url, bytes);
      },
      delete: async (url) => {
        deleted.push(url);
        return store.delete(url);
      },
    };
    return { store, deleted, cache };
  }

  it("writes exactly what a registry install of the same versions writes, asking the registry nothing", async () => {
    const made = await prepare();
    expect(made.resolution.skippedOptional.map((skipped) => skipped.error.code)).toEqual(["E404"]);
    // The fixture has what the comparison needs.
    expect(made.tree["/project/node_modules/x/node_modules/react/index.js"].data).toBe(
      "module.exports = 18;",
    );
    expect(made.tree["/project/node_modules/z/node_modules/react/index.js"].data).toBe(
      "module.exports = 18;",
    );
    expect(made.tree["/project/node_modules/.bin/vite"]).toMatchObject({ kind: "symlink" });

    const host = objectHost(made.objects);
    const second = await fresh();
    expect((await second.run({ prepared: preparedFor(made, host) })).status).toBe(0);
    expect(tree(second.rt)).toEqual(made.tree);
    expect(second.fake.requests).toEqual([]);
    expect(host.requests).toHaveLength(made.objects.size);
  });

  it("fetches from the registry only the tarball of an archive it cannot have", async () => {
    const made = await prepare();
    const missing = made.plan.packages["vite@5.4.21"].archive;
    const broken = made.plan.packages["react@18.3.1"].archive;
    const objects = new Map(made.objects);
    objects.delete(missing);
    objects.set(broken, encoder.encode("not the tar"));
    const second = await fresh();
    expect((await second.run({ prepared: preparedFor(made, objectHost(objects)) })).status).toBe(0);
    expect(tree(second.rt)).toEqual(made.tree);
    expect([...second.fake.requests].sort()).toEqual(
      [made.tarballs.get("react@18.3.1"), made.tarballs.get("vite@5.4.21")].sort(),
    );
  });

  it("installs from the registry when there is no plan to use", async () => {
    const made = await prepare();
    const encoded = async (change: (plan: Record<string, any>) => void) => {
      const plan = JSON.parse(JSON.stringify(made.plan)) as Record<string, any>;
      change(plan);
      const bytes = encoder.encode(JSON.stringify(plan));
      const id = await depsObjectIdOf(bytes);
      return { id, bytes };
    };
    const firstKey = made.plan.layout[0][1];
    const cases: [
      string,
      () => Promise<{ index: Record<string, string>; objects?: Map<string, Uint8Array> }>,
    ][] = [
      ["no row in the index", async () => ({ index: {} })],
      [
        "a plan object that does not hash to its id",
        async () => ({
          index: { [made.hash]: made.planId },
          objects: new Map([...made.objects, [made.planId, encoder.encode("{}")]]),
        }),
      ],
    ];
    const broken: [string, (plan: Record<string, any>) => void][] = [
      ["another plan version", (plan) => (plan.planVersion = 2)],
      ["another state-file version", (plan) => (plan.lockfileVersion = 2)],
      ["another manifest", (plan) => (plan.manifestHash = "0".repeat(64))],
      ["a location outside node_modules", (plan) => (plan.layout[0][0] = "node_modules/../src")],
      ["a location twice", (plan) => plan.layout.push([...plan.layout[0]])],
      ["a layout key it does not describe", (plan) => (plan.layout[0][1] = "nope@1.0.0")],
      ["a root key it does not describe", (plan) => (plan.root.react = "nope@1.0.0")],
      ["an archive that is not an id", (plan) => (plan.packages[firstKey].archive = "x")],
      ["a size that is not a count", (plan) => (plan.packages[firstKey].size = -1)],
      [
        "a tarball not over https",
        (plan) => (plan.packages[firstKey].tarball = "http://registry.test/a.tgz"),
      ],
    ];
    for (const [what, change] of broken) {
      cases.push([
        what,
        async () => {
          const { id, bytes } = await encoded(change);
          return {
            index: { [made.hash]: id },
            objects: new Map([...made.objects, [id, bytes]]),
          };
        },
      ]);
    }
    for (const [what, make] of cases) {
      const { index, objects } = await make();
      const host = objectHost(objects ?? made.objects);
      const second = await fresh();
      const { status } = await second.run({ prepared: preparedFor(made, host, { index }) });
      // Named, so a failure says which case it was. No archive is asked for
      // without a plan, and the registry is asked for metadata.
      expect({
        what,
        status,
        same: JSON.stringify(tree(second.rt)) === JSON.stringify(made.tree),
        resolved: second.fake.requests.some((url) => !url.endsWith(".tgz")),
        objectRequests: host.requests.length <= 1,
      }).toEqual({ what, status: 0, same: true, resolved: true, objectRequests: true });
    }
  });

  it("uses no plan on update", async () => {
    const made = await prepare();
    const host = objectHost(made.objects);
    const second = await fresh();
    await second.run();
    const before = second.fake.requests.length;
    const result = await second.run({ prepared: preparedFor(made, host), force: true });
    expect(result.upToDate).toBe(false);
    expect(host.requests).toEqual([]);
    expect(second.fake.requests.length).toBeGreaterThan(before);
    expect(tree(second.rt)).toEqual(made.tree);
  });

  it("drops an object planted in Cache Storage and never uses it", async () => {
    const made = await prepare();
    const memory = memoryCache();
    const id = made.plan.packages["react@19.0.0"].archive;
    const url = `${RUNTIME}${depsObjectPath(id)}`;
    // A tar that reads well, with other contents.
    memory.store.set(url, writeTar([{ path: "package/index.js", data: "planted" }]));
    expect(parseTar(memory.store.get(url)!)).toHaveLength(1);
    const host = objectHost(made.objects);
    const second = await fresh();
    await second.run({ prepared: preparedFor(made, host, { cache: memory.cache }) });
    expect(tree(second.rt)).toEqual(made.tree);
    expect(memory.deleted).toEqual([url]);
    expect(host.requests).toContain(url);
    expect(memory.store.get(url)).toEqual(made.objects.get(id));
  });

  it("makes no request at all on a later visit, and counts every package as reused", async () => {
    const made = await prepare();
    const memory = memoryCache();
    const host = objectHost(made.objects);
    const first = await fresh();
    await first.run({ prepared: preparedFor(made, host, { cache: memory.cache }) });
    // The install waited for the store before it returned.
    expect(memory.store.size).toBe(made.objects.size);
    const requests = host.requests.length;
    const second = await fresh();
    await second.run({ prepared: preparedFor(made, host, { cache: memory.cache }) });
    expect(host.requests.length).toBe(requests);
    expect(second.fake.requests).toEqual([]);
    expect(tree(second.rt)).toEqual(made.tree);
    const count = Object.keys(made.plan.packages).length;
    expect(count).toBeGreaterThan(10);
    expect(second.rt.stdout()).toMatch(
      new RegExp(
        `^Progress: resolved ${count}, reused ${count}, downloaded 0, added \\d+, done$`,
        "m",
      ),
    );
  });

  it("prints what a registry install prints, in every tool's voice", async () => {
    // Elapsed times and the reused/downloaded split are the only differences allowed.
    const normalize = (text: string) =>
      text
        .replace(/\d+(\.\d+)?m?s\b/g, "<time>")
        .replace(/reused \d+, downloaded \d+/g, "reused <n>, downloaded <n>");
    for (const tool of ["pnpm", "npm", "yarn", "bun"] as const) {
      const made = await prepare({ tool });
      expect(made.resolution.warnings).toHaveLength(1);
      expect(made.plan.warnings).toEqual(made.resolution.warnings);
      expect(made.stderr).toContain("not-published");
      expect(made.stderr).toContain('"a>b"');
      const second = await fresh();
      await second.run({ tool, prepared: preparedFor(made, objectHost(made.objects)) });
      expect({ tool, requests: second.fake.requests }).toEqual({ tool, requests: [] });
      expect({ tool, stdout: normalize(second.rt.stdout()), stderr: second.rt.stderr() }).toEqual({
        tool,
        stdout: normalize(made.stdout),
        stderr: made.stderr,
      });
    }
  });

  it("adds to a node_modules that already has packages as a registry install does", async () => {
    const made = await prepare();
    const before = { dependencies: { react: "19.0.0", x: "1.0.0" } };
    // The same steps from the registry alone.
    const expected = await fresh(before);
    await expected.run();
    expected.writeManifest(MANIFEST);
    await expected.run();
    const want = tree(expected.rt);

    const host = objectHost(made.objects);
    const second = await fresh(before);
    await second.run();
    const registryRequests = second.fake.requests.length;
    second.writeManifest(MANIFEST);
    const result = await second.run({ prepared: preparedFor(made, host) });
    expect(result.upToDate).toBe(false);
    expect(tree(second.rt)).toEqual(want);
    expect(second.fake.requests.length).toBe(registryRequests);
    // Packages already on disk at the same version are not fetched again.
    const asked = new Set(host.requests);
    const kept = ["react@19.0.0", "x@1.0.0", "react@18.3.1"];
    expect(
      kept.filter((key) =>
        asked.has(`${RUNTIME}${depsObjectPath(made.plan.packages[key].archive)}`),
      ),
    ).toEqual([]);
    expect(
      asked.has(`${RUNTIME}${depsObjectPath(made.plan.packages["vite@5.4.21"].archive)}`),
    ).toBe(true);
    // And a later install with nothing changed is up to date.
    expect((await second.run({ prepared: preparedFor(made, host) })).upToDate).toBe(true);
  });
});
