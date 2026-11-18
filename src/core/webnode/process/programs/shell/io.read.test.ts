// @vitest-environment node
// The shell's reads of pipes and terminals, over the real kernel: a built-in
// that waits for input ends when Ctrl+C arrives, a read takes from a pipe no
// more than it was asked for and what `read` did not use goes back to it,
// several readers of one pipe all wake, and a line keeps the bytes it had.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kernel } from "../../../kernel/kernel";
import { PIPE_CAPACITY } from "../../../kernel/streams";
import type { Pipe } from "../../../kernel/streams";
import { setRuntime } from "../../runtime";
import { runShell } from "./index";
import { ReadInterrupted, closeFd, openPipe, readAllAsync, readLineAsync, writeFd } from "./io";
import { kernelShell, setupRuntime, sh } from "./testHelpers";
import type { ChildProgram, KernelShell } from "./testHelpers";

const decoder = new TextDecoder();

afterEach(() => {
  setRuntime(null);
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** What the terminal showed, without the line editor's escapes. */
function shown(shell: KernelShell): string {
  return shell.output().replace(ANSI, "");
}

/** The status of `shell`, or "running" when it has not ended within `ms`. */
function ended(shell: KernelShell, ms = 1500): Promise<number | "running"> {
  return Promise.race([shell.done, pause(ms).then(() => "running" as const)]);
}

/** Every pipe the processes of `kernel` hold, by their descriptors. */
function pipesOf(kernel: Kernel): Set<Pipe> {
  const pipes = new Set<Pipe>();
  const procs = (kernel as unknown as { procs: Map<number, { fds: Map<number, unknown> }> }).procs;
  for (const proc of procs.values()) {
    for (const description of proc.fds.values()) {
      const pipe = (description as { pipe?: Pipe }).pipe;
      if (pipe) {
        pipes.add(pipe);
      }
    }
  }
  return pipes;
}

describe("Ctrl+C while a built-in waits for input", () => {
  // Each reads the terminal, alone or first in a pipeline, or a pipe nothing writes yet.
  for (const command of [
    "cat",
    "read x",
    "read -n 1 k",
    "head -n 1",
    "grep x",
    "wc -l",
    "sort",
    "sed s/a/b/",
    "tee /dev/null",
    "x=$(cat)",
    "while read l; do echo $l; done",
    "cat | cat",
    "cat | grep h",
    "read x | cat",
    "cat /dev/tty",
    "sleep 100 | { read x; echo $x; }",
    "sleep 100 | cat",
  ]) {
    it(`ends \`${command}\` in a script, which dies of the signal`, async () => {
      const shell = kernelShell(["sh", "-c", `echo up; ${command}; echo "after $?"`]);
      expect(await shell.waitFor("up\n")).toBe(true);
      // Long enough for the command to be waiting for its input.
      await pause(20);
      shell.type("\x03");
      expect(await ended(shell)).toBe(130);
      expect(shell.output()).not.toContain("after");
    });
  }

  it("leaves what is typed afterwards to the shell that goes on", async () => {
    const shell = kernelShell(["jsh"]);
    expect(await shell.waitFor("❯")).toBe(true);
    for (const command of ["cat", "read x", "cat | cat", "grep foo | cat"]) {
      shell.type(`${command}\r`);
      await pause(30);
      shell.type("\x03");
      await pause(30);
      // Run by the shell, with the status of the interrupted command: not read by it.
      shell.type(`echo "after-$?-${command.length}"\r`);
      expect(await shell.waitFor(`\nafter-130-${command.length}\n`)).toBe(true);
    }
    shell.type('echo "x=[$x]"\r');
    expect(await shell.waitFor("\nx=[]\n")).toBe(true);
    shell.type("exit\r");
    expect(await shell.done).toBe(0);
  });

  it("runs the trap and ends the shell with its status", async () => {
    const shell = kernelShell([
      "sh",
      "-c",
      "trap 'echo trapped; exit 7' INT; echo up; read x; echo after",
    ]);
    expect(await shell.waitFor("up\n")).toBe(true);
    // Long enough for the command to be waiting for its input.
    await pause(20);
    shell.type("\x03");
    expect(await ended(shell)).toBe(7);
    expect(shell.output()).toContain("trapped\n");
    expect(shell.output()).not.toContain("after");
  });

  it("lets `read` wait on after a trap that returns, as bash does", async () => {
    const shell = kernelShell([
      "sh",
      "-c",
      'trap "echo trapped" INT; echo up; read x; echo "after $? x=$x"',
    ]);
    expect(await shell.waitFor("up\n")).toBe(true);
    // Long enough for the command to be waiting for its input.
    await pause(20);
    shell.type("\x03");
    expect(await shell.waitFor("trapped\n")).toBe(true);
    expect(await ended(shell, 100)).toBe("running");
    shell.type("hello\r");
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toContain("after 0 x=hello\n");
  });

  it("ends a built-in program under a trap that returns, and the script goes on", async () => {
    const shell = kernelShell([
      "sh",
      "-c",
      'trap "echo trapped" INT; echo up; cat || echo "cat failed"; echo after',
    ]);
    expect(await shell.waitFor("up\n")).toBe(true);
    // Long enough for the command to be waiting for its input.
    await pause(20);
    shell.type("\x03");
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toContain("trapped\ncat failed\nafter\n");
  });

  it("keeps the start of a line for the read that follows an interrupted one", async () => {
    setupRuntime();
    const pipe = openPipe();
    const stop = new AbortController();
    // The line reaches the pipe in two parts, the signal between them.
    writeFd(pipe.writeFd, "par");
    const interrupted = readLineAsync(pipe.readFd, 10, { signal: stop.signal });
    await pause(10);
    stop.abort();
    await expect(interrupted).rejects.toBeInstanceOf(ReadInterrupted);
    writeFd(pipe.writeFd, "tial\nnext\n");
    const line = await readLineAsync(pipe.readFd);
    expect(line && decoder.decode(line.line)).toBe("partial");
  });

  it("fails a read made after the signal, and takes nothing", async () => {
    setupRuntime();
    const pipe = openPipe();
    const stop = new AbortController();
    stop.abort();
    await expect(readAllAsync(pipe.readFd, { signal: stop.signal })).rejects.toBeInstanceOf(
      ReadInterrupted,
    );
    writeFd(pipe.writeFd, "kept\n");
    closeFd(pipe.writeFd);
    expect(decoder.decode(await readAllAsync(pipe.readFd))).toBe("kept\n");
  });
});

describe("a device named as an operand", () => {
  it("is read as it is typed, by cat and by a filter, while the shell goes on", async () => {
    // The terminal echoes the line, then the command prints it.
    const cat = kernelShell(["sh", "-c", "echo piped | cat /dev/tty | head -n 1"]);
    await pause(20);
    cat.type("hello\r");
    expect(await cat.waitFor("hello\nhello\n")).toBe(true);
    // The Ctrl+C ends cat; the pipeline's status is head's, as in bash.
    cat.type("\x03");
    expect(await ended(cat)).toBe(0);
    const grep = kernelShell(["sh", "-c", "grep -n l /dev/tty | cat"]);
    await pause(20);
    grep.type("one\rtwo\rlast\r");
    expect(await grep.waitFor("\n3:last\n")).toBe(true);
    grep.type("\x04");
    expect(await ended(grep)).toBe(0);
  });

  /** A filesystem with /work, where the copies go. */
  const WORK = { "/work/.keep": "" };

  /** What `/work/out` holds so far, or null while it is not there. */
  function copied(shell: KernelShell): string | null {
    try {
      return decoder.decode(shell.vfs.readFile("/work/out"));
    } catch {
      return null;
    }
  }

  /** Waits (up to 1.5 s) until `/work/out` holds `text`. */
  async function holds(shell: KernelShell, text: string): Promise<boolean> {
    const deadline = Date.now() + 1500;
    while (copied(shell) !== text && Date.now() < deadline) {
      await pause(5);
    }
    return copied(shell) === text;
  }

  it("is one of the command's own fds for cp, read through it, or not there", async () => {
    // GNU cp on Linux: `/dev/fd/N` is the fd itself; one that is not open has no entry.
    const r = await sh("exec 3</work/in; cp /dev/fd/3 /work/out; cat /work/out; cp /dev/fd/7 x", {
      files: { "/work/in": "from fd 3\n" },
    });
    expect(r.out).toBe("from fd 3\n");
    expect(r.err).toBe("cp: cannot stat '/dev/fd/7': No such file or directory\n");
    expect(r.status).toBe(1);
  });

  it("is copied by cp as it is typed, to the end of input", async () => {
    // GNU cp: `cp /dev/tty out`, `hello`: out holds `hello\n` at once; Ctrl+D ends the copy.
    const shell = kernelShell(["sh", "-c", 'cp /dev/tty /work/out; echo "st=$?"'], WORK);
    await pause(20);
    shell.type("hello\r");
    expect(await holds(shell, "hello\n")).toBe(true);
    expect(await ended(shell, 50)).toBe("running");
    shell.type("world\r\x04");
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toContain("st=0\n");
    expect(copied(shell)).toBe("hello\nworld\n");
  });

  it("is copied by cp until Ctrl+C ends it, which keeps what came", async () => {
    const shell = kernelShell(["sh", "-c", "cp /dev/tty /work/out; echo after"], WORK);
    await pause(20);
    shell.type("hello\r");
    expect(await holds(shell, "hello\n")).toBe(true);
    shell.type("\x03");
    expect(await ended(shell)).toBe(130);
    expect(shell.output()).not.toContain("after");
    expect(copied(shell)).toBe("hello\n");
  });

  it("is the command's own standard input for cp, copied as it arrives", async () => {
    // GNU cp on Linux: `(echo a; sleep 1; echo b) | cp /dev/stdin out`: out holds `a` meanwhile.
    for (const source of ["/dev/stdin", "/dev/fd/0"]) {
      const shell = kernelShell(
        ["sh", "-c", `(echo a; sleep 0.3; echo b) | cp ${source} /work/out; cat /work/out`],
        WORK,
      );
      expect(await holds(shell, "a\n")).toBe(true);
      expect(await ended(shell)).toBe(0);
      expect(shell.output()).toBe("a\nb\n");
    }
    // Ended input: the copy ends with it, and makes its file with the mask cutting 0666.
    const ended0 = kernelShell(
      ["sh", "-c", "umask 077; echo hi | cp /dev/stdin /work/out; echo st=$?"],
      WORK,
    );
    expect(await ended(ended0)).toBe(0);
    expect(ended0.output()).toBe("st=0\n");
    expect(copied(ended0)).toBe("hi\n");
    expect(ended0.vfs.stat("/work/out", true).mode & 0o777).toBe(0o600);
  });
});

describe("a background built-in that reads the terminal of a shell with job control", () => {
  it("waits, and leaves the prompt its keys", async () => {
    const shell = kernelShell(["jsh"], { "/work/other.txt": "" });
    expect(await shell.waitFor("❯")).toBe(true);
    shell.type("cat > /work/got.txt &\r");
    expect(await shell.waitFor("[1] ")).toBe(true);
    shell.type("echo abcdefghijklmnop\r");
    expect(await shell.waitFor("\nabcdefghijklmnop\n")).toBe(true);
    shell.type("read y &\r");
    expect(await shell.waitFor("[2] ")).toBe(true);
    shell.type("echo second-$((40+2))\r");
    expect(await shell.waitFor("\nsecond-42\n")).toBe(true);
    // The jobs got none of it, and `kill` ends their wait as it ends a process.
    shell.type('kill %1 %2; wait %1; echo "cat=$?"; wait %2; echo "read=$?"\r');
    expect(await shell.waitFor("\nread=")).toBe(true);
    // Each with the notice `wait` gives as it collects a job.
    expect(shown(shell)).toContain(
      "\n[1]-  Terminated              cat > /work/got.txt\ncat=143\n[2]+  Terminated              read y\nread=143\n",
    );
    expect(decoder.decode(shell.vfs.readFile("/work/got.txt"))).toBe("");
    shell.type("exit\r");
    expect(await shell.done).toBe(0);
  });
});

describe("what a read takes from a pipe", () => {
  /** `node noop.js` exits at once. */
  const programs: Record<string, ChildProgram> = { "noop.js": (child) => child.exit(0) };

  it("fails a producer that a reader leaves with more than a pipe and its last read hold", async () => {
    // head reads 8 KiB at a time: 15000 lines are 78,894 bytes, more than 64 KiB + 8 KiB.
    const head = kernelShell([
      "sh",
      "-c",
      "set -o pipefail; seq 1 15000 | head -n 1 >/dev/null; echo st=$?",
    ]);
    expect(await ended(head)).toBe(0);
    expect(head.output()).toBe("st=141\n");
    const read = kernelShell([
      "sh",
      "-c",
      "set -o pipefail; seq 1 15000 | { read x; }; echo st=$?",
    ]);
    expect(await ended(read)).toBe(0);
    expect(read.output()).toBe("st=141\n");
    const errexit = kernelShell([
      "sh",
      "-c",
      "set -e; set -o pipefail; seq 1 20000 | head -n 1; echo not-reached",
    ]);
    expect(await ended(errexit)).toBe(141);
    expect(errexit.output()).toBe("1\n");
  });

  it("lets a producer that fits a pipe and the reader's last read end well", async () => {
    // 12000 lines are 60,894 bytes.
    const shell = kernelShell([
      "sh",
      "-c",
      "set -o pipefail; seq 1 12000 | head -n 1 >/dev/null; echo st=$?",
    ]);
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toBe("st=0\n");
  });

  it("keeps a writer within a pipe of a `read` loop, however many lines it takes", async () => {
    const shell = kernelShell(
      [
        "sh",
        "-c",
        "seq 1 200000 | { i=0; while [ $i -lt 12 ]; do read -r l; sleep 0.01; node noop.js; i=$((i+1)); done; echo $l; }",
      ],
      {},
      programs,
    );
    let largest = 0;
    let sampling = true;
    const sample = (async () => {
      while (sampling) {
        for (const pipe of pipesOf(shell.kernel)) {
          largest = Math.max(largest, pipe.size);
        }
        await pause(2);
      }
    })();
    expect(await ended(shell, 4000)).toBe(0);
    sampling = false;
    await sample;
    expect(shell.output()).toBe("12\n");
    expect(largest).toBeGreaterThan(PIPE_CAPACITY - 4096);
    // The pipe, and the one read of 4 KiB that `read` gave back.
    expect(largest).toBeLessThanOrEqual(PIPE_CAPACITY + 4096);
  });

  it("gives what `read` did not use back to the pipe once the shell waits", async () => {
    // "1\n" … "6\n": `read` takes them all in one read and uses the first line.
    const shell = kernelShell(["sh", "-c", "seq 1 6 | { read a; sleep 0.3; echo a=$a; }"]);
    await pause(150);
    // During the sleep the other five lines are in the pipe again: a shell
    // killed now would take nothing with it.
    expect([...pipesOf(shell.kernel)].map((pipe) => pipe.size)).toEqual([10]);
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toBe("a=1\n");
  });

  it("gives it back before `kill` sends a signal, which may end the shell at once", async () => {
    const { rt } = setupRuntime();
    rt.feedStdin(null);
    const order: string[] = [];
    const unread = rt.fdStream.unread;
    rt.fdStream.unread = (fd, bytes) => {
      order.push(`unread ${JSON.stringify(decoder.decode(bytes))}`);
      unread(fd, bytes);
    };
    const kill = rt.processes.kill;
    rt.processes.kill = (pid, signal) => {
      order.push(`kill ${signal}`);
      kill(pid, signal);
    };
    // The pid is nobody's: the signal ends nothing here, and the order shows.
    await runShell(["sh", "-c", "seq 1 3 | { read a; kill -9 99999 2>/dev/null; echo a=$a; }"]);
    expect(rt.stdout()).toBe("a=1\n");
    expect(order.slice(0, 2)).toEqual(['unread "2\\n3\\n"', "kill SIGKILL"]);
  });

  it("gives it back when a signal the shell does not handle ends it there and then", async () => {
    // No timer runs: the shell never reaches the task in which it would
    // have given the bytes back by itself.
    vi.useFakeTimers();
    try {
      const { rt } = setupRuntime();
      rt.feedStdin(null);
      const given: string[] = [];
      const unread = rt.fdStream.unread;
      rt.fdStream.unread = (fd, bytes) => {
        given.push(decoder.decode(bytes));
        unread(fd, bytes);
      };
      void runShell(["sh", "-c", "seq 1 3 | { read a; sleep 5; }"]).catch(() => undefined);
      // Promise jobs only: the pipeline gets as far as its sleep.
      for (let turn = 0; turn < 500; turn++) {
        await Promise.resolve();
      }
      expect(given).toEqual([]);
      try {
        rt.signal("SIGUSR1");
      } catch {
        // The fake's process ends by throwing.
      }
      expect(given).toEqual(["2\n3\n"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what a shell that ends leaves of the input it read", () => {
  it("gives a pipe back what its last `read` did not use, before any task of its own runs", async () => {
    const { rt } = setupRuntime();
    const given: string[] = [];
    const unread = rt.fdStream.unread;
    rt.fdStream.unread = (fd, bytes) => {
      given.push(decoder.decode(bytes));
      unread(fd, bytes);
    };
    rt.feedStdin("1\n2\n3\n");
    rt.feedStdin(null);
    expect(await runShell(["sh", "-c", "read a; echo a=$a"])).toBe(0);
    // Here and now: once it has ended no timer of the shell's runs.
    expect(given).toEqual(["2\n3\n"]);
    expect(rt.stdout()).toBe("a=1\n");
  });

  it("gives a terminal back the keys its last `read` did not use", async () => {
    const { rt } = setupRuntime({ tty: true });
    const given: string[] = [];
    const unread = rt.tty.unread;
    rt.tty.unread = (fd, bytes) => {
      given.push(decoder.decode(bytes));
      unread(fd, bytes);
    };
    rt.feedStdin("one\ntwo\n");
    expect(await runShell(["sh", "-c", "read a; echo a=$a"])).toBe(0);
    await pause(5);
    // Only as the shell ends: keys given back are echoed again.
    expect(given).toEqual(["two\n"]);
    expect(rt.stdout()).toBe("a=one\n");
  });
});

describe("what a `read` took past its line from a terminal", () => {
  it("stays with the shell while it waits, for its next read: given back, keys are echoed again", async () => {
    const { rt } = setupRuntime({ tty: true });
    const given: string[] = [];
    const unread = rt.tty.unread;
    rt.tty.unread = (fd, bytes) => {
      given.push(decoder.decode(bytes));
      unread(fd, bytes);
    };
    rt.feedStdin("one\ntwo\n");
    expect(await runShell(["sh", "-c", "read a; sleep 0.03; read b; echo $a $b"])).toBe(0);
    expect(rt.stdout()).toBe("one two\n");
    expect(given).toEqual([]);
  });
});

describe("what a `read` took past its line from a pipe that has been closed", () => {
  it("is not given to the pipe that gets the same descriptor next", async () => {
    // The second pipeline starts before the shell has waited: its pipe has
    // the descriptors of the first.
    const shell = kernelShell([
      "sh",
      "-c",
      "seq 1 6 | { read a; echo a=$a; }; seq 7 9 | { sleep 0.05; cat; }",
    ]);
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toBe("a=1\n7\n8\n9\n");
  });
});

describe("a filter whose reader has gone", () => {
  it("takes no more input once its queued output was refused", async () => {
    // head leaves after the first line; cat learns of it from its write of the second.
    const shell = kernelShell(["sh", "-c", "cat | head -n 1; echo done"]);
    await pause(20);
    shell.type("first\r");
    expect(await shell.waitFor("first\nfirst\n")).toBe(true);
    shell.type("second\r");
    expect(await ended(shell)).toBe(0);
    expect(shell.output()).toContain("done\n");
  });

  it("takes no more of a device it was named, once its queued output was refused", async () => {
    // As bash: cat reads the second line, its write of it fails, and it ends.
    for (const line of [
      "cat /dev/tty | head -n 1; echo done",
      "grep . /dev/tty | head -n 1; echo done",
    ]) {
      const shell = kernelShell(["sh", "-c", line]);
      await pause(20);
      shell.type("first\r");
      expect(await shell.waitFor("first\nfirst\n")).toBe(true);
      shell.type("second\r");
      expect(await ended(shell)).toBe(0);
      expect(shell.output()).toContain("done\n");
    }
  });
});

describe("several readers of one pipe in the shell", () => {
  it("wakes every reader that waits for the pipe", async () => {
    setupRuntime();
    const pipe = openPipe();
    const first = readLineAsync(pipe.readFd);
    const second = readLineAsync(pipe.readFd);
    const rest = pause(5).then(() => readAllAsync(pipe.readFd));
    writeFd(pipe.writeFd, "1\n2\n3\n");
    closeFd(pipe.writeFd);
    const lines = [await first, await second].map((line) => line && decoder.decode(line.line));
    expect(lines.toSorted()).toEqual(["1", "2"]);
    expect(decoder.decode(await rest)).toBe("3\n");
  });

  it("ends a background reader and a foreground reader of one here-document", async () => {
    const result = await sh('{ read a <&3 & read b <&3; wait; echo "b=$b"; } 3<<EOF\n1\n2\nEOF');
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^b=[12]\n$/);
  });
});

describe("a background command without job control", () => {
  it("reads /dev/null, not the input of the commands after it", async () => {
    expect((await sh("echo data | { cat & wait; echo end; }")).out).toBe("end\n");
    expect((await sh('seq 1 3 | { read a; read b & wait; read c; echo "a=$a c=$c"; }')).out).toBe(
      "a=1 c=2\n",
    );
    expect((await sh("seq 1 3 | { (read a; echo sub=$a) & wait; read c; echo c=$c; }")).out).toBe(
      "sub=\nc=1\n",
    );
    expect((await sh("printf '1\\n2\\n' | { read a & read b; wait; echo \"b=$b\"; }")).out).toBe(
      "b=1\n",
    );
    expect((await sh("printf 'x\\ny\\n' | { cat & cat; wait; echo done; }")).out).toBe(
      "x\ny\ndone\n",
    );
  });

  it("keeps the shell's input when it is a pipeline of several commands, as in bash", async () => {
    // bash gives /dev/null to a background command, group, subshell or
    // and-or list, and not to the first command of a background pipeline.
    expect((await sh("seq 1 3 | { cat | cat & wait; echo end; }")).out).toBe("1\n2\n3\nend\n");
    expect((await sh("seq 1 3 | { ! cat | cat | cat & wait; echo end; }")).out).toBe(
      "1\n2\n3\nend\n",
    );
    expect((await sh("seq 1 3 | { { cat; } & wait; echo end; }")).out).toBe("end\n");
    expect((await sh("seq 1 3 | { cat | cat && true & wait; echo end; }")).out).toBe("end\n");
  });

  it("reads what it is redirected to", async () => {
    const result = await sh("cat < /work/f.txt & wait; echo end", {
      files: { "/work/f.txt": "from the file\n" },
    });
    expect(result.out).toBe("from the file\nend\n");
  });

  it("applies its own input redirection to the shell's input, as bash does", async () => {
    // Each line's output under /bin/bash 3.2, fed `seq 1 3`.
    const lines: [string, string][] = [
      ["cat <&0 & wait; echo end", "1\n2\n3\nend\n"],
      ["cat 0<&0 & wait; echo end", "1\n2\n3\nend\n"],
      ["! cat <&0 & wait; echo end", "1\n2\n3\nend\n"],
      ["{ cat; } <&0 & wait; echo end", "1\n2\n3\nend\n"],
      ["(cat) <&0 & wait; echo end", "1\n2\n3\nend\n"],
      ["while read x; do echo got $x; done <&0 & wait; echo end", "got 1\ngot 2\ngot 3\nend\n"],
      ['read x <&0 & wait; read y; echo "end $y"', "end 2\n"],
      // Any `<` counts, whatever fd it names; a copy of fd 0 to another does not.
      ["cat 3</work/f & wait; echo end", "1\n2\n3\nend\n"],
      ["cat 3<&0 & wait; echo end", "end\n"],
      ["cat >&0 & wait; echo end", "end\n"],
      // Only the lone command's own redirections count, not those inside it.
      ["cat <&0 && true & wait; echo end", "end\n"],
      ["f() { cat; } <&0; f & wait; echo end", "end\n"],
      ["f() { cat; }; f <&0 & wait; echo end", "1\n2\n3\nend\n"],
      ["cat < /work/f & wait; echo end", "file\nend\n"],
      ["cat <<<here & wait; echo end", "here\nend\n"],
    ];
    for (const [line, out] of lines) {
      const result = await sh(`seq 1 3 | { ${line}; }`, { files: { "/work/f": "file\n" } });
      expect(`${line} => ${result.out}`).toBe(`${line} => ${out}`);
    }
  });

  it("gives a background program /dev/null as its standard input", async () => {
    const result = await sh("echo data | { upper & wait; echo end; }");
    expect(result.out).toBe("end\n");
  });
});

describe("bytes that are not UTF-8 in a line `read` takes", () => {
  it("are the same bytes when the variable is printed", async () => {
    const piped = await sh(
      "printf '\\377\\376a\\n' | { read -r a; printf '%s' \"$a\" > a.bin; echo \"${#a}\"; }",
    );
    expect([...piped.vfs.readFile("/work/a.bin")]).toEqual([0xff, 0xfe, 0x61]);
    expect(piped.out).toBe("3\n");
    const file = await sh(
      "printf 'caf\\351\\n' > l1.txt; while read -r line; do printf '%s\\n' \"$line\"; done < l1.txt > l2.txt",
    );
    expect([...file.vfs.readFile("/work/l2.txt")]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const chars = await sh("printf 'a\\351b' | { read -n 2 two; printf '%s' \"$two\" > two.bin; }");
    expect([...chars.vfs.readFile("/work/two.bin")]).toEqual([0x61, 0xe9]);
  });
});
