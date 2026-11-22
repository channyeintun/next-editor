// @vitest-environment node
// Which `sh -c` lines only start one program, and that starting the program
// in the shell's place is what the shell would have done: the same command,
// the same arguments, the same environment.
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PATH } from "../../platform";
import { setRuntime } from "../../runtime";
import type { SpawnRequest } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import { initialEnvironment } from "./environment";
import { runShell } from "./index";
import { loneProgram } from "./interpreter";
import { isPlainWord, plainWords } from "./plainWords";

afterEach(() => {
  setRuntime(null);
});

const PROGRAMS = [
  "vite",
  "vite --host 0.0.0.0 --port 5173 --strictPort",
  "node server.js",
  "tsx watch server.ts",
  "vitest run --coverage.enabled=true",
  "./node_modules/.bin/vite build",
  "/bin/node main.js",
  "npx vite --host 0.0.0.0 --configLoader native",
];

describe("loneProgram", () => {
  it("is the words of a line that only starts a program", () => {
    for (const line of PROGRAMS) {
      expect(loneProgram(line)).toEqual(line.split(" "));
    }
    // The shell reads no more into space around the words, or into a comment.
    expect(loneProgram("  vite   --host  ")).toEqual(["vite", "--host"]);
    expect(loneProgram("vite --host # the dev server")).toEqual(["vite", "--host"]);
  });

  it("is null for a line the shell does more with", () => {
    const lines = [
      "",
      "vite && echo done",
      "vite || true",
      "vite; true",
      "vite | cat",
      "vite &",
      "! vite",
      "(vite)",
      "{ vite; }",
      "vite > out.log",
      "vite 2>&1",
      "vite < in.txt",
      "NODE_ENV=production vite",
      "PORT=1",
      "vite 'a b'",
      'vite "a"',
      "vite a\\ b",
      "vite $PORT",
      "vite ${PORT}",
      "vite $(pwd)",
      "vite `pwd`",
      "vite src/*.js",
      "vite src/?.js",
      "vite [ab].js",
      "vite ~/app",
      "vite {a,b}",
      "if true; then vite; fi",
      "for x in a; do vite; done",
      "vite\nnode x.js",
    ];
    expect(lines.filter((line) => loneProgram(line) !== null)).toEqual([]);
  });

  it("is null for a word the shell runs itself", () => {
    const lines = ["echo done", "cd src", "exit 3", "export A=1", "true", "test -f x", "ls"];
    expect(lines.filter((line) => loneProgram(line) !== null)).toEqual([]);
  });

  it("is what the shell starts for the line, with the environment the shell starts with", async () => {
    const env = { PATH: "/bin:/usr/bin", HOME: "/home", SHLVL: "2", npm_lifecycle_event: "dev" };
    for (const line of PROGRAMS) {
      const spawned: SpawnRequest[] = [];
      const rt = createFakeRuntime({
        cwd: "/project",
        env,
        spawn: (request) => {
          spawned.push(request);
          return 0;
        },
      });
      rt.vfs.mkdir("/project", true, 0o755);
      setRuntime(rt);
      expect(await runShell(["sh", "-c", line])).toBe(0);
      const program = loneProgram(line)!;
      expect(spawned.map((request) => [request.command, ...request.args])).toEqual([program]);
      expect(spawned[0].env).toEqual(initialEnvironment(env, "/project"));
      expect(spawned[0].cwd).toBe("/project");
    }
  });
});

describe("initialEnvironment", () => {
  it("adds what a shell sets as it starts, and keeps what is set", () => {
    expect(initialEnvironment({}, "/project")).toEqual({
      PWD: "/project",
      HOME: "/home",
      PATH: DEFAULT_PATH,
      SHELL: "/bin/jsh",
      USER: "user",
      SHLVL: "1",
    });
    expect(
      initialEnvironment({ PWD: "/old", HOME: "/h", SHLVL: "1", SHELL: "/bin/sh", A: "1" }, "/p"),
    ).toEqual({
      PWD: "/p",
      HOME: "/h",
      SHLVL: "2",
      SHELL: "/bin/sh",
      A: "1",
      PATH: DEFAULT_PATH,
      USER: "user",
    });
    expect(initialEnvironment({ SHLVL: "x" }, "/p").SHLVL).toBe("1");
  });
});

describe("plainWords", () => {
  it("takes words a shell reads nothing into, one space apart", () => {
    expect(plainWords("pnpm dev")).toEqual(["pnpm", "dev"]);
    expect(plainWords("npx vite --port=5173 src/main.js @scope/pkg a:b,c+d%e")).toEqual([
      "npx",
      "vite",
      "--port=5173",
      "src/main.js",
      "@scope/pkg",
      "a:b,c+d%e",
    ]);
    const lines = ["", " pnpm dev", "pnpm  dev", "pnpm dev ", "pnpm\tdev", "A=1 pnpm dev", "A=1"];
    expect(lines.filter((line) => plainWords(line) !== null)).toEqual([]);
    const special = [..."'\"\\$`*?[]{}()<>|&;!~#^\n"];
    expect(special.filter((character) => isPlainWord(`a${character}b`))).toEqual([]);
    expect(special.filter((character) => plainWords(`pnpm a${character}b`) !== null)).toEqual([]);
  });
});
