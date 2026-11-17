// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../../kernel/vfs/types";
import { setRuntime } from "../../runtime";
import type { SpawnRequest } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import type { FakeChildIo, FakeRuntime } from "../../testing/fakeRuntime";
import { runPackageManager } from "./index";
import { createFakeRegistry } from "./testkit";
import type { FakePackage } from "./testkit";

const PACKAGES: FakePackage[] = [
  { name: "react", version: "18.3.1" },
  { name: "react", version: "19.0.0" },
  {
    name: "vite",
    version: "5.4.21",
    bin: { vite: "bin/vite.js" },
    files: { "bin/vite.js": "#!/usr/bin/env node" },
  },
  {
    name: "create-vite",
    version: "6.1.1",
    bin: { "create-vite": "index.js", cva: "index.js" },
    files: { "index.js": "#!/usr/bin/env node" },
  },
  {
    name: "cowsay",
    version: "1.6.0",
    bin: { cowsay: "cli.js", cowthink: "cli.js" },
    files: { "cli.js": "" },
  },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Setup {
  rt: FakeRuntime;
  spawned: SpawnRequest[];
  pm: (...argv: string[]) => Promise<number>;
  manifest: () => Record<string, unknown>;
  fake: Awaited<ReturnType<typeof createFakeRegistry>>;
}

async function setup(
  manifest: Record<string, unknown> | null,
  child: (request: SpawnRequest, io: FakeChildIo) => number | Promise<number> = () => 0,
): Promise<Setup> {
  const fake = await createFakeRegistry(PACKAGES);
  vi.stubGlobal("fetch", fake.fetch);
  const spawned: SpawnRequest[] = [];
  const rt = createFakeRuntime({
    cwd: "/project",
    env: { PATH: "/bin:/usr/bin", npm_config_registry: fake.url, HOME: "/home" },
    spawn: (request, io) => {
      spawned.push(request);
      return child(request, io);
    },
  });
  rt.vfs.mkdir("/project", true, 0o755);
  rt.vfs.mkdir("/bin", true, 0o755);
  if (manifest) {
    rt.fs.writeFile(
      "/project/package.json",
      encoder.encode(`${JSON.stringify(manifest, null, 4)}\n`),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
  }
  setRuntime(rt);
  return {
    rt,
    spawned,
    fake,
    pm: (...argv) => runPackageManager(argv),
    manifest: () => JSON.parse(decoder.decode(rt.fs.readFile("/project/package.json"))),
  };
}

afterEach(() => {
  setRuntime(null);
  vi.unstubAllGlobals();
});

describe("versions and help", () => {
  it("prints each tool's version", async () => {
    const { rt, pm } = await setup(null);
    for (const tool of ["npm", "pnpm", "yarn", "bun", "npx"]) {
      expect(await pm(tool, "--version")).toBe(0);
    }
    expect(rt.stdout()).toBe("10.9.2\n9.15.4\n1.22.22\n1.2.0\n10.9.2\n");
    expect(rt.refCount).toBe(0);
  });
});

describe("add and remove", () => {
  it("adds a caret range of the resolved version, keeping the indentation", async () => {
    const { rt, pm, manifest } = await setup({ name: "app", version: "1.0.0" });
    expect(await pm("pnpm", "add", "react")).toBe(0);
    expect(manifest().dependencies).toEqual({ react: "^19.0.0" });
    expect(decoder.decode(rt.fs.readFile("/project/package.json"))).toMatch(/^\{\n {4}"name"/);
    expect(rt.fs.exists("/project/node_modules/react/package.json")).toBe(true);
    expect(rt.stdout()).toContain("dependencies:\n+ react 19.0.0\n");
  });

  it("refuses a command-line name that is not a package name", async () => {
    const { rt, pm, manifest, fake } = await setup({ name: "app" });
    expect(await pm("npm", "install", "../evil")).toBe(1);
    expect(await pm("npm", "install", "x@npm:../evil@1")).toBe(1);
    expect(await pm("npx", "..@1")).toBe(1);
    expect(rt.stderr()).toContain("Invalid package name");
    expect(manifest()).toEqual({ name: "app" });
    expect(fake.requests).toEqual([]);
  });

  it("adds exact and dev dependencies and moves a name between lists", async () => {
    const { pm, manifest } = await setup({ dependencies: { vite: "^5.0.0" } });
    expect(await pm("npm", "install", "-D", "-E", "vite", "react@18")).toBe(0);
    expect(manifest()).toEqual({ devDependencies: { react: "18.3.1", vite: "5.4.21" } });
  });

  it("keeps a name in its own list when no save flag is given", async () => {
    const { pm, manifest, fake } = await setup({
      dependencies: { react: "^18.0.0" },
      devDependencies: { vite: "^5.0.0" },
    });
    await fake.add({ name: "vite", version: "6.0.0" });
    expect(await pm("npm", "install", "vite@latest", "cowsay")).toBe(0);
    expect(manifest()).toEqual({
      dependencies: { cowsay: "^1.6.0", react: "^18.0.0" },
      devDependencies: { vite: "^6.0.0" },
    });
    expect(await pm("pnpm", "add", "--save-prod", "vite")).toBe(0);
    expect(manifest()).toEqual({
      dependencies: { cowsay: "^1.6.0", react: "^18.0.0", vite: "^6.0.0" },
    });
  });

  it("starts a project when adding a package where there is no package.json", async () => {
    for (const tool of ["npm", "pnpm"]) {
      const { pm, manifest } = await setup(null);
      expect(await pm(tool, tool === "npm" ? "install" : "add", "react@18")).toBe(0);
      expect(manifest()).toEqual({ dependencies: { react: "^18.3.1" } });
    }
  });

  it("removes dependencies and their files", async () => {
    const { rt, pm, manifest } = await setup({ dependencies: { react: "19.0.0", vite: "5.4.21" } });
    await pm("pnpm", "install");
    expect(await pm("pnpm", "remove", "react")).toBe(0);
    expect(manifest()).toEqual({ dependencies: { vite: "5.4.21" } });
    expect(rt.fs.exists("/project/node_modules/react")).toBe(false);
    expect(await pm("pnpm", "remove", "nope")).toBe(1);
    expect(rt.stderr()).toContain("Cannot remove 'nope'");
  });

  it("leaves package.json alone when the install fails", async () => {
    const { rt, pm, manifest } = await setup({ dependencies: {} });
    expect(await pm("pnpm", "add", "missing-package")).toBe(1);
    expect(manifest()).toEqual({ dependencies: {} });
    expect(rt.stderr()).toMatch(
      /^ ERR_PNPM_FETCH_404 {2}GET https:\/\/registry\.test\/missing-package: Not Found - 404/,
    );
  });

  it("refuses global installs", async () => {
    const { rt, pm } = await setup({});
    expect(await pm("npm", "i", "-g", "typescript")).toBe(1);
    expect(rt.stderr()).toMatch(/global installs are not supported/);
  });
});

describe("errors in each tool's voice", () => {
  it("reports a missing package", async () => {
    const npm = await setup({ dependencies: { nope: "1.0.0" } });
    expect(await npm.pm("npm", "install")).toBe(1);
    expect(npm.rt.stderr()).toMatch(
      /^npm error code E404\nnpm error GET https:\/\/registry\.test\/nope: Not Found - 404\n/,
    );
    const yarn = await setup({ dependencies: { nope: "1.0.0" } });
    expect(await yarn.pm("yarn")).toBe(1);
    expect(yarn.rt.stderr()).toMatch(/^error GET https:\/\/registry\.test\/nope/);
  });

  it("reports a missing package.json", async () => {
    const { rt, pm } = await setup(null);
    expect(await pm("pnpm", "install")).toBe(1);
    expect(rt.stderr()).toContain("ERR_PNPM_NO_PKG_MANIFEST  No package.json found in /project");
  });

  it("reports unknown npm commands", async () => {
    const { rt, pm } = await setup({});
    expect(await pm("npm", "frobnicate")).toBe(1);
    expect(rt.stderr()).toContain('npm error Unknown command: "frobnicate"');
  });
});

describe("run", () => {
  const manifest = {
    name: "app",
    version: "1.2.3",
    scripts: { dev: "vite", predev: "echo pre", postdev: "echo post", fail: "exit 3" },
  };

  it("runs a script through sh with the lifecycle environment and pnpm's header", async () => {
    const { rt, pm, spawned } = await setup({ ...manifest, scripts: { dev: "vite" } });
    expect(await pm("pnpm", "dev", "--port", "3000")).toBe(0);
    expect(spawned).toHaveLength(1);
    const [request] = spawned;
    expect([request.command, ...request.args]).toEqual(["sh", "-c", "vite --port 3000"]);
    expect(request.stdio).toEqual(["inherit", "inherit", "inherit"]);
    expect(request.cwd).toBe("/project");
    expect(request.env).toMatchObject({
      npm_lifecycle_event: "dev",
      npm_lifecycle_script: "vite",
      npm_package_name: "app",
      npm_package_version: "1.2.3",
      npm_package_json: "/project/package.json",
      npm_config_user_agent: "pnpm/9.15.4 npm/? node/v22.14.0 linux x64",
      npm_execpath: "/bin/pnpm",
      npm_node_execpath: "/bin/node",
      NODE: "/bin/node",
      INIT_CWD: "/project",
      HOME: "/home",
    });
    expect(request.env.PATH.split(":").slice(0, 2)).toEqual([
      "/project/node_modules/.bin",
      "/node_modules/.bin",
    ]);
    expect(request.env.PATH.endsWith(":/bin:/usr/bin")).toBe(true);
    expect(rt.stdout()).toBe("\n> app@1.2.3 dev /project\n> vite --port 3000\n\n");
  });

  it("runs pre and post scripts for every tool", async () => {
    const npm = await setup(manifest);
    await npm.pm("npm", "run", "dev");
    expect(npm.spawned.map((request) => request.args[1])).toEqual([
      "echo pre",
      "vite",
      "echo post",
    ]);
    expect(npm.rt.stdout()).toContain("\n> app@1.2.3 dev\n> vite\n\n");
    const yarn = await setup(manifest);
    await yarn.pm("yarn", "dev");
    expect(yarn.spawned.map((request) => request.args[1])).toEqual([
      "echo pre",
      "vite",
      "echo post",
    ]);
    expect(yarn.rt.stdout()).toMatch(
      /^yarn run v1\.22\.22\n\$ echo pre\n\$ vite\n\$ echo post\nDone in/,
    );
    // pnpm (since v8) and bun run the hooks too, for `run` and for a bare script name.
    for (const argv of [
      ["pnpm", "run", "dev"],
      ["pnpm", "dev"],
      ["bun", "run", "dev"],
    ]) {
      const other = await setup(manifest);
      await other.pm(...argv);
      expect(other.spawned.map((request) => request.args[1])).toEqual([
        "echo pre",
        "vite",
        "echo post",
      ]);
    }
  });

  it("returns the script's exit status", async () => {
    const { rt, pm } = await setup(manifest, (request) => (request.args[1] === "exit 3" ? 3 : 0));
    expect(await pm("pnpm", "fail")).toBe(3);
    expect(rt.stderr()).toContain("ELIFECYCLE  Command failed with exit code 3.");
  });

  it("forwards signals to the child and returns 128 + the signal number", async () => {
    let finish: (() => void) | null = null;
    const { rt, pm } = await setup(
      manifest,
      () => new Promise<number>((resolve) => (finish = () => resolve(0))),
    );
    const status = pm("pnpm", "dev");
    await new Promise((resolve) => setTimeout(resolve, 0));
    rt.signal("SIGINT");
    expect(await status).toBe(130);
    expect(finish).not.toBeNull();
  });

  it("reports a missing script in each tool's voice", async () => {
    const pnpm = await setup(manifest);
    expect(await pnpm.pm("pnpm", "run", "nope")).toBe(1);
    expect(pnpm.rt.stderr()).toContain("ERR_PNPM_NO_SCRIPT  Missing script: nope");
    const npm = await setup(manifest);
    expect(await npm.pm("npm", "run", "nope")).toBe(1);
    expect(npm.rt.stderr()).toContain('npm error Missing script: "nope"');
    const yarn = await setup(manifest);
    expect(await yarn.pm("yarn", "nope")).toBe(1);
    expect(yarn.rt.stderr()).toContain('error Command "nope" not found.');
    const ifPresent = await setup(manifest);
    expect(await ifPresent.pm("npm", "run", "nope", "--if-present")).toBe(0);
  });

  it("lists scripts", async () => {
    const { rt, pm } = await setup(manifest);
    expect(await pm("pnpm", "run")).toBe(0);
    expect(rt.stdout()).toContain("  dev\n    vite\n");
  });

  it("runs from a subdirectory of the project", async () => {
    const { rt, pm, spawned } = await setup(manifest);
    rt.vfs.mkdir("/project/src", true, 0o755);
    rt.cwd = "/project/src";
    expect(await pm("pnpm", "dev")).toBe(0);
    expect(spawned[0].cwd).toBe("/project");
    expect(spawned[0].env.INIT_CWD).toBe("/project/src");
  });
});

describe("exec", () => {
  it("runs an installed bin, found from the working directory up", async () => {
    const { pm, spawned } = await setup({ devDependencies: { vite: "5.4.21" } });
    await pm("pnpm", "install");
    expect(await pm("pnpm", "exec", "vite", "build")).toBe(0);
    expect(spawned[0].command).toBe("/project/node_modules/.bin/vite");
    expect(spawned[0].args).toEqual(["build"]);
    expect(await pm("npx", "vite")).toBe(0);
    expect(await pm("pnpm", "vite", "--host")).toBe(0);
    expect(spawned.map((request) => request.command)).toEqual([
      "/project/node_modules/.bin/vite",
      "/project/node_modules/.bin/vite",
      "/project/node_modules/.bin/vite",
    ]);
  });

  it("installs a missing package into /tmp/.npx and runs its bin", async () => {
    const { rt, pm, spawned } = await setup({});
    expect(await pm("npx", "-y", "cowsay@1.6.0", "moo")).toBe(0);
    expect(spawned[0].command).toBe("/tmp/.npx/cowsay@1.6.0/node_modules/.bin/cowsay");
    expect(spawned[0].args).toEqual(["moo"]);
    expect(rt.stderr()).toContain(
      "npm warn exec The following package was not found and will be installed: cowsay@1.6.0",
    );
    expect(rt.fs.exists("/project/node_modules")).toBe(false);
  });

  it("installs a scoped package and runs its bin, or runs the project's copy", async () => {
    const { pm, spawned, fake } = await setup({});
    await fake.add({
      name: "@tailwindcss/cli",
      version: "4.1.0",
      bin: { tailwindcss: "dist/index.mjs" },
      files: { "dist/index.mjs": "#!/usr/bin/env node" },
    });
    for (const argv of [
      ["npx", "@tailwindcss/cli", "-i", "in.css"],
      ["npm", "exec", "@tailwindcss/cli@4", "--", "-i", "in.css"],
      ["bunx", "@tailwindcss/cli", "-i", "in.css"],
    ]) {
      expect(await pm(...argv)).toBe(0);
    }
    expect(spawned.map((request) => [request.command, ...request.args])).toEqual(
      Array(3).fill([
        "/tmp/.npx/@tailwindcss+cli@4.1.0/node_modules/.bin/tailwindcss",
        "-i",
        "in.css",
      ]),
    );
    // Installed in the project, the package's own bin runs without a download.
    expect(await pm("npm", "install", "@tailwindcss/cli")).toBe(0);
    const before = fake.requests.length;
    expect(await pm("npx", "@tailwindcss/cli", "-i", "in.css")).toBe(0);
    expect(spawned.at(-1)?.command).toBe("/project/node_modules/.bin/tailwindcss");
    expect(fake.requests.length).toBe(before);
    // A path is still run as a path.
    expect(await pm("npx", "./bin/tool", "x")).toBe(0);
    expect(spawned.at(-1)?.command).toBe("./bin/tool");
  });

  it("runs a named bin from -p packages", async () => {
    const { pm, spawned } = await setup({});
    expect(await pm("npx", "-p", "cowsay", "cowthink", "hm")).toBe(0);
    expect(spawned[0].command).toBe("/tmp/.npx/cowsay@1.6.0/node_modules/.bin/cowthink");
  });

  it("runs commands that are on PATH", async () => {
    const { rt, pm, spawned } = await setup({});
    rt.fs.writeFile("/bin/node", new Uint8Array(0), O_WRONLY | O_CREAT, 0o755);
    expect(await pm("npx", "node", "-e", "1")).toBe(0);
    expect(spawned[0].command).toBe("node");
  });

  it("errors for pnpm exec of a command that is not installed", async () => {
    const { rt, pm } = await setup({});
    expect(await pm("pnpm", "exec", "nothing-here")).toBe(1);
    expect(rt.stderr()).toContain('Command "nothing-here" not found');
  });

  it("runs create-<name> for create", async () => {
    const { pm, spawned } = await setup(null);
    expect(await pm("npm", "create", "vite@latest", "my-app", "--", "--template", "react")).toBe(0);
    expect(spawned[0].command).toBe("/tmp/.npx/create-vite@6.1.1/node_modules/.bin/create-vite");
    // npm consumes the `--`, so create-vite reads `--template` as its flag.
    expect(spawned[0].args).toEqual(["my-app", "--template", "react"]);
  });
});

describe("other commands", () => {
  it("init writes a default package.json", async () => {
    const { pm, manifest, rt } = await setup(null);
    expect(await pm("npm", "init", "-y")).toBe(0);
    expect(manifest()).toMatchObject({ name: "project", version: "1.0.0", license: "ISC" });
    expect(rt.stdout()).toContain("Wrote to /project/package.json:");
  });

  it("ls lists the top-level dependencies", async () => {
    const { rt, pm } = await setup({
      name: "app",
      version: "1.0.0",
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "5.4.21" },
    });
    await pm("pnpm", "install");
    const before = rt.stdout().length;
    expect(await pm("pnpm", "ls")).toBe(0);
    expect(rt.stdout().slice(before)).toBe(
      "app@1.0.0 /project\n\ndependencies:\nreact 19.0.0\n\ndevDependencies:\nvite 5.4.21\n",
    );
  });

  it("why names the dependents", async () => {
    const { rt, pm } = await setup({ dependencies: { react: "19.0.0" } });
    await pm("pnpm", "install");
    expect(await pm("pnpm", "why", "react")).toBe(0);
    expect(rt.stdout()).toContain(
      "react@19.0.0 node_modules/react\n  prod dependency of the project (19.0.0)",
    );
  });

  it("accepts maintenance commands with one line", async () => {
    const { rt, pm } = await setup({});
    expect(await pm("pnpm", "store", "prune")).toBe(0);
    expect(rt.stdout().trim().split("\n")).toHaveLength(1);
  });

  it("installs under -C", async () => {
    const { rt, pm } = await setup(null);
    rt.vfs.mkdir("/other", true, 0o755);
    rt.fs.writeFile(
      "/other/package.json",
      encoder.encode('{"dependencies":{"react":"19.0.0"}}'),
      O_WRONLY | O_CREAT,
      0o644,
    );
    expect(await pm("pnpm", "-C", "/other", "install")).toBe(0);
    expect(rt.fs.exists("/other/node_modules/react/package.json")).toBe(true);
  });
});
