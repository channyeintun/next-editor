// @vitest-environment node
// Traps and the exit status: what `$?` is after a signal's trap has run, and
// what an `exit` inside an EXIT trap makes the shell (or a subshell) end
// with. Each expectation is what bash prints for the same line.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { kernelShell, pause, setupRuntime, sh, spawnedShell, within } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

describe("`$?` after a signal's trap has run", () => {
  /**
   * Runs `line`, whose program `prog` exits 4 after 60 ms, and sends the
   * shell `signal` while it runs. Returns what the shell printed and its status.
   */
  async function signalled(line: string, signal: string) {
    const { rt } = setupRuntime({ externals: ["prog"], spawn: () => pause(60).then(() => 4) });
    rt.feedStdin(null);
    const done = runShell(["sh", "-c", line]);
    await pause(10);
    rt.signal(signal);
    const status = await done;
    return { out: rt.stdout(), status };
  }

  it("is the status of the command the signal came during, not of the trap's commands", async () => {
    // bash, with `sh -c 'sleep 0.5; exit 4'` for prog: the trap runs once it has ended.
    expect((await signalled("trap 'echo t' USR1; prog; echo st=$?", "SIGUSR1")).out).toBe(
      "t\nst=4\n",
    );
    expect((await signalled("trap 'echo t; false' TERM; prog; echo st=$?", "SIGTERM")).out).toBe(
      "t\nst=4\n",
    );
    expect(
      (await signalled("f() { return 6; }; trap f USR1; prog; echo st=$?", "SIGUSR1")).out,
    ).toBe("st=4\n");
  });

  it("is that status inside the trap too", async () => {
    expect((await signalled("trap 'echo in=$?' USR1; prog; echo out=$?", "SIGUSR1")).out).toBe(
      "in=4\nout=4\n",
    );
  });

  it("is the program's own status when the program sent the shell the signal and exited", async () => {
    // bash: `trap 'echo t; false' TERM; sh -c 'kill -TERM $PPID; exit 7'; echo st=$?`: t, st=7.
    const shell = spawnedShell(
      ["sh", "-c", "trap 'echo t; false' TERM; node seven.js; echo st=$?"],
      {
        programs: {
          "seven.js": (child, runtime) => {
            runtime.processes.kill(runtime.ppid, "SIGTERM");
            setTimeout(() => child.exit(7), 20);
          },
        },
      },
    );
    expect(await within(shell.exit)).toEqual({ code: 0, signal: null });
    expect(shell.output()).toBe("t\nst=7\n");
  });

  it("is 128 + the signal's number for a built-in program the terminal's Ctrl+C ended", async () => {
    // bash: `trap 'echo trapped' INT; cat; echo "after $?"`, Ctrl+C: trapped, after 130.
    const shell = kernelShell([
      "sh",
      "-c",
      "trap 'echo trapped' INT; echo up; cat; echo \"after $?\"",
    ]);
    expect(await shell.waitFor("up\n")).toBe(true);
    await pause(20);
    shell.type("\x03");
    expect(await within(shell.done)).toBe(0);
    expect(shell.output()).toContain("trapped\nafter 130\n");
  });

  it("is a built-in program's own status: a trapped signal does not reach it, whichever signal", async () => {
    // bash: `trap 'echo trapped' TERM; (sleep 0.2; kill -TERM $$) & sleep 1;
    // echo "after $?"; wait`: trapped, after 0, once the second is over.
    const term = await sh(
      "trap 'echo trapped' TERM; (sleep 0.03; kill -TERM $$) & sleep 0.2; echo \"after $?\"; wait",
    );
    expect(term.out).toBe("trapped\nafter 0\n");
    const usr1 = await sh(
      "trap 'echo trapped' USR1; (sleep 0.03; kill -USR1 $$) & sleep 0.2; echo \"after $?\"; wait",
    );
    expect(usr1.out).toBe("trapped\nafter 0\n");
  });

  it("is the status of the `kill` that sent the shell its own signal", async () => {
    const r = await sh("trap 'echo t; false' USR1; kill -USR1 $$; echo st=$?");
    expect(r.out).toBe("t\nst=0\n");
  });

  it("is what an `exit` without an operand in the trap ends the shell with: the trap's last status", async () => {
    // bash: `trap 'true; exit' USR1; …` ends with 0, the status of `true`,
    // and `trap 'false; exit' USR1; …` with 1.
    expect(await signalled("trap 'true; exit' USR1; prog; echo not-reached", "SIGUSR1")).toEqual({
      out: "",
      status: 0,
    });
    expect(await signalled("trap 'false; exit' USR1; prog; echo not-reached", "SIGUSR1")).toEqual({
      out: "",
      status: 1,
    });
  });
});

describe("`wait` that a trapped signal interrupts", () => {
  it("returns 128 + the signal's number, for a pid, a job and no operand", async () => {
    // Job 1 sends the signal, job 2 is waited for and still runs afterwards.
    const start = "trap 'echo got' USR1; (sleep 0.05; kill -USR1 $$) & sleep 5 &";
    expect((await sh(`${start} wait $!; echo st=$?; kill %2`)).out).toBe("got\nst=138\n");
    expect((await sh(`${start} wait %2; echo st=$?; kill %2`)).out).toBe("got\nst=138\n");
    expect((await sh(`${start} wait; echo st=$?; kill %2`)).out).toBe("got\nst=138\n");
  }, 5000);

  it("lets a wrapper pass the signal on to its child and then report the child's end", async () => {
    // The idiom of a script that forwards SIGTERM: both waits say 143.
    const r = await sh(
      "trap 'kill $child' TERM; sleep 30 & child=$!; (sleep 0.05; kill -TERM $$) & wait $child; echo first=$?; wait $child; echo second=$?",
    );
    expect(r.out).toBe("first=143\nsecond=143\n");
  }, 5000);
});

describe("`exit` in an EXIT trap", () => {
  it("sets the status the shell ends with", async () => {
    expect((await sh("trap 'exit 5' EXIT; true")).status).toBe(5);
    expect((await sh("trap 'exit 5' EXIT; exit 2")).status).toBe(5);
    const said = await sh("trap 'echo bye; exit 9' EXIT; echo run; exit 3");
    expect(said.out).toBe("run\nbye\n");
    expect(said.status).toBe(9);
  });

  it("sets it for a script file and for a script read from standard input", async () => {
    const file = await sh(["sh", "/work/t.sh"], {
      files: { "/work/t.sh": "trap 'exit 5' EXIT\nexit 2\n" },
    });
    expect(file.status).toBe(5);
    const piped = await sh(["sh"], { stdin: "trap 'exit 6' EXIT\ntrue\n" });
    expect(piped.status).toBe(6);
  });

  it("without an operand keeps the status the shell was ending with", async () => {
    // bash: 3 for both; the trap's own commands do not count.
    const said = await sh("trap 'echo bye; exit' EXIT; exit 3");
    expect(said.out).toBe("bye\n");
    expect(said.status).toBe(3);
    expect((await sh("trap 'false; exit' EXIT; exit 3")).status).toBe(3);
  });

  it("leaves the status alone when the trap only runs commands", async () => {
    expect((await sh("trap '(exit 5)' EXIT; exit 2")).status).toBe(2);
    expect((await sh("trap 'false' EXIT; true")).status).toBe(0);
  });

  it("sets the status of a subshell", async () => {
    expect((await sh("(trap 'exit 5' EXIT; exit 2); echo sub=$?")).out).toBe("sub=5\n");
    expect((await sh("(trap 'echo bye; exit' EXIT; exit 4); echo sub=$?")).out).toBe(
      "bye\nsub=4\n",
    );
    expect((await sh("x=$(trap 'exit 5' EXIT; echo in); echo $x $?")).out).toBe("in 5\n");
  });

  it("is not run by a shell that `exec` replaces", async () => {
    // bash: `trap 'echo bye' EXIT; exec echo replaced` prints replaced alone.
    expect((await sh("trap 'echo bye' EXIT; exec echo replaced")).out).toBe("replaced\n");
    expect((await sh("trap 'echo bye' EXIT; exec node x")).out).toBe("node x\n");
    expect((await sh("(trap 'echo bye' EXIT; exec echo replaced); echo after")).out).toBe(
      "replaced\nafter\n",
    );
    // An `exec` that only redirects replaces nothing, and neither does one
    // whose program cannot start: the shell ends as a shell does.
    expect((await sh("trap 'echo bye' EXIT; exec 3>&1; echo kept >&3")).out).toBe("kept\nbye\n");
    const failed = await sh("trap 'echo bye' EXIT; exec nosuch; echo not-reached");
    expect(failed.out).toBe("bye\n");
    expect(failed.status).toBe(127);
  });

  it("does not keep a shell that a signal ends from dying of the signal", async () => {
    // bash: `trap 'echo bye; exit 5' EXIT; kill -TERM $$`: bye, then Terminated.
    const shell = spawnedShell([
      "sh",
      "-c",
      "trap 'echo bye; exit 5' EXIT; kill -TERM $$; echo no",
    ]);
    expect(await within(shell.exit)).toEqual({ code: null, signal: "SIGTERM" });
    expect(shell.output()).toBe("bye\n");
  });
});

describe("a trap on a signal that does nothing by default", () => {
  it("runs for WINCH and URG the shell sends itself, and none runs for CHLD, as in bash 3.2", async () => {
    // bash: got / after / exit-trap; for CHLD only after.
    for (const signal of ["WINCH", "URG"]) {
      const r = await sh(
        `trap "echo got" ${signal}; trap "echo exit-trap" EXIT; kill -s ${signal} $$; echo after`,
      );
      expect({ signal, out: r.out }).toEqual({ signal, out: "got\nafter\nexit-trap\n" });
    }
    expect((await sh('trap "echo got" WINCH; kill -WINCH $$; kill -28 $$; echo after')).out).toBe(
      "got\ngot\nafter\n",
    );
    expect((await sh('trap "echo got" CHLD; kill -s CHLD $$; echo after')).out).toBe("after\n");
    expect((await sh("kill -s WINCH $$; echo after")).out).toBe("after\n");
  });
});
