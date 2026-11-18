// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { completeLine, historyLine, isIncomplete, makePrompt } from "./interactive";
import { CHUNK_READ } from "./io";
import { newProcessState, Shell } from "./interpreter";
import {
  kernelShell,
  readText,
  setupRuntime,
  terminalInterrupt,
  until,
  within,
} from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function plain(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

function testShell(): Shell {
  return new Shell({
    arg0: "jsh",
    positional: [],
    env: { HOME: "/home", PATH: "/bin" },
    cwd: "/work",
    umask: 0o022,
    process: newProcessState(true),
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

  it("reads the terminal by the shell's read size", async () => {
    const { rt } = setupRuntime({ tty: true });
    const asked: number[] = [];
    const readAsync = rt.fs.readAsync.bind(rt.fs);
    rt.fs.readAsync = (fd, length, position, signal) => {
      if (fd === 0) {
        asked.push(length);
      }
      return readAsync(fd, length, position, signal);
    };
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("echo hello\r");
    await tick();
    rt.feedStdin("\x04");
    expect(await done).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([CHUNK_READ]));
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

describe("history of multi-line commands", () => {
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

describe("keys typed ahead in jsh", () => {
  it("gives what was typed after the command line to the command", async () => {
    const shell = kernelShell(["jsh"]);
    expect(await shell.waitFor("❯")).toBe(true);
    // As bash on a BSD terminal: the keys are echoed once cat reads them.
    shell.type("cat\rline one\r");
    expect(await shell.waitFor("\nline one\nline one\n")).toBe(true);
    shell.type("\x04");
    shell.type('read x\rhello\recho "[$x]"\r');
    expect(await shell.waitFor("\n[hello]\n")).toBe(true);
    shell.type("exit\r");
    expect(await shell.done).toBe(0);
  });

  it("keeps keys typed ahead for the next prompt when the command does not read", async () => {
    const shell = kernelShell(["jsh"]);
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("true\recho again\r");
    expect(await shell.waitFor("\nagain\n")).toBe(true);
    // Shown by the line editor at the prompt, not echoed on a line of its own while `true` ran.
    expect(shell.output()).not.toContain("\necho again");
    shell.type("exit\r");
    expect(await shell.done).toBe(0);
  });
});

describe("background jobs in jsh", () => {
  it("keeps a background job running through a Ctrl+C for the foreground", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("sleep 30 &\r");
    await tick();
    rt.feedStdin("while :; do :; done\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    terminalInterrupt(rt);
    await tick();
    rt.feedStdin("jobs\r");
    await tick();
    rt.feedStdin("kill %1; wait %1; echo st=$?\r");
    await tick();
    rt.feedStdin("exit\r");
    expect(await done).toBe(0);
    const output = plain(rt.stdout());
    expect(output).toContain("jobs\n[1]+  Running                 sleep 30 &\n");
    expect(output).toContain("st=143\n");
  }, 5000);

  it("announces a job as bash does and reports it once done", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("true &\r");
    await tick();
    rt.feedStdin("echo next\r");
    await tick();
    rt.feedStdin("exit\r");
    expect(await done).toBe(0);
    expect(rt.stderr()).toMatch(/^\[1\] \d+\n$/);
    expect(plain(rt.stdout())).toContain("next\n[1]+  Done                    true\n");
  });
});

describe("Ctrl+C in jsh", () => {
  it("stops a loop of builtins and returns to the prompt", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("while :; do :; done; echo NOT${x}REACHED\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    terminalInterrupt(rt);
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

describe("a read of the terminal that returns no bytes while a line is being typed", () => {
  /** A jsh on a fake terminal; `mark()` makes its next read of the terminal return no bytes, once. */
  function jshWithMarks() {
    const { rt } = setupRuntime({ tty: true });
    let marks = 0;
    const readAsync = rt.fs.readAsync;
    rt.fs.readAsync = (fd, length, position, signal) => {
      if (fd === 0 && marks > 0) {
        marks -= 1;
        return Promise.resolve(new Uint8Array(0));
      }
      return readAsync(fd, length, position, signal);
    };
    return { rt, done: runShell(["jsh"]), mark: () => (marks += 1) };
  }

  it("is the Ctrl+D key once: the line stays and the prompt reads on", async () => {
    // An end of file typed at the terminal ends one read, not the input.
    const { rt, done, mark } = jshWithMarks();
    await tick();
    rt.feedStdin("a");
    await tick();
    mark();
    // The read that waits takes this key; the next one returns no bytes.
    rt.feedStdin("b");
    await tick();
    await tick();
    // And once more, after a key: not the second time in a row.
    mark();
    rt.feedStdin("c");
    await tick();
    await tick();
    rt.feedStdin("\x15echo STILL-$((1+1))\r");
    await tick();
    rt.feedStdin("exit 0\r");
    expect(await within(done)).toBe(0);
    expect(plain(rt.stdout())).toContain("\nSTILL-2\n");
  });

  it("leaves a jsh on the real terminal reading after text and two Ctrl+D typed while a command ran", async () => {
    const shell = kernelShell(["jsh"]);
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("sleep 0.2\r");
    await tick();
    shell.type("ab");
    shell.type("\x04");
    shell.type("\x04");
    // The prompt comes back with `ab` on it; Ctrl+U clears the line.
    expect(await until(() => plain(shell.output()).endsWith("❯ ab"))).toBe(true);
    shell.type("\x15echo STILL-$((1+1))\r");
    expect(await shell.waitFor("\nSTILL-2\n")).toBe(true);
    shell.type("exit 0\r");
    expect(await within(shell.done)).toBe(0);
  });

  it("ends the shell the second time in a row: the terminal's input is over", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("fail 3\r");
    await tick();
    rt.feedStdin("ab");
    await tick();
    // Every read from now on returns no bytes.
    rt.feedStdin(null);
    // The half-typed line is given up; the status is the last command's.
    expect(await within(done)).toBe(3);
    expect(plain(rt.stdout())).not.toContain("command not found");
  });
});

describe("a Ctrl+C that reaches jsh while no command runs", () => {
  it("abandons nothing of the command line typed after it", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    // The terminal's SIGINT, in the moment before the prompt takes the keys.
    terminalInterrupt(rt);
    await tick();
    rt.feedStdin("echo first; echo second\r");
    await tick();
    rt.feedStdin("exit\r");
    expect(await done).toBe(0);
    expect(plain(rt.stdout())).toContain("first\nsecond\n");
  });

  it("still runs its trap", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("trap 'echo trapped' INT\r");
    await tick();
    terminalInterrupt(rt);
    await tick();
    rt.feedStdin("echo first; echo second\r");
    await tick();
    rt.feedStdin("exit\r");
    expect(await done).toBe(0);
    expect(plain(rt.stdout())).toContain("trapped\nfirst\nsecond\n");
  });
});

describe("a Ctrl+C that arrives with the command line, before its command starts", () => {
  it("cancels the line and keeps what was typed after it", async () => {
    // bash: the terminal's interrupt key flushes the line typed before it;
    // the prompt shows ^C and starts over.
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await tick();
    rt.feedStdin("echo RAN-$((1+1))\r\x03echo st=$?");
    await tick();
    rt.feedStdin("\r");
    await tick();
    rt.feedStdin("exit\r");
    expect(await done).toBe(0);
    const output = plain(rt.stdout());
    expect(output).not.toContain("RAN-2");
    expect(output).toContain("^C\n");
    expect(output).toContain("st=130\n");
  });

  it("never starts the program the line names", async () => {
    const shell = kernelShell(["jsh"], {}, { "wait.js": () => {} });
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("node wait.js\r\x03");
    shell.type("echo st=$?\r");
    expect(await shell.waitFor("st=130\n")).toBe(true);
    expect(shell.children()).toEqual([]);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });
});

describe("what a killed foreground job leaves running (job control)", () => {
  /** Waits (up to 3 s) until `ready` holds. */
  async function until(ready: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) {
      await tick();
    }
    return ready();
  }

  it("keeps a Ctrl+C typed for a later command from it, as on Linux", async () => {
    // `node par.js` starts a server and is killed; the server runs on. On
    // Linux it stays in par.js's job's group, out of the foreground.
    for (const stdio of ["inherit", "pipe"] as const) {
      const shell = kernelShell(
        ["jsh"],
        {},
        {
          "par.js": (_child, runtime) => {
            runtime.processes.spawn({
              command: "node",
              args: ["srv.js"],
              cwd: runtime.cwd,
              env: runtime.env,
              stdio: [stdio, "inherit", "inherit"],
            });
          },
        },
      );
      expect(await shell.waitFor("❯")).toBe(true);
      shell.type("node par.js\r");
      const named = (script: string) => shell.children().find((c) => c.argv[1] === script);
      expect(await until(() => named("srv.js") !== undefined)).toBe(true);
      const par = named("par.js")!;
      const srv = named("srv.js")!;
      srv.send({ type: "post", op: "proc.kill", args: [par.pid, "SIGKILL"] });
      expect(await until(() => par.terminated)).toBe(true);
      // Back at the prompt.
      const shown = shell.output().length;
      expect(await until(() => shell.output().slice(shown).includes("❯"))).toBe(true);
      shell.type("node wait.js\r");
      expect(await until(() => named("wait.js") !== undefined)).toBe(true);
      shell.type("\x03");
      expect(await until(() => named("wait.js")!.terminated)).toBe(true);
      expect(srv.terminated).toBe(false);
      shell.type("exit 0\r");
      expect(await shell.done).toBe(0);
    }
  });
});

describe("Ctrl+C on a pipeline of a program and an in-process stage", () => {
  it("waits for every stage, so what the program prints on SIGINT appears", async () => {
    // bash: `node w.js | while read l; do sleep 1; done` + ^C shows the
    // writer's handler output, and $? is the last stage's 130.
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const shell = kernelShell(
      ["jsh"],
      {},
      {
        "w.js": (child, runtime) => {
          runtime.processes.onSignal(() => {
            clearInterval(timer);
            runtime.fdStream.write(2, encoder.encode("writer got SIGINT\n"), () => child.exit(3));
            return true;
          });
          timer = setInterval(() => runtime.fdStream.write(1, encoder.encode("x\n"), () => {}), 1);
        },
      },
    );
    try {
      expect(await shell.waitFor("❯")).toBe(true);
      shell.type("node w.js | while read l; do sleep 1; done\r");
      await new Promise((resolve) => setTimeout(resolve, 100));
      shell.type("\x03");
      expect(await shell.waitFor("writer got SIGINT")).toBe(true);
      shell.type("echo E $?\r");
      expect(await shell.waitFor("E 130")).toBe(true);
      // The prompt came back only once the writer had ended.
      const text = plain(shell.output());
      const interrupted = text.indexOf("^C");
      expect(text.indexOf("writer got SIGINT")).toBeLessThan(text.indexOf("❯", interrupted));
      shell.type("exit 0\r");
      expect(await shell.done).toBe(0);
    } finally {
      clearInterval(timer);
    }
  });
});
