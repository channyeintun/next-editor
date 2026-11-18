// @vitest-environment node
// Background jobs: what `wait` and `kill` say and do about them, and the
// signal listings of `kill -l` and `trap -l`. Each expectation is what bash
// does for the same line.
import { afterEach, describe, expect, it } from "vitest";
import { SIGNAL_NUMBERS } from "../../../signals";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { REMEMBERED_JOBS, addJob, forgetEndedJobs, forgetJob, newJobList } from "./jobs";
import type { Job } from "./jobs";
import {
  deliverSignal,
  kernelShell,
  pause,
  setupRuntime,
  sh,
  spawnedShell,
  until,
  within,
} from "./testHelpers";
import type { ChildProgram } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

describe("`wait` without operands", () => {
  it("returns 0 once every job has ended, whatever each ended with", async () => {
    expect((await sh("(exit 3) & (exit 4) & wait; echo st=$?")).out).toBe("st=0\n");
    expect((await sh("false & wait; echo st=$?")).out).toBe("st=0\n");
    expect((await sh("sleep 30 & kill %1; wait; echo st=$?")).out).toBe("st=0\n");
    expect((await sh("fail 7 & wait; echo st=$?")).out).toBe("st=0\n");
  });
});

describe("`wait` for a pid or a job", () => {
  it("returns the job's status, and the same again when asked again", async () => {
    expect((await sh("(exit 3) & wait $!; echo st=$?; wait $!; echo again=$?")).out).toBe(
      "st=3\nagain=3\n",
    );
    expect((await sh("(exit 3) & p=$!; wait $p $p; echo st=$?")).out).toBe("st=3\n");
    expect((await sh("fail 7 & wait %1; echo st=$?")).out).toBe("st=7\n");
  });

  it("still knows a job that `jobs` has reported and dropped", async () => {
    const r = await sh("(exit 3) & sleep 0.05; jobs; jobs; wait $!; echo st=$?");
    expect(r.err).toBe("");
    expect(r.out).toBe("[1]+  Exit 3                  (exit 3)\nst=3\n");
  });

  it("says which operand is no child of the shell and which names no job", async () => {
    const pid = await sh("wait 99999; echo st=$?");
    expect(pid.err).toBe("sh: wait: pid 99999 is not a child of this shell\n");
    expect(pid.out).toBe("st=127\n");
    const job = await sh("wait %5; echo st=$?");
    expect(job.err).toBe("sh: wait: %5: no such job\n");
    expect(job.out).toBe("st=127\n");
  });
});

describe("`disown`", () => {
  it("takes the current job, the jobs named or every job off the list, as bash's", async () => {
    // Each line's output under /bin/bash 3.2 (its `line 0: ` prefix aside).
    const lines: [string, string, string][] = [
      ["disown; echo st=$?", "st=1\n", "sh: disown: current: no such job\n"],
      [
        "sleep 0.1 & sleep 0.1 & disown; echo st=$?; jobs",
        "st=0\n[1]+  Running                 sleep 0.1 &\n",
        "",
      ],
      [
        "sleep 0.1 & disown %3; echo st=$?; jobs",
        "st=1\n[1]+  Running                 sleep 0.1 &\n",
        "sh: disown: %3: no such job\n",
      ],
      ["sleep 0.1 & sleep 0.1 & disown -r; echo st=$?; jobs", "st=0\n", ""],
      ["sleep 0.1 & sleep 0.1 & disown %1 $!; echo st=$?; jobs", "st=0\n", ""],
      [
        "sleep 0.1 & disown -h %1; echo st=$?; jobs",
        "st=0\n[1]+  Running                 sleep 0.1 &\n",
        "",
      ],
      ["(exit 3) & sleep 0.05; disown; echo st=$?", "st=1\n", "sh: disown: current: no such job\n"],
      ["disown 99999; echo st=$?", "st=1\n", "sh: disown: 99999: no such job\n"],
      [
        "disown -x; echo st=$?",
        "st=2\n",
        "sh: disown: -x: invalid option\ndisown: usage: disown [-h] [-ar] [jobspec ...]\n",
      ],
    ];
    for (const [line, out, err] of lines) {
      const r = await sh(line);
      expect({ line, out: r.out, err: r.err }).toEqual({ line, out, err });
    }
  });
});

describe("job specs", () => {
  it("name a job in every form bash 3.2 takes, for kill, wait, disown, jobs, fg and bg", async () => {
    // Each line's output under /bin/bash 3.2 (its `line 0: ` prefix aside,
    // and without the `Terminated` line a non-interactive bash prints).
    const lines: [string, string, string][] = [
      [
        "sleep 3 & sleep 4 & sleep 5 & kill %-; wait %2; echo $?; kill %%; wait %3; echo $?; kill %+x; wait %1; echo $?",
        "143\n143\n143\n",
        "",
      ],
      [
        "sleep 3 & sleep 4 & kill %?4; wait %2; echo $?; kill '%sleep 3'; wait %1; echo $?",
        "143\n143\n",
        "",
      ],
      ["sleep 3 & kill %; wait %1; echo $?", "143\n", ""],
      ["sleep 3 & kill %-1; wait %1; echo $?", "143\n", ""],
      [
        "sleep 3 & kill sleep; echo $?; kill %1",
        "1\n",
        "sh: kill: sleep: arguments must be process or job IDs\n",
      ],
      [
        "sleep 1 & sleep 2 & kill %sl; echo $?; kill %?; echo $?; kill %nope %?zz %0; echo $?; kill %1 %2",
        "1\n1\n1\n",
        "sh: kill: sl: ambiguous job spec\nsh: kill: : ambiguous job spec\nsh: kill: %nope: no such job\nsh: kill: %?zz: no such job\nsh: kill: %0: no such job\n",
      ],
      [
        "sleep 1 & kill %nope %1; echo $?; kill 99999 abc; echo $?",
        "0\n1\n",
        "sh: kill: %nope: no such job\nsh: kill: (99999) - No such process\nsh: kill: abc: arguments must be process or job IDs\n",
      ],
      [
        "kill %+; echo $?; kill %-; echo $?",
        "1\n1\n",
        "sh: kill: %+: no such job\nsh: kill: %-: no such job\n",
      ],
      ["sleep 0.2 & disown %+; jobs; echo $?", "0\n", ""],
      ["sleep 0.2 & disown %sle; jobs; echo $?", "0\n", ""],
      ["sleep 0.2 & disown sleep; echo $?; jobs", "0\n", ""],
      [
        "sleep 1 & sleep 0.2 & disown %sleep; echo $?; disown %?0.2; echo $?; jobs; kill %1",
        "1\n0\n[1]+  Running                 sleep 1 &\n",
        "sh: disown: sleep: ambiguous job spec\nsh: disown: %sleep: no such job\n",
      ],
      [
        "sleep 1 & sleep 1 & wait %sl; echo $?; wait sleep; echo $?; kill %1 %2",
        "127\n1\n",
        "sh: wait: sl: ambiguous job spec\nsh: wait: `sleep': not a pid or valid job spec\n",
      ],
      [
        "sleep 0.05 & wait %?0.05; echo $?; wait %-; echo $?",
        "0\n127\n",
        "sh: wait: %-: no such job\n",
      ],
      [
        "sleep 1 & sleep 2 & jobs %sl; echo $?; jobs %- %nope; echo $?; jobs 2; kill %1 %2",
        "1\n[1]-  Running                 sleep 1 &\n1\n[2]+  Running                 sleep 2 &\n",
        "sh: jobs: sl: ambiguous job spec\nsh: jobs: %sl: no such job\nsh: jobs: %nope: no such job\n",
      ],
      [
        "fg; echo $?; fg %1; echo $?; bg %nope; echo $?",
        "1\n1\n1\n",
        "sh: fg: no job control\nsh: fg: no job control\nsh: bg: no job control\n",
      ],
    ];
    for (const [line, out, err] of lines) {
      const r = await sh(line);
      expect({ line, out: r.out, err: r.err }).toEqual({ line, out, err });
    }
  });

  it("leave a disowned job's pid to `wait`, which answers 0 at once, as bash does", async () => {
    const started = Date.now();
    const r = await sh(
      "sleep 2 & p=$!; disown; wait $p; echo w=$?; (sleep 2; exit 3) & q=$!; disown %1; wait $q; echo w=$?; wait %1; echo w2=$?; kill $p $q",
    );
    expect(r.out).toBe("w=0\nw=0\nw2=127\n");
    expect(r.err).toBe("sh: wait: %1: no such job\n");
    // Neither `wait` waited for its job.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("the options of `jobs`", () => {
  it("print what bash 3.2's print", async () => {
    const lines: [string, string, string][] = [
      [
        'sleep 1 & a=$!; sleep 2 & b=$!; [ "$(jobs -p)" = "$a\n$b" ] && echo pids; [ "$(jobs -l %1)" = "$(printf "[1]- %5d Running                 sleep 1 &" $a)" ] && echo long; [ "$(jobs -rp %2)" = "$b" ] && echo last; [ "$(jobs -pl)" = "$(jobs -l)" ] && echo l-wins; kill %1 %2',
        "pids\nlong\nlast\nl-wins\n",
        "",
      ],
      [
        "sleep 1 & (exit 3) & sleep 0.1; jobs -s; echo s=$?; jobs -r; echo r=$?; jobs -s %1; jobs -p %2 >/dev/null; jobs; kill %1",
        "s=0\n[1]-  Running                 sleep 1 &\nr=0\n[1]-  Running                 sleep 1 &\n[1]-  Running                 sleep 1 &\n[2]+  Exit 3                  (exit 3)\n",
        "",
      ],
      [
        "sleep 1 & jobs -n; echo a; jobs -n; echo b; jobs; kill %1; sleep 0.05; jobs -n; echo c; jobs -n; echo d",
        "[1]+  Running                 sleep 1 &\na\nb\n[1]+  Running                 sleep 1 &\n[1]+  Terminated              sleep 1\nc\nd\n",
        "",
      ],
      [
        "jobs -z; echo $?; jobs -- %1; echo $?",
        "2\n1\n",
        "sh: jobs: -z: invalid option\njobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]\nsh: jobs: %1: no such job\n",
      ],
      [
        'sleep 1 & a=$!; jobs -p %2 %1 2>&1 | { read e; read p; [ "$e/$p" = "sh: jobs: %2: no such job/$a" ] && echo in-turn; }; kill %1',
        "in-turn\n",
        "",
      ],
    ];
    for (const [line, out, err] of lines) {
      const r = await sh(line);
      expect({ line, out: r.out, err: r.err }).toEqual({ line, out, err });
    }
  });

  it("give `jobs -p | xargs kill` the pids, which ends the jobs at once", async () => {
    const started = Date.now();
    const r = await sh("sleep 2 & sleep 2 & jobs -p | xargs kill; wait; echo st=$?; jobs");
    expect({ out: r.out, err: r.err }).toEqual({ out: "st=0\n", err: "" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("the jobs a subshell knows", () => {
  it("are only those it starts itself, as in bash's forked subshell", async () => {
    // Each line's standard output under /bin/bash 3.2.
    const lines: [string, string][] = [
      // `wait` returns at once: the subshell has no job of its own.
      ['(sleep 0.2; echo late) & (wait; echo "w=$?"); echo after', "w=0\nafter\nlate\n"],
      ['(sleep 0.2; echo late) & { wait; echo "w=$?"; } & echo after', "after\nw=0\nlate\n"],
      [
        '(sleep 0.2; echo late) & echo x | { wait; echo "p=$?"; }; echo after',
        "p=0\nafter\nlate\n",
      ],
      ['sleep 0.2 & (jobs; echo "j=$?")', "j=0\n"],
      ['sleep 0.2 & (wait %1; echo "w=$?")', "w=127\n"],
      ['sleep 0.2 & echo x | { wait %1; echo "w=$?"; }', "w=127\n"],
      ['sleep 0.2 & (kill %1; echo "k=$?"); wait $!; echo "st=$?"', "k=1\nst=0\n"],
      ['sleep 0.2 & (sleep 0.05 & wait %1; echo "own=$?"; jobs)', "own=0\n"],
      // A pid names a process, whichever shell started it.
      ['(sleep 0.2) & (kill $!; echo "k=$?"); wait $!; echo "st=$?"', "k=0\nst=143\n"],
      // The one stage that lists the shell's jobs is a lone `jobs`.
      ["sleep 0.2 & { jobs; } | cat; jobs | cat", "[1]+  Running                 sleep 0.2 &\n"],
    ];
    for (const [line, out] of lines) {
      const result = await sh(line);
      expect(`${line} => ${result.out}`).toBe(`${line} => ${out}`);
    }
    const pid = await sh('sleep 0.2 & (wait $!; echo "w=$?")');
    expect(pid.err).toMatch(/^sh: wait: pid \d+ is not a child of this shell\n$/);
    expect(pid.out).toBe("w=127\n");
  });

  it("in a command substitution are its shell's, which it lists and cannot wait for", async () => {
    // bash 3.2 lists them in `$(…)`, and `kill %N` there reaches them.
    const lines: [string, string][] = [
      ['sleep 0.2 & x=$(jobs); echo "[$x]"', "[[1]+  Running                 sleep 0.2 &]\n"],
      [
        'sleep 5 & x=$(kill %1; echo "k=$?"); echo "[$x]"; wait $!; echo "st=$?"',
        "[k=0]\nst=143\n",
      ],
      ['(sleep 0.2; echo late) & x=$(wait; echo w); echo "[$x]"', "[w]\nlate\n"],
      ['(exit 3) & sleep 0.05; x=$(wait $!; echo "w=$?"); echo "[$x]"', "[w=3]\n"],
    ];
    for (const [line, out] of lines) {
      const result = await sh(line);
      expect(`${line} => ${result.out}`).toBe(`${line} => ${out}`);
    }
  });
});

describe("a background command that cannot start", () => {
  it("is a job with a pid of its own, whose `wait` says why it failed", async () => {
    // bash forks first: `$!` is set, and `wait $!` is 127.
    const missing = await sh('nosuch & wait $!; echo "st=$? pid=${!:+set}"');
    expect(missing.out).toBe("st=127 pid=set\n");
    expect(missing.err).toBe("sh: command not found: nosuch\n");
    const byJob = await sh('nosuch 2>/dev/null & wait %1; echo "st=$?"');
    expect(byJob.out).toBe("st=127\n");
  });

  it("is announced by a jsh with that pid, as every job is", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await pause(5);
    rt.feedStdin("nosuch &\r");
    await pause(20);
    rt.feedStdin("exit 0\r");
    expect(await done).toBe(0);
    expect(rt.stderr()).toMatch(/^\[1\] \d+$/m);
    expect(rt.stderr()).toContain("sh: command not found: nosuch\n");
    expect(rt.stdout()).toContain("[1]+  Exit 127                nosuch\n");
  });
});

describe("a jsh job the prompt has reported", () => {
  it("is still known to `wait pid`", async () => {
    const { rt } = setupRuntime({ tty: true });
    const done = runShell(["jsh"]);
    await pause(5);
    rt.feedStdin("fail 3 &\r");
    await pause(20);
    // Any command line: the prompt after it says `[1]+  Exit 3`.
    rt.feedStdin("true\r");
    await pause(20);
    rt.feedStdin("wait $!; echo W=$?\r");
    await pause(20);
    rt.feedStdin("exit 0\r");
    expect(await done).toBe(0);
    const output = rt.stdout().replace(ANSI, "").replace(/\r/g, "");
    expect(output).toContain("[1]+  Exit 3                  fail 3\n");
    expect(output).toContain("\nW=3\n");
    expect(rt.stderr()).not.toContain("not a child");
  });
});

describe("the notice of a jsh job that has ended", () => {
  /** A jsh on the real kernel, at its first prompt. */
  async function jsh() {
    const shell = kernelShell(["jsh"]);
    expect(await shell.waitFor("❯")).toBe(true);
    return shell;
  }

  /** Types `line` and waits for a line of output that `text` matches; the output from the line on. */
  async function typed(shell: ReturnType<typeof kernelShell>, line: string, text: string) {
    const from = shell.output().length;
    shell.type(`${line}\r`);
    // The line's output, not its echo: `text` on a line of its own, then a prompt.
    const shows = new RegExp(`\\n${text}\\n[\\s\\S]*❯`);
    expect(await until(() => shows.test(shell.output().slice(from)))).toBe(true);
    return shell.output().slice(from).replace(ANSI, "");
  }

  /** How many times `part` is in `text`. */
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("is given by `wait` as it collects the job, once, before what follows", async () => {
    // bash 3.2, interactive: `sleep 30 &`, `kill %1; wait %1; echo job $?`:
    // the notice, then `job 143`, and none at the next prompt.
    const shell = await jsh();
    await typed(shell, "sleep 30 &", "\\[1\\] \\d+");
    const shown = await typed(shell, "kill %1; wait %1; echo job $?", "job 143");
    const notice = "[1]+  Terminated              sleep 30\n";
    expect(shown.indexOf(notice)).toBeGreaterThan(-1);
    expect(shown.indexOf(notice)).toBeLessThan(shown.indexOf("job 143"));
    expect(count(await typed(shell, "echo next", "next"), "Terminated")).toBe(0);
    // `wait` with no operand: each job, `-` for the one before the newest.
    await typed(shell, "sleep 30 &", "\\[1\\] \\d+");
    await typed(shell, "sleep 31 &", "\\[2\\] \\d+");
    const both = await typed(shell, "kill %1 %2; wait; echo st $?", "st 0");
    expect(both).toContain(
      "[1]-  Terminated              sleep 30\n[2]+  Terminated              sleep 31\nst 0",
    );
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("is given at the next prompt after an empty line too", async () => {
    // bash -i: `sleep 0.2 &`, then Enter on an empty line once it has ended:
    // `[1]+  Done                    sleep 0.2` before that prompt, once.
    const shell = await jsh();
    await typed(shell, "sleep 0.2 &", "\\[1\\] \\d+");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const from = shell.output().length;
    shell.type("\r");
    const notice = "[1]+  Done                    sleep 0.2\n";
    expect(await until(() => shell.output().slice(from).includes(notice))).toBe(true);
    // Reported, it has left the list.
    shell.type("\r");
    expect(count(await typed(shell, "jobs; echo J", "J"), "Done")).toBe(0);
    expect(count(shell.output().slice(from), "Done")).toBe(1);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("and the `[N] pid` line come from the shell itself, not from a subshell or a stage", async () => {
    // bash -i prints nothing for a job a subshell or a pipeline stage starts.
    const shell = await jsh();
    const sub = await typed(shell, "(sleep 0.05 & wait; echo sub)", "sub");
    expect(sub).not.toMatch(/\[\d+\] \d+/);
    const stage = await typed(shell, "echo hi | { cat <&0 & wait; echo E1; }", "E1");
    expect(stage).not.toMatch(/\[\d+\] \d+/);
    const background = await typed(shell, "(sleep 0.05 & wait; echo in) & wait; echo W", "W");
    expect(count(background, "[1] ")).toBe(1);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("says how a signal ended the job, as Linux's strsignal words it", async () => {
    // bash: `kill -INT %1; wait %1`: `Interrupt`; KILL `Killed`; HUP `Hangup`; PIPE `Broken pipe`.
    const shell = await jsh();
    for (const [signal, words] of [
      ["INT", "Interrupt"],
      ["KILL", "Killed"],
      ["HUP", "Hangup"],
      ["USR1", "User defined signal 1"],
      ["PIPE", "Broken pipe"],
    ]) {
      await typed(shell, "sleep 30 &", "\\[1\\] \\d+");
      const shown = await typed(shell, `kill -${signal} %1; wait %1; echo st $?`, "st \\d+");
      expect(shown).toContain(`[1]+  ${words}${" ".repeat(24 - words.length)}sleep 30\nst `);
    }
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("goes to `wait`'s standard error", async () => {
    // bash: `kill %1; wait %1 2>/dev/null; echo st $?`: st 143 alone; `>/dev/null` keeps it.
    const shell = await jsh();
    await typed(shell, "sleep 30 &", "\\[1\\] \\d+");
    const hidden = await typed(shell, "kill %1; wait %1 2>/dev/null; echo st $?", "st 143");
    expect(hidden).not.toContain("Terminated");
    await typed(shell, "sleep 30 &", "\\[1\\] \\d+");
    const kept = await typed(shell, "kill %1; wait %1 >/dev/null; echo st $?", "st 143");
    expect(kept).toContain("[1]+  Terminated              sleep 30\nst 143");
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("is given once a foreground program has ended, before the next command", async () => {
    // bash: `(sleep 0.1; exit 3) &`, `sleep 0.3; echo after`: the notice, then after.
    const shell = await jsh();
    await typed(shell, "(sleep 0.05; exit 3) &", "\\[1\\] \\d+");
    const shown = await typed(shell, "sleep 0.3; echo after", "after");
    expect(shown).toContain("[1]+  Exit 3                  (sleep 0.05; exit 3)\nafter\n");
    expect(count(shown, "Exit 3")).toBe(1);
    // Not after a bash builtin: the prompt after it gives it (bash: `next`, the notice).
    await typed(shell, "(sleep 0.05; exit 4) &", "\\[1\\] \\d+");
    await pause(200);
    const builtin = await typed(shell, "echo after", "after");
    expect(builtin).toMatch(/after\n\[1\]\+ {2}Exit 4/);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });
});

describe("the statuses a shell keeps of jobs that left its list", () => {
  function ended(pid: number, status: number): Job {
    return {
      id: 1,
      pid,
      command: "job",
      done: Promise.resolve(status),
      status,
      signal: null,
      ownGroup: false,
    };
  }

  it("are those of ended jobs only, by pid", () => {
    const table = newJobList();
    const running: Job = { ...ended(7, 0), status: null };
    const done = ended(8, 3);
    addJob(table, running);
    addJob(table, done);
    forgetEndedJobs(table);
    expect(table.jobs).toEqual([running]);
    expect([...table.endedJobs]).toEqual([[8, 3]]);
  });

  it("forget a pid that a new job has", () => {
    const table = newJobList();
    const first = ended(8, 3);
    addJob(table, first);
    forgetJob(table, first);
    addJob(table, { ...ended(8, 0), status: null });
    expect(table.endedJobs.has(8)).toBe(false);
  });

  it("are the newest ones, up to a limit", () => {
    const table = newJobList();
    for (let pid = 1; pid <= REMEMBERED_JOBS + 2; pid++) {
      const job = ended(pid, pid % 256);
      addJob(table, job);
      forgetJob(table, job);
    }
    expect(table.endedJobs.size).toBe(REMEMBERED_JOBS);
    expect(table.endedJobs.has(2)).toBe(false);
    expect(table.endedJobs.get(REMEMBERED_JOBS + 2)).toBe((REMEMBERED_JOBS + 2) % 256);
  });
});

describe("a background job of several commands", () => {
  it("goes on through a SIGINT that waits for the foreground's program to end", async () => {
    // The signal stays pending while the program runs; the job's commands
    // end meanwhile, and none of them may take it for the job's own.
    let finish = (_code: number): void => {};
    const { rt } = setupRuntime({
      externals: ["prog"],
      spawn: () => new Promise<number>((resolve) => (finish = resolve)),
    });
    rt.feedStdin(null);
    const done = runShell([
      "sh",
      "-c",
      "trap 'echo trapped' INT; { sleep 0.03; echo one; sleep 0.03; echo two; } & prog; wait; echo end",
    ]);
    await pause(10);
    deliverSignal(rt, "SIGINT", true);
    await pause(150);
    expect(rt.stdout()).toBe("one\ntwo\n");
    finish(0);
    expect(await done).toBe(0);
    expect(rt.stdout()).toBe("one\ntwo\ntrapped\nend\n");
  });
});

describe("the options of `kill`", () => {
  it("end at `--`, after a signal too, so a pid or a negative process group follows", async () => {
    for (const option of ["-9", "-s KILL", "-n 9", "-KILL", "-s 9"]) {
      const r = await sh(`hang & kill ${option} -- $!; echo rc=$?; wait $!; echo st=$?`);
      expect(r.err).toBe("");
      expect(r.out).toBe("rc=0\nst=137\n");
    }
    const plain = await sh("sleep 30 & kill -- $!; echo rc=$?; wait $!; echo st=$?");
    expect(plain.err).toBe("");
    expect(plain.out).toBe("rc=0\nst=143\n");
  });

  it("take a second `-word` for a process group, not for another signal", async () => {
    // No such group: the word was read as one.
    const r = await sh("kill -TERM -99999; echo rc=$?");
    expect(r.err).toBe("sh: kill: (-99999) - No such process\n");
    expect(r.out).toBe("rc=1\n");
  });

  it("say what is wrong with them", async () => {
    const missing = await sh("kill -s; echo rc=$?");
    expect(missing.err).toBe("sh: kill: -s: option requires an argument\n");
    expect(missing.out).toBe("rc=1\n");
    const unknown = await sh("kill -NOPE 1; echo rc=$?");
    expect(unknown.err).toBe("sh: kill: NOPE: invalid signal specification\n");
    expect(unknown.out).toBe("rc=1\n");
    // A number that is no signal's is refused, not sent as another signal.
    const number = await sh(
      "sleep 30 & kill -99 $!; echo rc=$?; kill -s 99 $!; echo rc=$?; kill $!",
    );
    expect(number.err).toBe(
      "sh: kill: 99: invalid signal specification\nsh: kill: 99: invalid signal specification\n",
    );
    expect(number.out).toBe("rc=1\nrc=1\n");
    const word = await sh("kill -TERM -- -- 1; echo rc=$?");
    expect(word.err).toContain("sh: kill: --: arguments must be process or job IDs\n");
  });
});

describe("`kill -0`", () => {
  it("asks the kernel whether the process is there, and sends nothing", async () => {
    expect((await sh("kill -0 $$; echo self=$?; kill -s 0 $$; echo again=$?")).out).toBe(
      "self=0\nagain=0\n",
    );
    const child = await sh(
      "hang & kill -0 $!; echo alive=$?; kill $!; wait $!; kill -0 $!; echo dead=$?",
    );
    expect(child.out).toBe("alive=0\ndead=1\n");
    expect(child.err).toMatch(/^sh: kill: \(\d+\) - No such process\n$/);
    const none = await sh("kill -0 99999; echo none=$?");
    expect(none.err).toBe("sh: kill: (99999) - No such process\n");
    expect(none.out).toBe("none=1\n");
  });

  it("knows a job that runs in the shell's own process, by job and by pid", async () => {
    const r = await sh(
      "sleep 30 & kill -0 %1; echo job=$?; kill -0 $!; echo pid=$?; kill %1; wait %1; echo st=$?; kill -0 $!; echo gone=$?",
    );
    expect(r.out).toBe("job=0\npid=0\nst=143\ngone=1\n");
    // Ended, and still listed: it is not there to be signalled any more.
    const ended = await sh(
      "sleep 30 & kill %1; sleep 0.05; kill -0 %1; echo probe=$?; kill %1; echo again=$?",
    );
    expect(ended.out).toBe("probe=1\nagain=1\n");
    expect(ended.err).toMatch(/^(sh: kill: \(\d+\) - No such process\n){2}$/);
  });
});

describe("`kill %N`", () => {
  /** The signals each program got, by the name it was started with. */
  type Received = Record<string, string[]>;

  /** Notes its signals and stays. With `child`, starts `node <child>` first, in its own process group. */
  function notes(received: Received, child?: string): ChildProgram {
    return (self, runtime) => {
      const got = (received[self.argv[1]] = [] as string[]);
      runtime.processes.onSignal((signal) => {
        got.push(signal);
        return true;
      });
      if (child !== undefined) {
        runtime.processes.spawn({
          command: "node",
          args: [child],
          cwd: runtime.cwd,
          env: runtime.env,
          stdio: ["inherit", "inherit", "inherit"],
        });
      }
    };
  }

  /** A jsh with `node parent.js &` running, and its child `server.js` with it. */
  async function jobWithChild() {
    const received: Received = {};
    const shell = kernelShell(
      ["jsh"],
      {},
      { "parent.js": notes(received, "server.js"), "server.js": notes(received) },
    );
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("node parent.js &\r");
    expect(await until(() => received["server.js"] !== undefined)).toBe(true);
    await pause(20);
    return { shell, received };
  }

  it("signals the job's process group under job control: what the program started too", async () => {
    // bash: `node par.js 3985 &`, `kill %1`: the server par.js started closes.
    const { shell, received } = await jobWithChild();
    shell.type("kill %1\r");
    expect(await until(() => received["server.js"].length > 0)).toBe(true);
    expect(received).toEqual({ "parent.js": ["SIGTERM"], "server.js": ["SIGTERM"] });
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("leaves the group alone when the job is named by its pid", async () => {
    const { shell, received } = await jobWithChild();
    shell.type("kill $!\r");
    expect(await until(() => received["parent.js"].length > 0)).toBe(true);
    await pause(30);
    expect(received).toEqual({ "parent.js": ["SIGTERM"], "server.js": [] });
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("signals the group of each program of a job the shell runs itself", async () => {
    const received: Received = {};
    const shell = kernelShell(
      ["jsh"],
      {},
      { "parent.js": notes(received, "server.js"), "server.js": notes(received) },
    );
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("{ node parent.js; echo after; } &\r");
    expect(await until(() => received["server.js"] !== undefined)).toBe(true);
    await pause(20);
    shell.type("kill %1\r");
    expect(await until(() => received["server.js"].length > 0)).toBe(true);
    expect(received).toEqual({ "parent.js": ["SIGTERM"], "server.js": ["SIGTERM"] });
    // The job still waits for parent.js, which caught the signal, and would
    // outlive the shell as a forked subshell does: it ends first.
    shell.type("kill -KILL %1; wait; echo ended $((6 * 7))\r");
    expect(await shell.waitFor("ended 42")).toBe(true);
    shell.type("exit 0\r");
    expect(await shell.done).toBe(0);
  });

  it("signals the program alone in a shell without job control, whose jobs share its group", async () => {
    const { rt } = setupRuntime();
    rt.feedStdin(null);
    const sent: [number, string][] = [];
    const kill = rt.processes.kill;
    rt.processes.kill = (pid, signal) => {
      sent.push([pid, signal]);
      kill(pid, signal);
    };
    await runShell(["sh", "-c", "hang & kill %1; wait %1; echo st=$?; echo pid=$!"]);
    const pid = Number(/pid=(\d+)/.exec(rt.stdout())?.[1]);
    expect(rt.stdout()).toContain("st=143\n");
    expect(sent).toEqual([[pid, "SIGTERM"]]);
  });
});

describe("the signal listings", () => {
  /** `N) NAME` entries of a listing, in order. */
  function entries(listing: string): [number, string][] {
    return [...listing.matchAll(/(\d+)\) (\S+)/g)].map((match) => [Number(match[1]), match[2]]);
  }

  it("of `kill -l` and `trap -l` are the signal table, numbered, in order", async () => {
    const table = Object.entries(SIGNAL_NUMBERS)
      .map(([name, number]): [number, string] => [number, name])
      .sort((a, b) => a[0] - b[0]);
    const kill = await sh("kill -l");
    expect(entries(kill.out)).toEqual(table);
    const trap = await sh("trap -l");
    expect(trap.out).toBe(kill.out);
  });

  it("are laid out as bash's: five to a line, tabs between", async () => {
    const lines = (await sh("kill -l")).out.split("\n");
    expect(lines[0]).toBe(" 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP");
    expect(lines[1]).toBe(" 6) SIGABRT\t 7) SIGBUS\t 8) SIGFPE\t 9) SIGKILL\t10) SIGUSR1");
    expect(lines.at(-2)).toBe("31) SIGSYS\t");
    expect(lines.at(-1)).toBe("");
  });

  it("answer for one signal: a number's name, an exit status's signal, a name's number", async () => {
    const r = await sh("kill -l 15; kill -l 143; kill -l TERM; kill -l SIGINT; kill -l 1 2 31");
    expect(r.err).toBe("");
    expect(r.out).toBe("TERM\nTERM\n15\n2\nHUP\nINT\nSYS\n");
    const bad = await sh("kill -l 99; echo rc=$?; kill -l NOPE; echo rc=$?");
    expect(bad.err).toBe(
      "sh: kill: 99: invalid signal specification\nsh: kill: NOPE: invalid signal specification\n",
    );
    expect(bad.out).toBe("rc=1\nrc=1\n");
  });
});

describe("a job the shell runs in its own process, when the shell ends", () => {
  /** Starts `sh -c line` on the fake runtime; `done` is what runShell resolves to. */
  function start(line: string) {
    const { rt } = setupRuntime();
    rt.feedStdin(null);
    return { rt, done: runShell(["sh", "-c", line]) };
  }

  it("goes on in a new process once the shell has ended for its parent, as a forked subshell", async () => {
    // bash: `sh -c "(sleep 1; echo late) & echo early"; sleep 2` prints early, then late.
    for (const line of [
      "(sleep 0.05; echo late) & echo early",
      "sleep 0.05 && echo late & echo early",
      "{ sleep 0.05; echo late; } & echo early",
      "f() { sleep 0.05; echo late; }; f & echo early",
    ]) {
      const { rt, done } = start(line);
      expect(await until(() => rt.forkedExit !== null)).toBe(true);
      expect(rt.forkedExit).toEqual({ code: 0, signal: null });
      expect(rt.stdout()).toBe("early\n");
      expect(rt.pid).not.toBe(1);
      expect(await within(done)).toBe(0);
      expect(rt.stdout()).toBe("early\nlate\n");
    }
  });

  it("reports the status the shell ended with: an exit's, or the signal it died of", async () => {
    // bash: `sh -c '(sleep 1; echo late) & exit 3'` is status 3, and late follows.
    const exited = start("(sleep 0.05; echo late) & exit 3");
    expect(await within(exited.done)).toBe(0);
    expect(exited.rt.forkedExit).toEqual({ code: 3, signal: null });
    expect(exited.rt.stdout()).toBe("late\n");
    // bash: `sh -c '(sleep 1; echo late) & kill -TERM $$'` dies of SIGTERM, and late follows.
    const killed = start("(sleep 0.05; echo late) & kill -TERM $$");
    expect(await within(killed.done)).toBe(0);
    expect(killed.rt.forkedExit).toEqual({ code: null, signal: "SIGTERM" });
    expect(killed.rt.stdout()).toBe("late\n");
    expect(killed.rt.exitCode).toBeNull();
  });

  it("keeps the variables and functions the shell set, and `$$` names the shell", async () => {
    const { rt, done } = start(
      'v=val; f() { echo "f $v"; }; (sleep 0.05; f; echo "pid $$ ppid $PPID") & echo "pid $$ ppid $PPID"',
    );
    expect(await within(done)).toBe(0);
    expect(rt.stdout()).toBe("pid 1 ppid 0\nf val\npid 1 ppid 0\n");
  });

  it("is not needed when no such job runs: a program's job, or after `wait`", async () => {
    const program = await sh("node x & echo early");
    expect(program.rt.forkedExit).toBeNull();
    const waited = await sh("(sleep 0.02; echo late) & echo early; wait; echo after");
    expect(waited.out).toBe("early\nlate\nafter\n");
    expect(waited.rt.forkedExit).toBeNull();
    expect(waited.status).toBe(0);
  });

  it("goes on after `disown`, which only takes it off the list", async () => {
    const { rt, done } = start("(sleep 0.05; echo late) & disown; echo early");
    expect(await within(done)).toBe(0);
    expect(rt.forkedExit).toEqual({ code: 0, signal: null });
    expect(rt.stdout()).toBe("early\nlate\n");
  });

  it("also waits for the jobs such a job starts, once the shell has ended too", async () => {
    const { rt, done } = start("(sleep 0.03; (sleep 0.05; echo inner) & echo outer) & echo early");
    expect(await within(done)).toBe(0);
    expect(rt.stdout()).toBe("early\nouter\ninner\n");
  });

  it("ends once a job whose `wait` waits for its own jobs has", async () => {
    // bash: `sh -c '((sleep 1; echo in) & wait; echo waited) & echo e' | cat` prints e, in, waited, and ends.
    const { rt, done } = start("((sleep 0.05; echo in) & wait; echo waited) & echo e");
    expect(await until(() => rt.forkedExit !== null)).toBe(true);
    expect(await within(done)).toBe(0);
    expect(rt.stdout()).toBe("e\nin\nwaited\n");
  });

  it("ends of a signal sent to the new process, and ignores SIGINT and what the shell ignored", async () => {
    const ended = start("(sleep 5; echo late) & echo early");
    expect(await until(() => ended.rt.forkedExit !== null)).toBe(true);
    deliverSignal(ended.rt, "SIGINT", true);
    deliverSignal(ended.rt, "SIGINT", false);
    deliverSignal(ended.rt, "SIGPIPE", false);
    await pause(20);
    expect(await within(ended.done, 50)).toBe("still running");
    deliverSignal(ended.rt, "SIGTERM", false);
    expect(await within(ended.done)).toBe(0);
    expect(ended.rt.stdout()).toBe("early\n");

    const ignoring = start("trap '' TERM; (sleep 0.05; echo late) & echo early");
    expect(await until(() => ignoring.rt.forkedExit !== null)).toBe(true);
    deliverSignal(ignoring.rt, "SIGTERM", false);
    expect(await within(ignoring.done)).toBe(0);
    expect(ignoring.rt.stdout()).toBe("early\nlate\n");
  });

  it("holds the pipe it writes to, so that its reader sees the end only when the job has ended", async () => {
    // Node: spawn("sh", ["-c", "(sleep 1; echo late) & echo early"]) emits "exit"
    // at once and the end of stdout a second later, with both lines.
    const shell = spawnedShell(["sh", "-c", "(sleep 0.4; echo late) & echo early"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const fd = shell.stdio[1]!;
    const first = new TextDecoder().decode(await shell.parent.fs.readAsync(fd, 65536, null));
    expect(first).toBe("early\n");
    // The shell has ended for its parent while the pipe is still open.
    expect(await within(shell.exit, 200)).toEqual({ code: 0, signal: null });
    let rest = "";
    for (;;) {
      const chunk = await shell.parent.fs.readAsync(fd, 65536, null);
      if (chunk.length === 0) {
        break;
      }
      rest += new TextDecoder().decode(chunk);
    }
    expect(rest).toBe("late\n");
    // The shell's pid names no process.
    expect(() => shell.parent.processes.kill(shell.pid, "0")).toThrow(/ESRCH/);
  });
});
