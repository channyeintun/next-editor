// @vitest-environment node
// What a command line runs: `tsx`, the marker in /bin or the one a project
// installed, is the node program with tsx's arguments (watchOptions.test.ts
// has the arguments themselves); a command is found on the default PATH when
// the environment has none, as libuv does; and a file runs only as execve
// would run it.
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../process/programs/shell/commands";
import { TSX_WATCH_OPTION, tsxArguments } from "../process/programs/watchOptions";
import { installBuiltinCommands, resolveExec } from "./exec";
import { Vfs } from "./vfs/vfs";
import { O_CREAT, O_TRUNC, O_WRONLY } from "./vfs/types";

const APP = "/home/projects/app";

/** A project with tsx installed: its command is a link to the package's `dist/cli.<extension>`. */
function withTsx(extension = "mjs"): Vfs {
  const vfs = new Vfs();
  installBuiltinCommands(vfs);
  vfs.mkdir(`${APP}/node_modules/tsx/dist`, true, 0o755);
  vfs.mkdir(`${APP}/node_modules/.bin`, true, 0o755);
  vfs.writeFile(
    `${APP}/node_modules/tsx/dist/cli.${extension}`,
    new TextEncoder().encode("#!/usr/bin/env node\n"),
    O_WRONLY | O_CREAT | O_TRUNC,
    0o755,
  );
  vfs.symlink(`../tsx/dist/cli.${extension}`, `${APP}/node_modules/.bin/tsx`);
  return vfs;
}

describe("the tsx command", () => {
  const watch = ["watch", "--include", "views", "--env-file=.env", "src/server.ts", "--port", "3"];
  const plain = ["--tsconfig", "tsconfig.app.json", "--no-warnings", "x.ts", "--no-cache"];

  it("is the node program with tsx's arguments", () => {
    const vfs = withTsx();
    const env = { PATH: "/bin" };
    expect(resolveExec(vfs, "tsx", plain, env, APP)).toEqual({
      program: "node",
      argv: ["node", "--no-warnings", "x.ts", "--no-cache"],
      execArgv: [],
    });
    const resolved = resolveExec(vfs, "tsx", watch, env, APP);
    expect(resolved.argv).toEqual(["node", ...tsxArguments(watch)]);
    expect(resolved.argv[1].startsWith(`${TSX_WATCH_OPTION}=`)).toBe(true);
  });

  it("stands in for the tsx a project installed, which cannot run here as published", () => {
    for (const extension of ["mjs", "cjs"]) {
      const vfs = withTsx(extension);
      // A package manager runs a script with node_modules/.bin first on PATH,
      // so `tsx` is the installed one: its `#!/usr/bin/env node` line would
      // run tsx's own cli file.
      const env = { PATH: `${APP}/node_modules/.bin:/bin` };
      expect(resolveExec(vfs, "tsx", watch, env, APP)).toEqual({
        program: "node",
        argv: ["node", ...tsxArguments(watch)],
        execArgv: [],
      });
      // By its path, and by the package's file itself.
      expect(resolveExec(vfs, "./node_modules/.bin/tsx", plain, {}, APP).argv).toEqual([
        "node",
        "--no-warnings",
        "x.ts",
        "--no-cache",
      ]);
      expect(
        resolveExec(vfs, `${APP}/node_modules/tsx/dist/cli.${extension}`, ["x.ts"], {}, APP).argv,
      ).toEqual(["node", "x.ts"]);
    }
    // Another package's command with the same `#!` line runs as the script it is.
    const vfs = withTsx();
    vfs.rename(`${APP}/node_modules/tsx`, `${APP}/node_modules/not-tsx`);
    vfs.symlink("../not-tsx/dist/cli.mjs", `${APP}/node_modules/.bin/tool`);
    expect(resolveExec(vfs, "./node_modules/.bin/tool", ["a"], {}, APP).argv).toEqual([
      "node",
      "./node_modules/.bin/tool",
      "a",
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

  it("starts a command the shell implements as that command of a shell", () => {
    const vfs = new Vfs();
    installBuiltinCommands(vfs);
    vfs.mkdir("/app", true, 0o755);
    for (const name of ["seq", "yes"]) {
      expect(resolveExec(vfs, name, ["1", "2"], {}, "/app")).toMatchObject({
        program: "shell",
        argv: ["sh", "-c", `${name} "$@"`, name, "1", "2"],
      });
    }
  });

  it("has a file in /bin for every command the shell implements", () => {
    const vfs = new Vfs();
    installBuiltinCommands(vfs);
    vfs.mkdir("/app", true, 0o755);
    const missing = Object.keys(COMMANDS).filter((name) => {
      try {
        return resolveExec(vfs, name, [], {}, "/app").program !== "shell";
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
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

describe("permissions", () => {
  const encoder = new TextEncoder();
  function withApp(): Vfs {
    const vfs = new Vfs();
    installBuiltinCommands(vfs.privileged);
    vfs.mkdir(`${APP}/bin`, true, 0o755);
    return vfs;
  }
  function put(vfs: Vfs, path: string, text: string, mode: number): void {
    vfs.writeFile(path, encoder.encode(text), O_WRONLY | O_CREAT | O_TRUNC, mode);
    vfs.chmod(path, mode, true);
  }
  function refusal(run: () => unknown): { code?: string; syscall?: string; path?: string } {
    try {
      run();
    } catch (error) {
      const { code, syscall, path } = error as { code?: string; syscall?: string; path?: string };
      return { code, syscall, path };
    }
    throw new Error("expected the spawn to fail");
  }

  it("runs a file only with its execute bit, as execve does", () => {
    const vfs = withApp();
    put(vfs, `${APP}/script.js`, "console.log(1)\n", 0o644);
    put(vfs, `${APP}/run.sh`, "#!/bin/sh\necho hi\n", 0o644);
    put(vfs, `${APP}/plain`, "echo hi\n", 0o644);
    const commands = ["./script.js", "./run.sh", "./plain", `${APP}/run.sh`];
    expect(
      commands.map((command) => refusal(() => resolveExec(vfs, command, [], {}, APP))),
    ).toEqual(commands.map((command) => ({ code: "EACCES", syscall: "spawn", path: command })));
    // A directory never runs.
    expect(refusal(() => resolveExec(vfs, "./bin", [], {}, APP)).code).toBe("EACCES");
    // An interpreter given the file needs only to read it, which it does itself.
    expect(resolveExec(vfs, "node", ["script.js"], {}, APP).program).toBe("node");
    vfs.chmod(`${APP}/script.js`, 0o755, true);
    vfs.chmod(`${APP}/run.sh`, 0o700, true);
    vfs.chmod(`${APP}/plain`, 0o100, true);
    // The interpreter gets the path as the caller gave it, as binfmt_script
    // passes execve's filename: `$0` is `./run.sh`, and a refusal names it.
    expect(resolveExec(vfs, "./script.js", ["a"], {}, APP).argv).toEqual([
      "node",
      "./script.js",
      "a",
    ]);
    expect(resolveExec(vfs, "./run.sh", [], {}, APP).argv).toEqual(["sh", "./run.sh"]);
    // Execute without read: the kernel reads the `#!` line itself; the shell
    // that then opens the script is refused, as on Linux.
    expect(resolveExec(vfs, "./plain", [], {}, APP).argv).toEqual(["sh", "./plain"]);
    vfs.chmod(`${APP}/run.sh`, 0o100, true);
    expect(resolveExec(vfs, "./run.sh", [], {}, APP).program).toBe("shell");
  });

  it("searches PATH past what cannot run, and says EACCES when nothing else can", () => {
    const vfs = withApp();
    vfs.mkdir(`${APP}/other`, true, 0o755);
    put(vfs, `${APP}/bin/tool`, "#!/bin/sh\n", 0o644);
    const env = { PATH: `${APP}/bin:${APP}/other` };
    expect(refusal(() => resolveExec(vfs, "tool", [], env, APP))).toEqual({
      code: "EACCES",
      syscall: "spawn",
      path: "tool",
    });
    put(vfs, `${APP}/other/tool`, "#!/bin/sh\n", 0o755);
    expect(resolveExec(vfs, "tool", [], env, APP).argv).toEqual(["sh", `${APP}/other/tool`]);
    expect(refusal(() => resolveExec(vfs, "missing", [], env, APP)).code).toBe("ENOENT");
    // A directory on PATH that cannot be searched is passed over the same way.
    vfs.chmod(`${APP}/other`, 0o644, true);
    expect(refusal(() => resolveExec(vfs, "tool", [], env, APP)).code).toBe("EACCES");
    vfs.chmod(`${APP}/bin`, 0o755, true);
    vfs.chmod(`${APP}/bin/tool`, 0o755, true);
    expect(resolveExec(vfs, "tool", [], env, APP).argv).toEqual(["sh", `${APP}/bin/tool`]);
    // A relative PATH entry gives the path execvp builds from it, `bin/tool`.
    expect(resolveExec(vfs, "tool", [], { PATH: "bin" }, APP).argv).toEqual(["sh", "bin/tool"]);
  });

  it("needs search on every directory on the way, and on the working directory", () => {
    const vfs = withApp();
    put(vfs, `${APP}/bin/tool`, "#!/bin/sh\n", 0o755);
    vfs.chmod(`${APP}/bin`, 0o644, true);
    expect(refusal(() => resolveExec(vfs, "./bin/tool", [], {}, APP)).code).toBe("EACCES");
    vfs.chmod(`${APP}/bin`, 0o755, true);
    vfs.mkdir(`${APP}/closed`, true, 0o755);
    vfs.chmod(`${APP}/closed`, 0o644, true);
    expect(refusal(() => resolveExec(vfs, "node", ["-v"], {}, `${APP}/closed`))).toEqual({
      code: "EACCES",
      syscall: "spawn",
      path: "node",
    });
    // A child that stays in its parent's directory does not change into it.
    expect(resolveExec(vfs, "node", ["-v"], {}, `${APP}/closed`, false).program).toBe("node");
    vfs.chmod(APP, 0o600, true);
    expect(refusal(() => resolveExec(vfs, "node", ["-v"], {}, `${APP}/bin`)).code).toBe("EACCES");
    expect(resolveExec(vfs, "node", ["-v"], {}, `${APP}/bin`, false).program).toBe("node");
    vfs.chmod(APP, 0o755, true);
    expect(resolveExec(vfs, "node", ["-v"], {}, `${APP}/bin`).program).toBe("node");
  });
});
