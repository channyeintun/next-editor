// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { completeLine, historyLine, isIncomplete, makePrompt } from "./interactive";
import { Shell } from "./interpreter";
import type { ProcessState } from "./interpreter";
import { readText, setupRuntime } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function plain(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

function testShell(): Shell {
  const process: ProcessState = {
    foreground: new Set(),
    exits: new Map(),
    pendingSignal: null,
    abort: new AbortController(),
    jobs: [],
    nextJobId: 1,
    interactive: true,
    history: [],
  };
  return new Shell({
    arg0: "jsh",
    positional: [],
    env: { HOME: "/home", PATH: "/bin" },
    cwd: "/work",
    process,
  });
}

describe("prompt", () => {
  it("shows home as ~ and colours the arrow by status", () => {
    expect(makePrompt("/home/projects/app", "/home", 0)).toBe(
      "\x1b[1;34m~/projects/app\x1b[0m \x1b[32m❯\x1b[0m ",
    );
    expect(makePrompt("/home", "/home", 1)).toBe("\x1b[1;34m~\x1b[0m \x1b[31m❯\x1b[0m ");
    expect(makePrompt("/homework", "/home", 0)).toContain("/homework");
  });

  it("detects unfinished input", () => {
    expect(isIncomplete("echo 'open")).toBe(true);
    expect(isIncomplete("ls &&")).toBe(true);
    expect(isIncomplete("echo ok")).toBe(false);
  });
});

describe("completion", () => {
  it("completes commands in command position and paths elsewhere", () => {
    setupRuntime({
      files: {
        "/work/src/a.js": "",
        "/work/src/b.js": "",
        "/work/README.md": "",
        "/work/.git/x": "",
        "/home/notes.txt": "",
      },
    });
    const shell = testShell();
    expect(completeLine(shell, "ech", 3).candidates).toEqual(["echo"]);
    expect(completeLine(shell, "nod", 3).candidates).toEqual(["node"]);
    expect(completeLine(shell, "ls && ech", 9).candidates).toEqual(["echo"]);
    expect(completeLine(shell, "cat s", 5)).toEqual({ start: 4, candidates: ["src/"] });
    expect(completeLine(shell, "cat src/", 8).candidates).toEqual(["src/a.js", "src/b.js"]);
    expect(completeLine(shell, "cat ", 4).candidates).toEqual(["README.md", "src/"]);
    expect(completeLine(shell, "cat .g", 6).candidates).toEqual([".git/"]);
    expect(completeLine(shell, "cat ~/no", 8).candidates).toEqual(["~/notes.txt"]);
    expect(completeLine(shell, "./sr", 4).candidates).toEqual(["./src/"]);
  });
});

describe("interactive jsh", () => {
  it("runs typed lines, keeps history and exits on Ctrl+D", async () => {
    const { rt, vfs } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    expect(rt.rawMode).toBe(true);
    rt.feedStdin("echo hello\r");
    await tick();
    rt.feedStdin("fail 3\r");
    await tick();
    rt.feedStdin("echo 'two\r");
    await tick();
    rt.feedStdin("lines'\r");
    await tick();
    rt.feedStdin("\x1b[A\x1b[A\r");
    await tick();
    rt.feedStdin("\x04");
    // Ctrl+D exits with the last command's status.
    expect(await done).toBe(3);
    const output = plain(rt.stdout());
    expect(output).toContain("/work ❯ echo hello\nhello\n");
    expect(output).toContain("> lines'\ntwo\nlines\n");
    // Up twice reaches `fail 3`: the multi-line entry is one entry.
    expect(output).toMatch(/fail 3\n.*fail 3\n/s);
    expect(rt.stdout()).toContain("\x1b[31m❯");
    // A quoted newline has no one-line form (joining it would change the
    // string), so that entry stays out of the one-command-per-line file.
    expect(readText(vfs, "/home/.jsh_history")).toBe("echo hello\nfail 3\nfail 3\n");
  });

  it("abandons the line on Ctrl+C and turns raw mode off while a command runs", async () => {
    let rawDuringCommand: boolean | null = null;
    const { rt } = setupRuntime({
      tty: true,
      spawn: (request, io) => {
        rawDuringCommand = rt.rawMode;
        io.writeStdout(`ran ${request.command}\n`);
        return 0;
      },
    });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("echo never\x03");
    await tick();
    rt.feedStdin("node\r");
    await tick();
    rt.feedStdin("exit 4\r");
    expect(await done).toBe(4);
    expect(rawDuringCommand).toBe(false);
    const output = plain(rt.stdout());
    expect(output).toContain("echo never^C\n");
    expect(output).not.toContain("\nnever\n");
    expect(output).toContain("ran node\n");
  });

  it("loads history from ~/.jsh_history", async () => {
    const { rt } = setupRuntime({
      tty: true,
      files: { "/home/.jsh_history": "echo from-history\n" },
    });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("\x1b[A\r");
    await tick();
    rt.feedStdin("\x04");
    await done;
    expect(plain(rt.stdout())).toContain("from-history\n");
  });

  it("completes with Tab", async () => {
    const { rt } = setupRuntime({ tty: true, files: { "/work/package.json": "{}\n" } });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("cat pack\t\r");
    await tick();
    rt.feedStdin("\x04");
    await done;
    expect(plain(rt.stdout())).toContain("{}\n");
  });
});

describe("history of multi-line commands (shell-10)", () => {
  it("joins lines the way bash's cmdhist does", () => {
    expect(historyLine("for i in 1 2\ndo echo $i\ndone")).toBe("for i in 1 2; do echo $i; done");
    expect(historyLine("if true\nthen\n  echo y\nfi")).toBe("if true; then echo y; fi");
    expect(historyLine("f() {\n  echo a\n}")).toBe("f() { echo a; }");
    expect(historyLine("echo a &&\necho b")).toBe("echo a && echo b");
    expect(historyLine("echo one")).toBe("echo one");
    // No one-line form keeps the meaning: a quoted newline.
    expect(historyLine("echo 'a\nb'")).toBeNull();
    expect(isIncomplete(historyLine("for i in 1 2\ndo echo $i\ndone") as string)).toBe(false);
  });

  it("runs a recalled multi-line loop again", async () => {
    const { rt, vfs } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("for i in 1 2\r");
    await tick();
    rt.feedStdin("do echo $i\r");
    await tick();
    rt.feedStdin("done\r");
    await tick();
    rt.feedStdin("\x1b[A\r");
    await tick();
    rt.feedStdin("\x04");
    expect(await done).toBe(0);
    expect(plain(rt.stdout()).match(/^[12]$/gm)).toEqual(["1", "2", "1", "2"]);
    expect(readText(vfs, "/home/.jsh_history")).toBe("for i in 1 2; do echo $i; done\n");
  });
});

describe("Ctrl+C in jsh (shell-1)", () => {
  it("stops a loop of builtins and returns to the prompt", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("while :; do :; done; echo NOT${x}REACHED\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    rt.signal("SIGINT");
    await tick();
    rt.feedStdin("echo $?\r");
    await tick();
    rt.feedStdin("exit 4\r");
    expect(await done).toBe(4);
    const output = plain(rt.stdout());
    expect(output).not.toContain("NOTREACHED");
    expect(output).toContain("130\n");
  }, 5000);
});
