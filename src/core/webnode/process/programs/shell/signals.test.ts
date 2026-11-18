// @vitest-environment node
// What signals do to a shell, on the real kernel: a shell another process
// started (`spawnedShell`: as `child_process.spawn('sh', ['-c', …])`) and an
// interactive jsh, each compared with what bash 3.2 does.
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRuntime } from "../../runtime";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { handledSignals } from "./signals";
import { deliverSignal, kernelShell, setupRuntime, spawnedShell } from "./testHelpers";
import type { ChildProgram, KernelChild, SpawnedShell } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

const encoder = new TextEncoder();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What `waiting` resolves to, or "still running" after `ms`. */
function within<T>(waiting: Promise<T>, ms = 1500): Promise<T | "still running"> {
  return Promise.race([
    waiting,
    new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), ms)),
  ]);
}

/** Waits (up to 3 s) until `ready` holds. */
async function until(ready: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline) {
    await pause(2);
  }
  return ready();
}

/** The signals each program of a test got, by the name it was started with (`node deaf.js A`: `A`). */
type Received = Record<string, string[]>;

/** A program that handles SIGINT, SIGTERM and SIGHUP, notes each and stays; it never reads. */
function deaf(received: Received): ChildProgram {
  return (child, runtime) => {
    const got = (received[child.argv[2] ?? child.argv[1]] = [] as string[]);
    runtime.processes.onSignal((signal) => {
      got.push(signal);
      return true;
    });
  };
}

/** As `deaf`, but it exits 0 after `ms`, whatever it got. */
function lasts(received: Received, ms: number): ChildProgram {
  return (child, runtime) => {
    deaf(received)(child, runtime);
    setTimeout(() => child.exit(0), ms);
  };
}

/** Says `text` on its standard output, then stays until a signal ends it. */
function says(text: string): ChildProgram {
  return (_child, runtime) => {
    runtime.fdStream.write(1, encoder.encode(text), () => {});
  };
}

/** The children of a shell started as `node <script> …`. */
function named(shell: { children(): KernelChild[] }, script: string): KernelChild[] {
  return shell.children().filter((child) => child.argv[1] === script);
}

/** Reads the parent's end of a pipe to its end. */
async function drain(parent: ProcessRuntime, fd: number): Promise<string> {
  let text = "";
  for (;;) {
    const chunk = await parent.fs.readAsync(fd, 65536, null);
    if (chunk.length === 0) {
      return text;
    }
    text += new TextDecoder().decode(chunk);
  }
}

describe("the signals a shell handles", () => {
  it("are the forwarded ones and the trapped ones", () => {
    expect([...handledSignals([])].sort()).toEqual(
      ["SIGHUP", "SIGINT", "SIGPIPE", "SIGQUIT", "SIGTERM"].sort(),
    );
    expect(handledSignals(["USR1", "SIGUSR2"]).has("SIGUSR1")).toBe(true);
    expect(handledSignals(["USR1", "SIGUSR2"]).has("SIGUSR2")).toBe(true);
    expect(handledSignals(["USR1"]).has("SIGALRM")).toBe(false);
  });

  it("with an EXIT trap are those that run it, so the trap runs first", () => {
    const handled = handledSignals(["EXIT"]);
    for (const signal of ["SIGUSR1", "SIGUSR2", "SIGALRM", "SIGABRT", "SIGXCPU"]) {
      expect(handled.has(signal)).toBe(true);
    }
    // Not the one no process handles, nor those that end nothing, nor those
    // that end bash without its EXIT trap.
    for (const signal of ["SIGKILL", "SIGCHLD", "SIGCONT", "SIGWINCH", "SIGSTOP", "SIGTSTP"]) {
      expect(handled.has(signal)).toBe(false);
    }
    for (const signal of ["SIGPROF", "SIGIO", "SIGPWR", "SIGSTKFLT"]) {
      expect(handled.has(signal)).toBe(false);
    }
  });
});

describe("a SIGINT, by where it came from", () => {
  /**
   * `sh -c line` on the fake runtime, with its program `prog` running: the
   * signals the shell passed on to it, and how the shell ended.
   */
  async function session(line: string, tty: boolean) {
    let finish = (_code: number): void => {};
    let pid = 0;
    const { rt } = setupRuntime({
      tty,
      externals: ["prog"],
      spawn: () => new Promise<number>((resolve) => (finish = resolve)),
    });
    rt.feedStdin(null);
    const spawn = rt.processes.spawn;
    rt.processes.spawn = (request) => {
      const handle = spawn(request);
      pid = handle.pid;
      return handle;
    };
    const passedOn: string[] = [];
    const kill = rt.processes.kill;
    rt.processes.kill = (target, signal) => {
      passedOn.push(signal);
      kill(target, signal);
    };
    const died: string[] = [];
    rt.processes.die = (signal) => died.push(signal);
    const done = runShell(["sh", "-c", line]);
    await pause(15);
    return {
      rt,
      passedOn,
      died,
      done,
      /** The program ends by itself. */
      finish: (code: number) => finish(code),
      /** The program dies of the SIGINT the terminal sent it. */
      interrupt: () => kill(pid, "SIGINT"),
    };
  }

  it("is the program's when the shell stands for it: passed on, unless the terminal sent it", async () => {
    // bash execs the lone command of `sh -c`, so child.kill('SIGINT') lands
    // on the program, whatever the shell's standard input is.
    for (const tty of [true, false]) {
      const killed = await session("prog", tty);
      deliverSignal(killed.rt, "SIGINT", false);
      expect(await killed.done).toBe(130);
      expect(killed.passedOn).toEqual(["SIGINT"]);
      expect(killed.died).toEqual(["SIGINT"]);
      // The terminal's reached the program with the shell: once is enough.
      const typed = await session("prog", tty);
      deliverSignal(typed.rt, "SIGINT", true);
      await pause(15);
      expect(typed.passedOn).toEqual([]);
      typed.finish(0);
      expect(await typed.done).toBe(0);
      expect(typed.died).toEqual([]);
    }
  });

  it("is never passed on by a shell with more to do, as in bash", async () => {
    for (const tty of [true, false]) {
      // bash: `sh -c 'node count.js; echo after'`, kill -INT of the shell:
      // the program gets none and runs on; then `after`.
      const killed = await session("prog; echo after", tty);
      deliverSignal(killed.rt, "SIGINT", false);
      await pause(15);
      expect(killed.passedOn).toEqual([]);
      killed.finish(0);
      expect(await killed.done).toBe(0);
      expect(killed.rt.stdout()).toBe("after\n");
      // bash: `true | sh -c 'node catch.js; true'` + ^C: caught once.
      const typed = await session("prog; echo after", tty);
      deliverSignal(typed.rt, "SIGINT", true);
      typed.interrupt();
      expect(await typed.done).toBe(130);
      expect(typed.passedOn).toEqual([]);
      expect(typed.died).toEqual(["SIGINT"]);
      expect(typed.rt.stdout()).toBe("");
    }
  });

  it("is passed on with every other signal that ends the shell", async () => {
    const s = await session("prog; echo after", false);
    s.rt.signal("SIGTERM");
    expect(await s.done).toBe(143);
    expect(s.passedOn).toEqual(["SIGTERM"]);
    expect(s.died).toEqual(["SIGTERM"]);
    expect(s.rt.stdout()).toBe("");
  });
});

describe("the terminal's Ctrl+C and a shell whose standard input is not the terminal", () => {
  it("reaches the program the shell waits for once", async () => {
    // bash: `true | sh -c 'node catch.js; true'` + ^C: caught once.
    for (const stdin of ["inherit", "ignore", "pipe"] as const) {
      const received: Received = {};
      const shell = spawnedShell(["sh", "-c", "node deaf.js A; true"], {
        stdio: [stdin, "inherit", "inherit"],
        programs: { "deaf.js": deaf(received) },
      });
      expect(await until(() => received.A !== undefined)).toBe(true);
      await pause(20);
      shell.type("\x03");
      await pause(60);
      expect({ stdin, got: received.A }).toEqual({ stdin, got: ["SIGINT"] });
    }
  });
});

describe("a SIGINT, by where it came from, on the real kernel", () => {
  it("lands on the program of `sh -c '<program>'` when kill sends it to the shell", async () => {
    // node: spawn('sh', ['-c', 'node s.js'], { stdio: 'inherit' }), then
    // child.kill('SIGINT'): exit null SIGINT.
    const shell = spawnedShell(["sh", "-c", "node stay.js"], { programs: { "stay.js": () => {} } });
    expect(await until(() => named(shell, "stay.js").length === 1)).toBe(true);
    await pause(20);
    shell.parent.processes.kill(shell.pid, "SIGINT");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGINT" });
    expect(named(shell, "stay.js")[0].terminated).toBe(true);
    // A program that handles it decides how the shell ends.
    const caught = spawnedShell(["sh", "-c", "node catch.js"], {
      programs: {
        "catch.js": (child, runtime) => {
          runtime.processes.onSignal(() => {
            child.exit(7);
            return true;
          });
        },
      },
    });
    expect(await until(() => named(caught, "catch.js").length === 1)).toBe(true);
    await pause(20);
    caught.parent.processes.kill(caught.pid, "SIGINT");
    expect(await within(caught.exit)).toEqual({ code: 7, signal: null });
  });

  it("reaches that program once when the terminal sends it, whatever the shell's standard input is", async () => {
    // bash: `true | sh -c 'node catch.js'` + ^C: caught once.
    for (const stdin of ["inherit", "ignore", "pipe"] as const) {
      const received: Received = {};
      const shell = spawnedShell(["sh", "-c", "node deaf.js A"], {
        stdio: [stdin, "inherit", "inherit"],
        programs: { "deaf.js": deaf(received) },
      });
      expect(await until(() => received.A !== undefined)).toBe(true);
      await pause(20);
      shell.type("\x03");
      await pause(60);
      expect({ stdin, got: received.A }).toEqual({ stdin, got: ["SIGINT"] });
    }
  });
});

describe("a signal sent to a shell whose output nobody reads", () => {
  /** `sh -c line` with its stdout a pipe the parent never reads; `signal` after 60 ms. */
  async function killed(line: string, signal: string) {
    const shell = spawnedShell(["sh", "-c", line], {
      stdio: ["ignore", "pipe", "inherit"],
      files: { "/home/projects/app/big.txt": "0123456789\n".repeat(30000) },
    });
    await pause(60);
    shell.parent.processes.kill(shell.pid, signal);
    return { exit: await within(shell.exit), output: shell.output() };
  }

  it("ends a pipeline whose last stage is a built-in filter, waiting for the full pipe", async () => {
    // bash: `node -e "spawn('sh', ['-c', 'seq 1 100000 | cat'])"`, never read,
    // then child.kill(): exit null SIGTERM.
    for (const line of [
      "seq 1 100000 | cat",
      "seq 1 100000 | tr 1 x",
      "seq 1 100000 | sed s/1/x/",
      "cat big.txt | cat | cat",
    ]) {
      expect({ line, exit: (await killed(line, "SIGTERM")).exit }).toEqual({
        line,
        exit: { code: null, signal: "SIGTERM" },
      });
    }
  });

  it("runs nothing after the pipeline", async () => {
    const ended = await killed("seq 1 100000 | cat; echo after >&2", "SIGHUP");
    expect(ended.exit).toEqual({ code: null, signal: "SIGHUP" });
    expect(ended.output).toBe("");
  });

  it("ends a filter fed by a command substitution's output", async () => {
    expect((await killed('x=$(seq 1 100000 | cat); echo "$x" | cat', "SIGTERM")).exit).toEqual({
      code: null,
      signal: "SIGTERM",
    });
  });

  it("ends on a SIGINT too: the commands are the shell's own", async () => {
    expect((await killed("seq 1 100000 | grep 1", "SIGINT")).exit).toEqual({
      code: null,
      signal: "SIGINT",
    });
  });

  it("ends a lone built-in command and a loop of builtins", async () => {
    expect((await killed("seq 1 100000", "SIGTERM")).exit).toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect((await killed("while :; do echo yyyyyyyyyyyyyyyyyyyy; done", "SIGTERM")).exit).toEqual({
      code: null,
      signal: "SIGTERM",
    });
  });
});

describe("a shell whose standard output has lost its reader", () => {
  /** `sh -c line` with stdout a pipe the parent closes: before the shell runs, or after its first output. */
  async function unread(line: string, close: "at once" | "after output" = "at once") {
    const shell = spawnedShell(["sh", "-c", line], { stdio: ["ignore", "pipe", "inherit"] });
    const fd = shell.stdio[1]!;
    let first = "";
    if (close === "after output") {
      first = new TextDecoder().decode(await shell.parent.fs.readAsync(fd, 4096, null));
    }
    shell.parent.fs.close(fd);
    return { exit: await within(shell.exit), first, shown: shell.output() };
  }

  it("dies of SIGPIPE at the write of a builtin, as bash does", async () => {
    // bash: `sh -c 'while :; do echo y; done' | head -n 1` ends; PIPESTATUS 141.
    const loop = await unread("while :; do echo y; done", "after output");
    expect(loop.first.startsWith("y\n")).toBe(true);
    expect(loop.exit).toEqual({ code: null, signal: "SIGPIPE" });
    // bash: `sh count.sh | head -1` prints no `finished`.
    const counted = await unread(
      "i=0; while [ $i -lt 100000 ]; do echo line $i; i=$((i+1)); done; echo finished >&2",
      "after output",
    );
    expect(counted.exit).toEqual({ code: null, signal: "SIGPIPE" });
    expect(counted.shown).toBe("");
    const inFunction = await unread("f() { while :; do printf '%s\\n' tick; done; }; f");
    expect(inFunction.exit).toEqual({ code: null, signal: "SIGPIPE" });
  });

  it("runs its EXIT trap first", async () => {
    const ended = await unread("trap 'echo bye >&2' EXIT; echo a; echo not-reached >&2");
    expect(ended.shown).toBe("bye\n");
    expect(ended.exit).toEqual({ code: null, signal: "SIGPIPE" });
  });

  it("ends only the subshell that wrote, with 141", async () => {
    const ended = await unread('(echo a; echo not-reached >&2); echo "sub=$?" >&2');
    expect(ended.shown).toBe("sub=141\n");
    expect(ended.exit).toEqual({ code: 0, signal: null });
  });

  it("goes on after a built-in program, a process of its own, that SIGPIPE ended", async () => {
    // bash: `sh -c 'seq 1 3; echo "seq=$?" >&2' | true` prints seq=141.
    const ended = await unread('seq 1 3; echo "seq=$?" >&2; cat /dev/null; echo "cat=$?" >&2');
    expect(ended.shown).toBe("seq=141\ncat=0\n");
    expect(ended.exit).toEqual({ code: 0, signal: null });
  });

  it("only fails the write when PIPE is ignored", async () => {
    // bash: echo: write error: Broken pipe, twice, then `still 1`.
    const ended = await unread("trap '' PIPE; echo a; echo b; echo \"still $?\" >&2");
    expect(ended.shown).toBe(
      "echo: write error: Broken pipe\necho: write error: Broken pipe\nstill 1\n",
    );
    expect(ended.exit).toEqual({ code: 0, signal: null });
  });

  it("fails the write of a program and of a subshell too when PIPE is ignored", async () => {
    // GNU seq: `seq: write error: Broken pipe`, status 1; bash's subshell: in-sub 1, sub=0.
    const ended = await unread(
      'trap \'\' PIPE; seq 1 3; echo "seq=$?" >&2; (echo a; echo "in-sub $?" >&2); echo "sub=$?" >&2',
    );
    expect(ended.shown).toBe(
      "seq: write error: Broken pipe\nseq=1\necho: write error: Broken pipe\nin-sub 1\nsub=0\n",
    );
    expect(ended.exit).toEqual({ code: 0, signal: null });
  });

  it("runs a PIPE trap after the write that failed", async () => {
    const ended = await unread(
      "trap 'echo trapped >&2; exit 3' PIPE; echo a; echo not-reached >&2",
    );
    expect(ended.shown).toBe("echo: write error: Broken pipe\ntrapped\n");
    expect(ended.exit).toEqual({ code: 3, signal: null });
  });
});

describe("Ctrl+C while a command substitution runs", () => {
  it("ends the shell before the command the substitution belongs to", async () => {
    // bash: `node ran.js "$(sleep 100)"; echo after` + ^C runs neither.
    const shell = spawnedShell([
      "sh",
      "-c",
      'echo up >&2; node ran.js "$(sleep 100)"; echo "after $?"',
    ]);
    expect(await shell.waitFor("up")).toBe(true);
    shell.type("\x03");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGINT" });
    expect(named(shell, "ran.js")).toEqual([]);
    expect(shell.output()).toBe("up\n^C\n");
  });

  it("ends it when the program inside caught the SIGINT and exited, as bash does", async () => {
    const shell = spawnedShell(["sh", "-c", 'echo "[$(node catch.js)]"; echo "after $?"'], {
      programs: {
        "catch.js": (child, runtime) => {
          runtime.processes.onSignal(() => {
            child.exit(0);
            return true;
          });
          runtime.fdStream.write(2, encoder.encode("up\n"), () => {});
        },
      },
    });
    expect(await shell.waitFor("up")).toBe(true);
    shell.type("\x03");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGINT" });
    expect(shell.output()).toBe("up\n^C\n");
  });

  it("goes on to the command when INT is trapped, and runs the trap after it", async () => {
    // bash: up, [], trapped, after 0.
    const shell = spawnedShell([
      "sh",
      "-c",
      'trap \'echo trapped\' INT; echo "[$(echo up >&2; sleep 100)]"; echo "after $?"',
    ]);
    expect(await shell.waitFor("up")).toBe(true);
    shell.type("\x03");
    expect(await within(shell.exit)).toEqual({ code: 0, signal: null });
    expect(shell.output()).toBe("up\n^C\n[]\ntrapped\nafter 0\n");
  });
});

describe("exec of a program the shell runs itself", () => {
  it("ends the shell of the signal that ended the program", async () => {
    // bash: `node par.js sh -c 'echo up >&2; exec sleep 100'` + ^C: child exit null SIGINT.
    for (const line of ["echo up >&2; exec sleep 100", "echo up >&2; exec cat"]) {
      const shell = spawnedShell(["sh", "-c", line]);
      expect(await shell.waitFor("up")).toBe(true);
      shell.type("\x03");
      expect({ line, exit: await within(shell.exit) }).toEqual({
        line,
        exit: { code: null, signal: "SIGINT" },
      });
    }
    const shell = spawnedShell(["sh", "-c", "echo up >&2; exec sleep 100"]);
    expect(await shell.waitFor("up")).toBe(true);
    shell.parent.processes.kill(shell.pid, "SIGTERM");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("keeps the program's own status when no signal ended it", async () => {
    const shell = spawnedShell(["sh", "-c", "exec sleep 0.01"]);
    expect(await within(shell.exit)).toEqual({ code: 0, signal: null });
  });
});

describe("a program the shell runs as if it had exec'd it", () => {
  /** Handles SIGTERM as a server that shuts down: it notes the signal and exits 0 a little later. */
  function graceful(events: string[]): ChildProgram {
    return (child, runtime) => {
      runtime.processes.onSignal((signal) => {
        events.push(`program got ${signal}`);
        setTimeout(() => {
          events.push("program exits");
          child.exit(0);
        }, 40);
        return true;
      });
    };
  }

  /** `sh -c line`, `signal` once its program runs: how the shell ended, and in which order. */
  async function signalled(line: string, signal: string, programs: Record<string, ChildProgram>) {
    const events: string[] = [];
    const shell = spawnedShell(["sh", "-c", line], {
      programs: { "graceful.js": graceful(events), ...programs },
    });
    expect(await until(() => shell.children().length === 1)).toBe(true);
    await pause(20);
    shell.parent.processes.kill(shell.pid, signal);
    const exit = await within(shell.exit);
    events.push("shell ended");
    await pause(60);
    return { exit, events, shell };
  }

  it("gets the signals sent to the shell, which ends as the program does", async () => {
    // bash execs the lone command of `sh -c`: the signal lands on the program.
    for (const line of ["node graceful.js", "exec node graceful.js", "FOO=1 node graceful.js"]) {
      const ended = await signalled(line, "SIGTERM", {});
      expect({ line, exit: ended.exit, events: ended.events }).toEqual({
        line,
        exit: { code: 0, signal: null },
        events: ["program got SIGTERM", "program exits", "shell ended"],
      });
    }
  });

  it("gets the signals the shell would have died of at once", async () => {
    // nodemon restarts `sh -c 'node app.js'` with SIGUSR2.
    const ended = await signalled("node stay.js", "SIGUSR2", { "stay.js": () => {} });
    expect(ended.exit).toEqual({ code: null, signal: "SIGUSR2" });
    expect(named(ended.shell, "stay.js")[0].terminated).toBe(true);
  });

  it("is not what a shell with more to do runs: that shell ends at once, as bash does", async () => {
    const ended = await signalled("node graceful.js; echo next", "SIGTERM", {});
    expect(ended.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(ended.events).toEqual(["program got SIGTERM", "shell ended", "program exits"]);
    expect(ended.shell.output()).toBe("");
  });
});

describe("a signal a shell sends itself", () => {
  async function run(line: string) {
    const shell = spawnedShell(["sh", "-c", line]);
    return { exit: await within(shell.exit), shown: shell.output() };
  }

  it("ends it before the next command", async () => {
    // bash: `sh -c 'kill -TERM $$; echo after'`: Terminated, no `after`.
    expect(await run("kill -TERM $$; echo after")).toEqual({
      exit: { code: null, signal: "SIGTERM" },
      shown: "",
    });
    expect((await run("kill -TERM $$")).exit).toEqual({ code: null, signal: "SIGTERM" });
    expect((await run("kill -INT $$; echo a")).exit).toEqual({ code: null, signal: "SIGINT" });
    expect((await run("kill -HUP $$; echo a")).exit).toEqual({ code: null, signal: "SIGHUP" });
    expect((await run("kill -QUIT $$; echo a")).exit).toEqual({ code: null, signal: "SIGQUIT" });
    expect(await run("kill -PIPE $$; echo a")).toEqual({
      exit: { code: null, signal: "SIGPIPE" },
      shown: "",
    });
    expect(await run("die() { kill -s TERM $$; }; f() { die; echo in-f; }; f; echo after")).toEqual(
      {
        exit: { code: null, signal: "SIGTERM" },
        shown: "",
      },
    );
  });

  it("runs its trap before the next command", async () => {
    // bash: T, after.
    expect(await run("trap 'echo T' TERM; kill -TERM $$; echo after")).toEqual({
      exit: { code: 0, signal: null },
      shown: "T\nafter\n",
    });
    expect((await run("trap 'echo got' USR1; kill -USR1 $$; echo next")).shown).toBe("got\nnext\n");
    // The idiom that passes a signal on once the cleanup is done.
    expect(
      await run(
        "trap 'echo cleanup; trap - INT; kill -INT $$' INT; kill -INT $$; echo not-reached",
      ),
    ).toEqual({ exit: { code: null, signal: "SIGINT" }, shown: "cleanup\n" });
  });

  it("runs the EXIT trap before a signal ends it, whichever signal", async () => {
    // bash: exit-trap, then the shell dies of the signal.
    expect(await run("trap 'echo exit-trap' EXIT; kill -USR1 $$; echo not-reached")).toEqual({
      exit: { code: null, signal: "SIGUSR1" },
      shown: "exit-trap\n",
    });
    expect(
      await run("trap 'echo exit-trap; echo twice' EXIT; kill -TERM $$; echo not-reached"),
    ).toEqual({ exit: { code: null, signal: "SIGTERM" }, shown: "exit-trap\ntwice\n" });
  });

  it("runs the EXIT trap for the signals bash runs it for, and for no other", async () => {
    // /bin/bash 3.2, signal by signal: `trap 'echo exit-trap' EXIT; kill -s SIG $$; echo no`
    // shows exit-trap and dies of SIG, except for QUIT, PROF and KILL, which show nothing.
    // With a trap on the signal too (`trap 'echo got' SIG`), it shows got, after, exit-trap.
    const runsIt = ["HUP", "INT", "ILL", "TRAP", "ABRT", "FPE", "BUS", "SEGV", "SYS", "PIPE"];
    runsIt.push("ALRM", "TERM", "USR1", "USR2", "XCPU", "XFSZ", "VTALRM");
    for (const name of [...runsIt, "QUIT", "PROF", "KILL"]) {
      const untrapped = await run(`trap 'echo exit-trap' EXIT; kill -s ${name} $$; echo no`);
      expect({ name, ...untrapped }).toEqual({
        name,
        exit: { code: null, signal: `SIG${name}` },
        shown: runsIt.includes(name) ? "exit-trap\n" : "",
      });
      if (name === "KILL") {
        continue;
      }
      const trapped = await run(
        `trap 'echo exit-trap' EXIT; trap 'echo got' ${name}; kill -s ${name} $$; echo after`,
      );
      expect({ name, ...trapped }).toEqual({
        name,
        exit: { code: 0, signal: null },
        shown: "got\nafter\nexit-trap\n",
      });
    }
  });

  it("reaches it with its process group", async () => {
    expect(await run("kill -TERM 0; echo after")).toEqual({
      exit: { code: null, signal: "SIGTERM" },
      shown: "",
    });
    // The kernel's copy for the shell is not acted on a second time.
    expect(await run("trap 'echo T' TERM; kill -TERM 0; sleep 0.05; echo after")).toEqual({
      exit: { code: 0, signal: null },
      shown: "T\nafter\n",
    });
  });

  it("leaves the shell running when the signal ends nothing", async () => {
    expect(await run("kill -CONT $$; kill -WINCH $$; kill -URG $$; echo alive")).toEqual({
      exit: { code: 0, signal: null },
      shown: "alive\n",
    });
  });
});

describe("a signal another process sends a shell with an EXIT trap", () => {
  it("runs the trap, then ends the shell, without waiting for its program", async () => {
    const received: Received = {};
    const shell = spawnedShell(
      ["sh", "-c", "trap 'echo exit-trap' EXIT; node deaf.js A; echo after"],
      {
        programs: { "deaf.js": deaf(received) },
      },
    );
    expect(await until(() => received.A !== undefined)).toBe(true);
    shell.parent.processes.kill(shell.pid, "SIGUSR1");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGUSR1" });
    expect(shell.output()).toBe("exit-trap\n");
  });
});

describe("a trap set in a subshell", () => {
  it("leaves the signals the shell's process handles as its main shell set them", async () => {
    // bash: `trap 'echo got' USR2; (trap : USR1); …`, then SIGUSR2: got, after.
    const received: Received = {};
    const shell = spawnedShell(
      ["sh", "-c", "trap 'echo got' USR2; (trap : USR1); node lasts.js A; echo after"],
      { programs: { "lasts.js": lasts(received, 300) } },
    );
    expect(await until(() => received.A !== undefined)).toBe(true);
    await pause(20);
    shell.parent.processes.kill(shell.pid, "SIGUSR2");
    expect(await within(shell.exit)).toEqual({ code: 0, signal: null });
    expect(shell.output()).toBe("got\nafter\n");
  });
});

describe("SIGTERM or SIGHUP sent to a shell that waits for a pipeline", () => {
  /** `sh -c line`, `signal` once the programs named run; how it ended and what each got. */
  async function signalled(line: string, signal: string, names: string[]) {
    const received: Received = {};
    const shell = spawnedShell(["sh", "-c", line], { programs: { "deaf.js": deaf(received) } });
    expect(await until(() => names.every((name) => received[name] !== undefined))).toBe(true);
    await pause(20);
    shell.parent.processes.kill(shell.pid, signal);
    return { exit: await within(shell.exit), received, shown: shell.output() };
  }

  it("reaches every program of it and ends the shell at once", async () => {
    // bash: exit null SIGTERM at once, whatever the programs do.
    const both = await signalled("node deaf.js A | node deaf.js B", "SIGTERM", ["A", "B"]);
    expect(both.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(both.received).toEqual({ A: ["SIGTERM"], B: ["SIGTERM"] });
    const hangup = await signalled("node deaf.js A | node deaf.js B", "SIGHUP", ["A", "B"]);
    expect(hangup.exit).toEqual({ code: null, signal: "SIGHUP" });
    expect(hangup.received).toEqual({ A: ["SIGHUP"], B: ["SIGHUP"] });
  });

  it("does so while a stage of its own still runs", async () => {
    const filter = await signalled("node deaf.js A | cat", "SIGTERM", ["A"]);
    expect(filter.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(filter.received).toEqual({ A: ["SIGTERM"] });
    const sleeper = await signalled("sleep 4 | node deaf.js B", "SIGTERM", ["B"]);
    expect(sleeper.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(sleeper.received).toEqual({ B: ["SIGTERM"] });
  });

  it("ends a shell that waits for one program, and runs nothing after it", async () => {
    const list = await signalled("node deaf.js A; echo next", "SIGTERM", ["A"]);
    expect(list.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(list.shown).toBe("");
    const chain = await signalled("node deaf.js A && node deaf.js B", "SIGTERM", ["A"]);
    expect(chain.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(chain.received).toEqual({ A: ["SIGTERM"] });
  });
});

describe("a trapped signal sent to a shell that runs a command", () => {
  /** `sh -c line`; `signal` once `ready` holds; how it ended, what it printed, what each program got. */
  async function trapped(
    line: string,
    signal: string,
    ready: (shell: SpawnedShell, received: Received) => boolean,
  ) {
    const received: Received = {};
    const shell = spawnedShell(["sh", "-c", line], {
      programs: { "lasts.js": lasts(received, 300) },
    });
    expect(await until(() => ready(shell, received))).toBe(true);
    await pause(20);
    const sent = Date.now();
    shell.parent.processes.kill(shell.pid, signal);
    const exit = await within(shell.exit, 2500);
    return { exit, shown: shell.output(), received, took: Date.now() - sent };
  }

  const started = (names: string[]) => (_shell: SpawnedShell, received: Received) =>
    names.every((name) => received[name] !== undefined);
  const running = (shell: SpawnedShell) => shell.children().length > 0;

  it("is not passed on to the programs: they run on, and the trap runs once they have ended", async () => {
    // bash 3.2: `trap 'echo trapped' TERM; a | b; echo "after $?"` with a
    // SIGTERM from another process: the programs get none, trapped, after 0.
    const pipeline = await trapped(
      "trap 'echo trapped' TERM; node lasts.js A | node lasts.js B; echo \"after $?\"",
      "SIGTERM",
      started(["A", "B"]),
    );
    expect(pipeline.exit).toEqual({ code: 0, signal: null });
    expect(pipeline.shown).toBe("trapped\nafter 0\n");
    expect(pipeline.received).toEqual({ A: [], B: [] });
    for (const signal of ["SIGINT", "SIGHUP", "SIGUSR1", "SIGQUIT"]) {
      const short = signal.slice(3);
      const one = await trapped(
        `trap 'echo trapped ${short}' ${short}; node lasts.js A; echo "after $?"`,
        signal,
        started(["A"]),
      );
      expect(one.exit).toEqual({ code: 0, signal: null });
      expect(one.shown).toBe(`trapped ${short}\nafter 0\n`);
      expect(one.received).toEqual({ A: [] });
    }
  });

  it("leaves a built-in program running to its end", async () => {
    // bash: `trap 'echo trapped' TERM; sleep 0.4; echo "after $?"`: sleep is a
    // program of its own there, which the signal does not reach.
    const sleeper = await trapped(
      "trap 'echo trapped' TERM; node lasts.js A; sleep 0.4; echo \"after $?\"",
      "SIGTERM",
      (shell) => running(shell) && shell.children()[0].terminated,
    );
    expect(sleeper.exit).toEqual({ code: 0, signal: null });
    expect(sleeper.shown).toBe("trapped\nafter 0\n");
    expect(sleeper.took).toBeGreaterThanOrEqual(300);
    // bash: a, b, trapped, after 0: each stage is a process of its own.
    const stages = await trapped(
      "trap 'echo trapped' TERM; node lasts.js A | { sleep 0.2; echo a; } | { cat; echo b; }; echo \"after $?\"",
      "SIGTERM",
      started(["A"]),
    );
    expect(stages.exit).toEqual({ code: 0, signal: null });
    expect(stages.shown).toBe("a\nb\ntrapped\nafter 0\n");
    // bash: in-sub, trapped, after 0.
    const subshell = await trapped(
      "trap 'echo trapped' TERM; (node lasts.js A; sleep 0.1; echo in-sub); echo \"after $?\"",
      "SIGTERM",
      started(["A"]),
    );
    expect(subshell.exit).toEqual({ code: 0, signal: null });
    expect(subshell.shown).toBe("in-sub\ntrapped\nafter 0\n");
  });

  it("runs the trap at once while `wait` waits, which returns 128 + the signal", async () => {
    // bash: trapped, `wait 143` at once, and the job runs on: `again 0`.
    const waiting = await trapped(
      'trap \'echo trapped\' TERM; node lasts.js A & wait $!; echo "wait $?"; wait $!; echo "again $?"',
      "SIGTERM",
      started(["A"]),
    );
    expect(waiting.exit).toEqual({ code: 0, signal: null });
    expect(waiting.shown).toBe("trapped\nwait 143\nagain 0\n");
    expect(waiting.received).toEqual({ A: [] });
    const all = await trapped(
      "trap 'echo trapped' INT; sleep 3 & node lasts.js A & wait; echo \"wait $?\"; kill %1",
      "SIGINT",
      started(["A"]),
    );
    expect(all.exit).toEqual({ code: 0, signal: null });
    expect(all.shown).toBe("trapped\nwait 130\n");
    expect(all.took).toBeLessThan(1500);
  });
});

describe("`kill` of a background job that runs a pipeline of a program and a filter", () => {
  it("reaches the program while the shell's own stage still runs", async () => {
    const received: Received = {};
    const shell = kernelShell(["jsh"], {}, { "deaf.js": deaf(received) });
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("node deaf.js A | cat > log &\r");
    expect(await until(() => received.A !== undefined)).toBe(true);
    shell.type("kill %1\r");
    expect(await until(() => received.A.length > 0)).toBe(true);
    expect(received.A).toEqual(["SIGTERM"]);
    // deaf.js caught it: the job would outlive the shell, as a forked
    // subshell does, so it ends first.
    shell.type("kill -KILL %1; wait; echo ended $((6 * 7))\r");
    expect(await shell.waitFor("ended 42")).toBe(true);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });
});

describe("Ctrl+C on a loop of programs in jsh", () => {
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
  const plain = (text: string): string => text.replace(ANSI, "");

  /** Types `line` into a jsh, Ctrl+C once `run.js` runs, then `echo E $?`; what followed the ^C. */
  async function interrupted(line: string, programs: Record<string, ChildProgram>) {
    const shell = kernelShell(["jsh"], {}, programs);
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type(`${line}\r`);
    expect(await until(() => named(shell, "run.js").length > 0)).toBe(true);
    await pause(20);
    shell.type("\x03");
    await pause(150);
    shell.type("echo E $?\r");
    const back = await shell.waitFor(/E \d+\n/, 1500);
    const text = plain(shell.output());
    const started = named(shell, "run.js").length;
    shell.kernel.dispose();
    return { back, started, after: text.slice(text.indexOf("^C")) };
  }

  it("leaves the loop when the program died of it, as bash does", async () => {
    // bash 3.2: ^C, then the prompt; no `after1`.
    const loop = await interrupted("for i in 1 2 3; do node run.js; echo after$i; done", {
      "run.js": () => {},
    });
    expect(loop.back).toBe(true);
    expect(loop.started).toBe(1);
    expect(loop.after).not.toContain("after1");
    expect(loop.after).toContain("E 130\n");
    const endless = await interrupted("while :; do node run.js; done", { "run.js": () => {} });
    expect(endless.back).toBe(true);
    expect(endless.started).toBe(1);
    const pipeline = await interrupted("while :; do node run.js | cat; done", {
      "run.js": () => {},
    });
    expect(pipeline.back).toBe(true);
    expect(pipeline.started).toBe(1);
    // bash's subshell dies of the Ctrl+C itself, and the loop ends with it.
    const subshell = await interrupted("while :; do (node run.js; echo in-sub); done", {
      "run.js": () => {},
    });
    expect(subshell.back).toBe(true);
    expect(subshell.started).toBe(1);
    expect(subshell.after).not.toContain("in-sub");
  });

  it("goes on with a list outside a loop, as bash 3.2 does", async () => {
    const list = await interrupted("node run.js; echo next", { "run.js": () => {} });
    expect(list.after).toContain("next\n");
  });

  it("ends a subshell whose program died of it, and goes on after the subshell", async () => {
    // bash 3.2: the subshell dies of the Ctrl+C it got with its program; no
    // `in-sub`, then `next`.
    const subshell = await interrupted("(node run.js; echo in-sub); echo next $?", {
      "run.js": () => {},
    });
    expect(subshell.after).not.toContain("in-sub");
    expect(subshell.after).toContain("next 130\n");
    const group = await interrupted("{ node run.js; echo in-group; } | cat; echo next", {
      "run.js": () => {},
    });
    expect(group.after).not.toContain("in-group");
    expect(group.after).toContain("next\n");
  });

  it("goes on in a subshell whose program caught it and exited", async () => {
    const caught = await interrupted("(node run.js; echo in-sub); echo next", {
      "run.js": (child, runtime) => {
        runtime.processes.onSignal(() => {
          child.exit(0);
          return true;
        });
      },
    });
    expect(caught.after).toContain("in-sub\nnext\n");
  });

  it("goes on when the program caught it and exited", async () => {
    // bash: caught, again.
    const caught = await interrupted("while :; do node run.js; echo again; break; done", {
      "run.js": (child, runtime) => {
        runtime.processes.onSignal(() => {
          child.exit(0);
          return true;
        });
      },
    });
    expect(caught.after).toContain("again\n");
    expect(caught.after).toContain("E 0\n");
  });
});

describe("a program a shell without job control starts with &", () => {
  /** A shell whose `srv.js` and `wait.js` run; the terminal's Ctrl+C is typed once both do. */
  async function interruptBoth(shell: SpawnedShell | ReturnType<typeof kernelShell>) {
    expect(
      await until(
        () => named(shell, "srv.js").length === 1 && named(shell, "wait.js").length === 1,
      ),
    ).toBe(true);
    await pause(20);
    shell.type("\x03");
    expect(await until(() => named(shell, "wait.js")[0].terminated)).toBe(true);
    await pause(20);
    return named(shell, "srv.js")[0].terminated;
  }

  it("stays in the shell's process group, so the terminal's Ctrl+C reaches it", async () => {
    // bash + node: `sh -c 'node srv.js & node wait.js'`, ^C: the server is gone too.
    const shell = spawnedShell(["sh", "-c", "node srv.js & node wait.js"], {
      programs: { "srv.js": () => {}, "wait.js": () => {} },
    });
    expect(await interruptBoth(shell)).toBe(true);
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGINT" });
  });

  it("does so in a subshell of an interactive shell too", async () => {
    const shell = kernelShell(["jsh"], {}, { "srv.js": () => {}, "wait.js": () => {} });
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("(node srv.js & node wait.js)\r");
    expect(await interruptBoth(shell)).toBe(true);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("is a job of its own under job control: the Ctrl+C leaves it", async () => {
    const shell = kernelShell(["jsh"], {}, { "srv.js": () => {}, "wait.js": () => {} });
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("node srv.js &\r");
    expect(await until(() => named(shell, "srv.js").length === 1)).toBe(true);
    shell.type("node wait.js\r");
    expect(await interruptBoth(shell)).toBe(false);
    shell.type("kill %1; exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("reads /dev/null, not the shell's input", async () => {
    // bash: `sh -c 'cat & wait; echo st=$?'` prints st=0 at once.
    const shell = spawnedShell(["sh", "-c", "cat & wait; echo st=$?"]);
    expect(await within(shell.exit)).toEqual({ code: 0, signal: null });
    expect(shell.output()).toBe("st=0\n");
  });
});

describe("what a shell writes before a signal ends it", () => {
  it("is all read by its parent", async () => {
    const shell = spawnedShell(["sh", "-c", "echo one; echo two; kill -TERM $$; echo three"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const text = drain(shell.parent, shell.stdio[1]!);
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGTERM" });
    expect(await within(text)).toBe("one\ntwo\n");
  });

  it("says what a program printed", async () => {
    const shell = spawnedShell(["sh", "-c", "node hello.js"], {
      programs: { "hello.js": says("hello\n") },
    });
    expect(await shell.waitFor("hello\n")).toBe(true);
    shell.parent.processes.kill(shell.pid, "SIGTERM");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGTERM" });
  });
});

describe("a signal sent to an interactive shell", () => {
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

  /** A jsh another process started, at its first prompt. */
  async function jsh(programs: Record<string, ChildProgram> = {}): Promise<SpawnedShell> {
    const shell = spawnedShell(["jsh"], { programs });
    expect(await shell.waitFor("❯")).toBe(true);
    return shell;
  }

  /** Types `line` and waits for the prompt that follows it. */
  async function typed(shell: SpawnedShell, line: string): Promise<void> {
    const prompts = shell.output().split("❯").length;
    shell.type(`${line}\r`);
    expect(await until(() => shell.output().split("❯").length > prompts)).toBe(true);
  }

  it("ends it when it is a hangup, as bash: the shell dies of SIGHUP", async () => {
    const shell = await jsh();
    shell.parent.processes.kill(shell.pid, "SIGHUP");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGHUP" });
  });

  it("runs the EXIT trap before the hangup ends it", async () => {
    const shell = await jsh();
    await typed(shell, "trap 'echo exit-trap-ran' EXIT");
    shell.parent.processes.kill(shell.pid, "SIGHUP");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGHUP" });
    // On the prompt's own line, as in bash: nothing was typed to end it.
    expect(shell.output().replace(ANSI, "")).toMatch(/❯ exit-trap-ran\n$/);
  });

  it("hangs up the program it waits for and its background jobs with it", async () => {
    const received: Received = {};
    const shell = await jsh({ "deaf.js": deaf(received) });
    await typed(shell, "node deaf.js job &");
    await typed(shell, "{ node deaf.js group; echo after; } &");
    shell.type("node deaf.js front\r");
    expect(await until(() => ["job", "group", "front"].every((name) => received[name]))).toBe(true);
    await pause(20);
    shell.parent.processes.kill(shell.pid, "SIGHUP");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGHUP" });
    expect(received).toEqual({ job: ["SIGHUP"], group: ["SIGHUP"], front: ["SIGHUP"] });
  });

  it("leaves a job it has disowned running", async () => {
    const received: Received = {};
    const shell = await jsh({ "deaf.js": deaf(received) });
    await typed(shell, "node deaf.js kept &");
    expect(await until(() => received.kept !== undefined)).toBe(true);
    await typed(shell, "disown");
    shell.parent.processes.kill(shell.pid, "SIGHUP");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGHUP" });
    await pause(30);
    expect(received).toEqual({ kept: [] });
  });

  it("spares a job `disown -h` marked, and hangs up the others", async () => {
    const received: Received = {};
    const shell = await jsh({ "deaf.js": deaf(received) });
    await typed(shell, "node deaf.js spared &");
    await typed(shell, "node deaf.js hung &");
    expect(await until(() => received.spared !== undefined && received.hung !== undefined)).toBe(
      true,
    );
    await typed(shell, "disown -h %1");
    shell.parent.processes.kill(shell.pid, "SIGHUP");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGHUP" });
    await pause(30);
    expect(received).toEqual({ spared: [], hung: ["SIGHUP"] });
  });

  it("ends it while a command of its own runs", async () => {
    const shell = await jsh();
    // Three seconds of it at most: a shell that went on would end by itself.
    shell.type("i=0; while [ $i -lt 300 ]; do sleep 0.01; i=$((i+1)); done\r");
    await pause(50);
    shell.parent.processes.kill(shell.pid, "SIGHUP");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGHUP" });
  });

  it("is ignored when it is SIGTERM or SIGQUIT, as bash", async () => {
    const shell = await jsh();
    shell.parent.processes.kill(shell.pid, "SIGTERM");
    shell.parent.processes.kill(shell.pid, "SIGQUIT");
    await typed(shell, "echo still-$((40+2))");
    expect(shell.output()).toContain("\nstill-42\n");
    shell.type("exit 3\r");
    expect(await within(shell.exit)).toEqual({ code: 3, signal: null });
  });

  it("runs the EXIT trap before any other signal ends it", async () => {
    // bash: an interactive shell with an EXIT trap, SIGUSR1: the trap runs, then it dies of SIGUSR1.
    const shell = await jsh();
    await typed(shell, "trap 'echo exit-trap-ran' EXIT");
    shell.parent.processes.kill(shell.pid, "SIGUSR1");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGUSR1" });
    // On the prompt's own line, as in bash: nothing was typed to end it.
    expect(shell.output().replace(ANSI, "")).toMatch(/❯ exit-trap-ran\n$/);
  });

  it("ends it at once when nothing traps it and it is no hangup", async () => {
    const shell = await jsh();
    shell.parent.processes.kill(shell.pid, "SIGUSR1");
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGUSR1" });
  });
});
