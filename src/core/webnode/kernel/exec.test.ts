// @vitest-environment node
// What a command line runs: the tsx stand-in keeps Node's options and drops
// only tsx's own, and a command is found on the default PATH when the
// environment has none, as libuv does.
import { describe, expect, it } from "vitest";
import { installBuiltinCommands, resolveExec } from "./exec";
import { Vfs } from "./vfs/vfs";
import { O_CREAT, O_TRUNC, O_WRONLY } from "./vfs/types";

const APP = "/home/projects/app";

function withTsx(): { vfs: Vfs; env: Record<string, string> } {
  const vfs = new Vfs();
  installBuiltinCommands(vfs);
  vfs.mkdir(`${APP}/node_modules/tsx/dist`, true, 0o755);
  vfs.mkdir(`${APP}/node_modules/.bin`, true, 0o755);
  vfs.writeFile(
    `${APP}/node_modules/tsx/dist/cli.mjs`,
    new TextEncoder().encode("#!/usr/bin/env node\n"),
    O_WRONLY | O_CREAT | O_TRUNC,
    0o755,
  );
  vfs.symlink("../tsx/dist/cli.mjs", `${APP}/node_modules/.bin/tsx`);
  return { vfs, env: { PATH: `/bin:${APP}/node_modules/.bin` } };
}

describe("the tsx stand-in", () => {
  const argv = (args: string[]) => {
    const { vfs, env } = withTsx();
    return resolveExec(vfs, "tsx", args, env, APP).argv;
  };

  it("passes Node's options on to node", () => {
    expect(argv(["--env-file=.env", "src/server.ts"])).toEqual([
      "node",
      "--env-file=.env",
      "src/server.ts",
    ]);
    expect(argv(["--no-warnings", "--conditions", "dev", "x.ts", "--port", "3"])).toEqual([
      "node",
      "--no-warnings",
      "--conditions",
      "dev",
      "x.ts",
      "--port",
      "3",
    ]);
    expect(argv(["--import", "./setup.ts", "x.ts"])).toEqual([
      "node",
      "--import",
      "./setup.ts",
      "x.ts",
    ]);
  });

  it("drops tsx's own options with their values, and only before the script", () => {
    expect(argv(["--tsconfig", "tsconfig.app.json", "--no-cache", "x.ts", "--no-cache"])).toEqual([
      "node",
      "x.ts",
      "--no-cache",
    ]);
    expect(argv(["--tsconfig=tsconfig.app.json", "x.ts"])).toEqual(["node", "x.ts"]);
  });

  it("runs `watch` as node --watch, without the watch options", () => {
    expect(
      argv([
        "watch",
        "--ignore",
        "./data",
        "--clear-screen=false",
        "--include",
        "src/**",
        "--exclude",
        "tmp",
        "src/index.ts",
      ]),
    ).toEqual(["node", "--watch", "src/index.ts"]);
    expect(argv(["watch", "--env-file=.env", "src/index.ts"])).toEqual([
      "node",
      "--watch",
      "--env-file=.env",
      "src/index.ts",
    ]);
  });
});

describe("PATH", () => {
  it("falls back to the default PATH when the environment has none", () => {
    const vfs = new Vfs();
    installBuiltinCommands(vfs);
    vfs.mkdir("/app", true, 0o755);
    expect(resolveExec(vfs, "node", ["x.js"], { FOO: "1" }, "/app").program).toBe("node");
    expect(resolveExec(vfs, "ls", ["/"], {}, "/app").program).toBe("shell");
  });

  it("searches only the PATH it is given when there is one", () => {
    const vfs = new Vfs();
    installBuiltinCommands(vfs);
    vfs.mkdir("/app", true, 0o755);
    expect(() => resolveExec(vfs, "node", ["x.js"], { PATH: "/nowhere" }, "/app")).toThrow(
      /ENOENT/,
    );
  });
});
