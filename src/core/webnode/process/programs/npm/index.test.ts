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

  it("returns the script's exit status with the tool's failure line", async () => {
    // pnpm 9.12.1 and yarn 1.22.19; npm says nothing (below).
    const exits = (request: SpawnRequest) =>
      request.args[1] === "exit 3" ? 3 : request.args[1] === "jest" ? 2 : 0;
    const pnpm = await setup({ ...manifest, scripts: { fail: "exit 3", test: "jest" } }, exits);
    expect(await pnpm.pm("pnpm", "fail")).toBe(3);
    expect(pnpm.rt.stderr()).toBe(" ELIFECYCLE  Command failed with exit code 3.\n");
    expect(await pnpm.pm("pnpm", "test")).toBe(2);
    expect(pnpm.rt.stderr()).toBe(
      " ELIFECYCLE  Command failed with exit code 3.\n" +
        " ELIFECYCLE  Test failed. See above for more details.\n",
    );
    const yarn = await setup(manifest, exits);
    expect(await yarn.pm("yarn", "fail")).toBe(3);
    expect(yarn.rt.stderr()).toBe("error Command failed with exit code 3.\n");
    expect(yarn.rt.stdout()).not.toContain("Done in");
  });

  it("says nothing when an npm script fails, and exits with its status", async () => {
    // npm 10.9.2 and 11.20.0: `run` is a shell-out command, so a script's
    // non-zero exit (3, or the 130 of a script that handled Ctrl+C) is
    // passed on without a word.
    const { rt, pm } = await setup(manifest, (request) =>
      request.args[1] === "exit 3" ? 3 : request.args[1] === "vite" ? 130 : 0,
    );
    expect(await pm("npm", "run", "fail")).toBe(3);
    expect(await pm("npm", "run", "dev")).toBe(130);
    expect(rt.stderr()).toBe("");
    expect(rt.exitCode).toBeNull();
    // The post script does not run after a failure.
    expect(rt.stdout()).not.toContain("echo post");
  });
});

describe("a command that a signal ends", () => {
  const manifest = {
    name: "app",
    version: "1.2.3",
    scripts: { dev: "vite", predev: "echo pre", postdev: "echo post", test: "jest" },
  };
  /** A command that runs until a signal ends it; `echo …` hooks end at once. */
  const untilSignalled = (request: SpawnRequest) =>
    request.args[1]?.startsWith("echo ") ? 0 : new Promise<number>(() => {});
  /** Lets the tool get as far as waiting for its command. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** The pid the fake runtime gave the tool's `n`th child: it counts up from the tool's own. */
  const child = (rt: FakeRuntime, n: number) => rt.pid + n;
  const withBin = (rt: FakeRuntime) => {
    rt.vfs.mkdir("/project/node_modules/.bin", true, 0o755);
    rt.fs.writeFile(
      "/project/node_modules/.bin/cowsay",
      encoder.encode("#!/bin/sh\n"),
      O_WRONLY | O_CREAT | O_TRUNC,
      0o755,
    );
  };

  it("npm passes SIGINT and SIGTERM on and dies of the signal its script died of, saying nothing", async () => {
    // npm 10.9.2 and 11.20.0 under a pty: Ctrl+C on `npm run sleep` prints
    // nothing and npm dies of SIGINT; `kill <npm>` ends it with SIGTERM; a
    // script that kills itself (`kill -TERM $$`) does the same.
    for (const [signal, status] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const { rt, pm, spawned } = await setup(manifest, untilSignalled);
      const run = pm("npm", "run", "dev");
      await settled();
      rt.signal(signal);
      // npm dies of it, as the kernel ends a process: nothing more is printed.
      expect(await run).toBe(status);
      expect(rt.exitCode).toBe(status);
      expect(rt.stderr()).toBe("");
      expect(spawned.map((request) => request.args[1])).toEqual(["echo pre", "vite"]);
    }
    // A script that died of a signal npm was never sent.
    const { rt, pm } = await setup({ scripts: { dev: "vite" } }, untilSignalled);
    const run = pm("npm", "run", "dev");
    await settled();
    rt.processes.kill(child(rt, 1), "SIGQUIT");
    expect(await run).toBe(131);
    expect(rt.exitCode).toBe(131);
    expect(rt.stderr()).toBe("");
  });

  it("npm dies at once of a signal it does not pass on, and of any signal while nothing runs", async () => {
    // npm's run-script handles SIGINT and SIGTERM only, and only while a script runs.
    const { rt, pm } = await setup(manifest, untilSignalled);
    void pm("npm", "run", "dev");
    await settled();
    rt.signal("SIGHUP");
    expect(rt.exitCode).toBe(129);
    const idle = await setup(manifest, () => 0);
    expect(await idle.pm("npm", "run", "dev")).toBe(0);
    idle.rt.signal("SIGINT");
    expect(idle.rt.exitCode).toBe(130);
  });

  it("npm exec, npx and a bin they run die of the command's signal too", async () => {
    // npm 11.20.0: `npm exec -c 'kill -TERM $$'`, `npx -c …`, `npx <local bin>`
    // and `npm exec <local bin>` all die of SIGTERM.
    for (const argv of [
      ["npm", "exec", "-c", "sleep 9"],
      ["npx", "-c", "sleep 9"],
      ["npx", "cowsay", "moo"],
      ["npm", "exec", "--", "cowsay", "moo"],
    ]) {
      const { rt, pm, spawned } = await setup({ name: "app" }, untilSignalled);
      withBin(rt);
      const run = pm(...argv);
      await settled();
      expect(spawned).toHaveLength(1);
      rt.signal("SIGTERM");
      expect(await run).toBe(143);
      expect(rt.exitCode).toBe(143);
      expect(rt.stderr()).toBe("");
    }
  });

  it("npm reports a signal a Node process survives, and exits 1", async () => {
    // npm 10.9.2 and 11.20.0, `npm run usr1` (kill -USR1 $$), `npm run pipe`
    // and `npm run yes | head -1`: npm sends itself the signal, which Node
    // ignores (SIGPIPE) or starts its inspector on (SIGUSR1), and then says:
    for (const signal of ["SIGUSR1", "SIGPIPE"]) {
      const { rt, pm } = await setup({ scripts: { dev: "vite --port 1" } }, untilSignalled);
      const run = pm("npm", "run", "dev");
      await settled();
      rt.processes.kill(child(rt, 1), signal);
      expect(await run).toBe(1);
      expect(rt.exitCode).toBeNull();
      expect(rt.stderr()).toBe(
        "npm error path /project\n" +
          "npm error command failed\n" +
          `npm error signal ${signal}\n` +
          "npm error command sh -c vite --port 1\n",
      );
    }
    // `npx -c 'kill -USR1 $$'` and `npx selfusr1 a 'b c'` name their command the same way.
    const shell = await setup({ name: "app" }, untilSignalled);
    const viaShell = shell.pm("npx", "-c", "kill -USR1 $$");
    await settled();
    shell.rt.processes.kill(child(shell.rt, 1), "SIGUSR1");
    expect(await viaShell).toBe(1);
    expect(shell.rt.stderr()).toContain("npm error command sh -c kill -USR1 $$\n");
    const bin = await setup({ name: "app" }, untilSignalled);
    withBin(bin.rt);
    const viaBin = bin.pm("npx", "cowsay", "a", "b c");
    await settled();
    bin.rt.processes.kill(child(bin.rt, 1), "SIGUSR1");
    expect(await viaBin).toBe(1);
    expect(bin.rt.stderr()).toContain("npm error command sh -c 'cowsay' a 'b c'\n");
  });

  it("pnpm takes a script that SIGINT ended for one that ended well, and goes on", async () => {
    // pnpm 9.12.1 under a pty: Ctrl+C on `pnpm run sleep` prints nothing and
    // pnpm exits 0; `pnpm run int2` (kill -INT $$) runs its post script.
    const { rt, pm, spawned } = await setup(manifest, untilSignalled);
    const run = pm("pnpm", "dev");
    await settled();
    rt.signal("SIGINT");
    expect(await run).toBe(0);
    expect(rt.exitCode).toBeNull();
    expect(rt.stderr()).toBe("");
    expect(spawned.map((request) => request.args[1])).toEqual(["echo pre", "vite", "echo post"]);
  });

  it("pnpm reports a script any other signal ended, and dies of that signal", async () => {
    // pnpm 9.12.1: `kill <pnpm>` and `pnpm run sig` (kill -TERM $$) print
    // " ELIFECYCLE  Command failed." and pnpm dies of SIGTERM.
    const { rt, pm, spawned } = await setup(manifest, untilSignalled);
    const run = pm("pnpm", "run", "dev");
    await settled();
    rt.signal("SIGTERM");
    expect(await run).toBe(143);
    expect(rt.exitCode).toBe(143);
    expect(rt.stderr()).toBe(" ELIFECYCLE  Command failed.\n");
    expect(spawned.map((request) => request.args[1])).toEqual(["echo pre", "vite"]);
    // `pnpm run sigkill`: SIGKILL ends pnpm before it has said anything.
    const killed = await setup({ scripts: { dev: "vite" } }, untilSignalled);
    const first = killed.pm("pnpm", "dev");
    await settled();
    killed.rt.processes.kill(child(killed.rt, 1), "SIGKILL");
    expect(await first).toBe(137);
    expect(killed.rt.exitCode).toBe(137);
    expect(killed.rt.stderr()).toBe("");
    // `pnpm run usr1`: Node survives the signal, so pnpm exits 1 after the line.
    const survived = await setup({ scripts: { dev: "vite" } }, untilSignalled);
    const second = survived.pm("pnpm", "dev");
    await settled();
    survived.rt.processes.kill(child(survived.rt, 1), "SIGUSR1");
    expect(await second).toBe(1);
    expect(survived.rt.exitCode).toBeNull();
    expect(survived.rt.stderr()).toBe(" ELIFECYCLE  Command failed.\n");
  });

  it("yarn dies of SIGINT at once, and reports a script a signal ended", async () => {
    // yarn 1.22.19 handles SIGTERM only: Ctrl+C on `yarn run sleep` ends
    // yarn itself; `yarn run sig` prints the line below and exits 1.
    const interrupted = await setup(manifest, untilSignalled);
    void interrupted.pm("yarn", "dev");
    await settled();
    interrupted.rt.signal("SIGINT");
    expect(interrupted.rt.exitCode).toBe(130);
    expect(interrupted.rt.stderr()).toBe("");

    const { rt, pm } = await setup(manifest, untilSignalled);
    const run = pm("yarn", "dev");
    await settled();
    rt.signal("SIGTERM");
    expect(await run).toBe(1);
    expect(rt.exitCode).toBeNull();
    expect(rt.stderr()).toBe('error Command failed with signal "SIGTERM".\n');
    expect(rt.stdout()).not.toContain("Done in");
  });

  it("a bin run by its name gets the signals its tool passes on", async () => {
    const pnpm = await setup({ name: "app" }, untilSignalled);
    withBin(pnpm.rt);
    const run = pnpm.pm("pnpm", "cowsay");
    await settled();
    pnpm.rt.signal("SIGINT");
    // The command's status, as a shell reports it; pnpm itself lives on.
    expect(await run).toBe(130);
    expect(pnpm.rt.exitCode).toBeNull();

    const yarn = await setup({ name: "app" }, untilSignalled);
    withBin(yarn.rt);
    void yarn.pm("yarn", "cowsay");
    await settled();
    yarn.rt.signal("SIGINT");
    expect(yarn.rt.exitCode).toBe(130);
  });
});

describe("output whose reader has gone", () => {
  const manifest = { name: "app", version: "1.2.3", scripts: { dev: "vite" } };
  /** Lets the tool get as far as waiting for its command. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("is no SIGPIPE to npm, pnpm or yarn: Node ignores it from their start", async () => {
    for (const tool of ["npm", "pnpm", "yarn"]) {
      const { rt, pm } = await setup(manifest, () => new Promise<number>(() => {}));
      const declared = vi.spyOn(rt.processes, "setHandledSignals");
      void pm(tool, "run", "dev");
      expect(declared.mock.calls[0]?.[0]).toContain("SIGPIPE");
      await settled();
      rt.signal("SIGPIPE");
      expect(rt.exitCode).toBe(null);
      // Before it runs anything, too.
      const idle = await setup(manifest);
      void idle.pm(tool, "ls");
      idle.rt.signal("SIGPIPE");
      expect(idle.rt.exitCode).toBe(null);
    }
  });

  it("ends npm with 1 at once, and leaves the script it started to run on to its end", async () => {
    // npm 11.20 on macOS and 10.9.8 on Linux: `set -o pipefail; npm run x |
    // true` with x `sleep 1; echo ran >> ran.log` gives 1 in about 0.1 s,
    // with ran.log not there yet; ran.log holds `ran` a second later.
    let finish = (_code: number) => {};
    const npm = await setup(
      manifest,
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    npm.rt.closeReader(1);
    let child = "running";
    const run = npm.pm("npm", "run", "dev").then((status) => ({ status, child }));
    expect(await run).toEqual({ status: 1, child: "running" });
    expect(npm.spawned.map((request) => request.args[1])).toEqual(["vite"]);
    expect(npm.rt.stderr()).toBe("");
    child = "ended";
    finish(0);
    // A script that fails, or that a signal ends, changes nothing: npm has ended.
    const failing = await setup(manifest, () => 3);
    failing.rt.closeReader(1);
    expect(await failing.pm("npm", "run", "dev")).toBe(1);
    expect(failing.spawned).toHaveLength(1);
    expect(failing.rt.stderr()).toBe("");
    // npm 11.20, 5 of 5: with a pre script, the pre script runs and nothing after it.
    const hooked = await setup({ ...manifest, scripts: { predev: "echo pre", dev: "vite" } });
    hooked.rt.closeReader(1);
    expect(await hooked.pm("npm", "run", "dev")).toBe(1);
    expect(hooked.spawned.map((request) => request.args[1])).toEqual(["echo pre"]);
    const yarn = await setup(manifest);
    yarn.rt.closeReader(1);
    expect(await yarn.pm("yarn", "run", "dev")).toBe(0);
    expect(yarn.spawned.map((request) => request.args[1])).toEqual(["vite"]);
  });

  it("lets pnpm survive its first lost write and die of the next", async () => {
    // pnpm 9.12.1, 5 runs each: `pnpm run x | true` with x alone runs x and
    // exits 0; with a pre script it runs the pre script, then dies of the
    // EPIPE of the next header (exit code 1, Node's report on stderr), and
    // neither the script nor its post script runs. Under `| head -1`, which
    // takes the first header, the script runs and its post script does not.
    const lone = await setup(manifest);
    lone.rt.closeReader(1);
    expect(await lone.pm("pnpm", "run", "dev")).toBe(0);
    expect(lone.spawned.map((request) => request.args[1])).toEqual(["vite"]);
    expect(lone.rt.stderr()).toBe("");
    const scripts = { predev: "echo pre", dev: "vite", postdev: "echo post" };
    const hooked = await setup({ ...manifest, scripts });
    hooked.rt.closeReader(1);
    expect(await hooked.pm("pnpm", "run", "dev")).toBe(1);
    expect(hooked.spawned.map((request) => request.args[1])).toEqual(["echo pre"]);
    expect(hooked.rt.stderr()).toBe(
      [
        "node:events:496",
        "      throw er; // Unhandled 'error' event",
        "      ^",
        "",
        "Error: write EPIPE",
        "Emitted 'error' event on Socket instance at:",
        "    at emitErrorNT (node:internal/streams/destroy:170:8)",
        "    at emitErrorCloseNT (node:internal/streams/destroy:129:3)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {",
        "  errno: -32,",
        "  code: 'EPIPE',",
        "  syscall: 'write'",
        "}",
        "",
        "Node.js v22.14.0",
        "",
      ].join("\n"),
    );
    let reader: FakeRuntime | null = null;
    const firstHeader = await setup({ ...manifest, scripts }, (request) => {
      if (request.args[1] === "echo pre") {
        reader?.closeReader(1);
      }
      return 0;
    });
    reader = firstHeader.rt;
    expect(await firstHeader.pm("pnpm", "run", "dev")).toBe(1);
    expect(firstHeader.spawned.map((request) => request.args[1])).toEqual(["echo pre", "vite"]);
    // A post script alone: the script runs, and pnpm dies before its post script.
    const post = await setup({ ...manifest, scripts: { dev: "vite", postdev: "echo post" } });
    post.rt.closeReader(1);
    expect(await post.pm("pnpm", "run", "dev")).toBe(1);
    expect(post.spawned.map((request) => request.args[1])).toEqual(["vite"]);
  });

  it("has had all of a script's header once it has its first line", async () => {
    // npm 11.20: `npm run hello | head -1` exits 0: the header is one write.
    const { rt, pm } = await setup(manifest);
    const writes = vi.spyOn(rt.fdStream, "write");
    expect(await pm("npm", "run", "dev")).toBe(0);
    const tried = writes.mock.calls
      .filter(([fd]) => fd === 1)
      .map(([, chunk]) => decoder.decode(chunk));
    expect(tried).toEqual(["\n> app@1.2.3 dev\n> vite\n\n"]);
  });

  it("leaves the status of a listing, its last act: npm ls exits 0", async () => {
    const { rt, pm } = await setup(manifest);
    rt.closeReader(1);
    expect(await pm("npm", "ls")).toBe(0);
    expect(rt.stdout()).toBe("");
  });

  it("gets nothing more once a write to it has failed", async () => {
    // yarn writes `yarn run v…` and the script's line before the first
    // write's EPIPE comes back, as Node's async stream does; `Done in …`,
    // written after it, is not tried.
    const { rt, pm } = await setup(manifest);
    rt.closeReader(1);
    const writes = vi.spyOn(rt.fdStream, "write");
    expect(await pm("yarn", "run", "dev")).toBe(0);
    const tried = writes.mock.calls
      .filter(([fd]) => fd === 1)
      .map(([, chunk]) => decoder.decode(chunk));
    expect(tried).toEqual([`yarn run v1.22.22\n`, "$ vite\n"]);
  });
});

describe("npm at log level silent", () => {
  const manifest = {
    name: "app",
    version: "1.2.3",
    scripts: { predev: "echo pre", dev: "vite", fail: "exit 4" },
  };
  /** Each way npm 11.20 takes the silent level: flags before or after the command, or the environment. */
  const silentRuns: { argv: string[]; env?: Record<string, string> }[] = [
    { argv: ["npm", "run", "-s", "dev"] },
    { argv: ["npm", "run", "--silent", "dev"] },
    { argv: ["npm", "-s", "run", "dev"] },
    { argv: ["npm", "run", "dev", "-s"] },
    { argv: ["npm", "run", "--loglevel", "silent", "dev"] },
    { argv: ["npm", "run", "--loglevel=silent", "dev"] },
    { argv: ["npm", "run", "dev"], env: { npm_config_loglevel: "silent" } },
    { argv: ["npm", "run", "dev"], env: { NPM_CONFIG_LOGLEVEL: "silent" } },
  ];

  it("prints no script header, and its children see the level", async () => {
    for (const { argv, env } of silentRuns) {
      const { rt, pm, spawned } = await setup(manifest);
      Object.assign(rt.env, env);
      expect(await pm(...argv)).toBe(0);
      expect(rt.stdout()).toBe("");
      expect(spawned.map((request) => request.args[1])).toEqual(["echo pre", "vite"]);
      expect(spawned[1].env.npm_config_loglevel).toBe("silent");
    }
    // npm 11.20: `npm run --loglevel warn env` prints the header and the
    // script sees `warn`; with no level set it sees none.
    const warn = await setup(manifest);
    expect(await warn.pm("npm", "run", "-q", "dev")).toBe(0);
    expect(warn.rt.stdout()).toContain("> app@1.2.3 dev\n");
    expect(warn.spawned[1].env.npm_config_loglevel).toBe("warn");
    const plain = await setup(manifest);
    expect(await plain.pm("npm", "run", "dev")).toBe(0);
    expect(plain.spawned[1].env.npm_config_loglevel).toBeUndefined();
  });

  it("gives the script's status under a closed pipe: nothing it printed lost its reader", async () => {
    // npm 11.20, 5 of 5: `npm run -s quiet | true` (quiet exits 4) gives 4,
    // `npm run --silent append | true` gives 0.
    for (const { argv, env } of silentRuns) {
      const { rt, pm } = await setup(manifest, (request) => (request.args[1] === "vite" ? 4 : 0));
      Object.assign(rt.env, env);
      rt.closeReader(1);
      expect(await pm(...argv)).toBe(4);
      expect(rt.stderr()).toBe("");
    }
  });

  it("prints no npm error lines, and no list of scripts", async () => {
    // npm 11.20: `npm run -s loud | true` (the script dies of SIGPIPE) gives 1
    // and prints nothing; `npm run -s nosuch` gives 1 and prints nothing;
    // `npm -s run` prints nothing; `npm -s ls` prints the tree.
    const signalled = await setup(manifest, () => new Promise<number>(() => {}));
    const run = signalled.pm("npm", "run", "-s", "dev");
    await new Promise((resolve) => setTimeout(resolve, 0));
    signalled.rt.processes.kill(signalled.rt.pid + 1, "SIGPIPE");
    expect(await run).toBe(1);
    expect(signalled.rt.stderr()).toBe("");
    const missing = await setup(manifest);
    expect(await missing.pm("npm", "run", "-s", "nosuch")).toBe(1);
    expect(missing.rt.stderr()).toBe("");
    const listing = await setup(manifest);
    expect(await listing.pm("npm", "-s", "run")).toBe(0);
    expect(listing.rt.stdout()).toBe("");
    const tree = await setup(manifest);
    expect(await tree.pm("npm", "-s", "ls")).toBe(0);
    expect(tree.rt.stdout()).toContain("app@1.2.3 /project");
  });
});

describe("scripts by name", () => {
  const manifest = {
    name: "app",
    version: "1.2.3",
    scripts: { dev: "vite", predev: "echo pre", postdev: "echo post", fail: "exit 3" },
  };

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
