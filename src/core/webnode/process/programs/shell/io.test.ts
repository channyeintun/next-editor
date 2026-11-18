// @vitest-environment node
// The shell's writes over the real kernel's pipes, which hold 64 KiB: the
// stages of a pipeline run in one process, so a write that does not fit is
// queued and the command waits for it asynchronously. Pipelines whose output
// is far larger than a pipe, early readers, command substitution and here
// documents all still finish, and output nobody reads stays bounded.
import { afterEach, describe, expect, it } from "vitest";
import type { Kernel } from "../../../kernel/kernel";
import { PIPE_CAPACITY } from "../../../kernel/streams";
import type { Pipe } from "../../../kernel/streams";
import { setRuntime } from "../../runtime";
import { kernelShell } from "./testHelpers";
import type { ChildProgram, KernelShell } from "./testHelpers";

/** Waits for a shell the page started; its status and what it printed. */
async function outcome(shell: KernelShell): Promise<{ status: number; output: string }> {
  const status = await shell.done;
  return { status, output: shell.output() };
}

/** Runs `sh -c line` on a real kernel. */
function run(line: string): Promise<{ status: number; output: string }> {
  return outcome(kernelShell(["sh", "-c", line]));
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

afterEach(() => {
  setRuntime(null);
});

describe("shell pipelines over pipes that hold 64 KiB", () => {
  it("passes output far larger than a pipe from one builtin to the next", async () => {
    expect(await run("seq 1 200000 | tail -1")).toEqual({ status: 0, output: "200000\n" });
  });

  it("ends a loop writing to a reader that stops early", async () => {
    expect(await run("while :; do echo y; done | head -2; echo after $?")).toEqual({
      status: 0,
      output: "y\ny\nafter 0\n",
    });
  });

  it("runs a pipeline of five builtins", async () => {
    // Of 1…100000, all but the 9^5 numbers with no digit 9.
    expect(await run("seq 1 100000 | cat | grep 9 | tr 9 x | wc -l")).toEqual({
      status: 0,
      output: "40951\n",
    });
  });

  it("substitutes a command's output larger than a pipe", async () => {
    // "1\n" … "100000\n" is 588895 bytes; the last newline is dropped.
    expect(await run('x=$(seq 1 100000); echo "${#x}"')).toEqual({
      status: 0,
      output: "588894\n",
    });
  });

  it("feeds a here document larger than a pipe", async () => {
    const body = `${"z".repeat(99)}\n`.repeat(1500);
    expect(await run(`wc -c <<EOF\n${body}EOF`)).toEqual({
      status: 0,
      output: "150000\n",
    });
  });

  it("keeps a writer whose reader does not read to what a pipe holds", async () => {
    // The reader never reads: the test ends the pipeline once it has seen enough.
    const shell = kernelShell([
      "sh",
      "-c",
      "while :; do echo yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy; done | sleep 60; echo done",
    ]);
    let largest = 0;
    const sample = (): void => {
      for (const pipe of pipesOf(shell.kernel)) {
        largest = Math.max(largest, pipe.size + pipe.waitingBytes);
      }
    };
    // Until the pipe is full, however long the loop takes to fill it, and
    // then for as long again as a writer that did not wait would overrun it in.
    for (let tries = 0; tries < 4000 && largest <= PIPE_CAPACITY - 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sample();
    }
    for (let tries = 0; tries < 30; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sample();
    }
    shell.type("\x03");
    expect(await shell.done).toBe(130);
    expect(largest).toBeGreaterThan(PIPE_CAPACITY - 100);
    // The pipe, and what the loop hands over before it waits for the kernel:
    // at most 256 of its 40-byte writes, and the one it waits on.
    expect(largest).toBeLessThanOrEqual(PIPE_CAPACITY + 257 * 40);
  });
});

describe("a filter whose reader does not read", () => {
  it("takes no more input than its pipe and its last read hold", async () => {
    // `sleep` never reads: cat's output fills its pipe, and cat waits for it
    // before it reads more, so the loop is held to the pipe before cat.
    const shell = kernelShell([
      "sh",
      "-c",
      "while :; do echo yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy; done | cat | sleep 60; echo done",
    ]);
    let largest = 0;
    const sample = (): void => {
      let total = 0;
      for (const pipe of pipesOf(shell.kernel)) {
        total += pipe.size + pipe.waitingBytes;
      }
      largest = Math.max(largest, total);
    };
    // Until both pipes are full, however long the loop takes to fill them,
    // and then for as long again as a cat that read on would overrun them in.
    for (let tries = 0; tries < 4000 && largest < 2 * PIPE_CAPACITY; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sample();
    }
    for (let tries = 0; tries < 40; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sample();
    }
    shell.type("\x03");
    expect(await shell.done).toBe(130);
    expect(largest).toBeGreaterThanOrEqual(2 * PIPE_CAPACITY);
    // Two pipes, the one read of at most 64 KiB that cat had taken, and
    // what the loop hands over before it waits: at most 257 of its writes.
    expect(largest).toBeLessThanOrEqual(3 * PIPE_CAPACITY + 257 * 40);
  });
});

describe("what a built-in read leaves in a pipe", () => {
  /** `node count.js`: reads its stdin to the end and prints how many bytes it got. */
  const programs: Record<string, ChildProgram> = {
    "count.js": async (child, runtime) => {
      let total = 0;
      for (;;) {
        const chunk = await runtime.fs.readAsync(0, 65536, null);
        if (chunk.byteLength === 0) {
          break;
        }
        total += chunk.byteLength;
      }
      runtime.fdStream.write(1, new TextEncoder().encode(`${total}\n`), () => child.exit(0));
    },
  };

  /** Runs `sh -c line`, its `node count.js` played by `programs`. */
  function counted(line: string) {
    return outcome(kernelShell(["sh", "-c", line], {}, programs));
  }

  // seq 1 100000 is 588895 bytes; its first line "1\n" is 2.
  it("gives a program after `read` the rest of the pipe, as bash does", async () => {
    expect(await counted("seq 1 100000 | { read -r x; node count.js; echo x=$x; }")).toEqual({
      status: 0,
      output: "588893\nx=1\n",
    });
    expect(await counted("seq 1 100000 | { read -r a; read -r b; node count.js; }")).toEqual({
      status: 0,
      output: "588891\n",
    });
  });

  it("gives a program after `head` what head did not take, as GNU head", async () => {
    // GNU head -c reads only what it prints, so the program gets the rest.
    expect(await counted("seq 1 100000 | { head -c 10 > /dev/null; node count.js; }")).toEqual({
      status: 0,
      output: "588885\n",
    });
    // head -n reads 8 KiB at a time, and on a pipe the rest of its last read is lost.
    expect(await counted("seq 1 100000 | { head -n 1 > /dev/null; node count.js; }")).toEqual({
      status: 0,
      output: `${588895 - 8192}\n`,
    });
    // On a file it seeks back past the line.
    const lines = Array.from({ length: 3000 }, (_, i) => `${i + 1}\n`).join("");
    expect(
      await outcome(
        kernelShell(["sh", "-c", "{ head -n 2; wc -l; } < /work/f.txt"], { "/work/f.txt": lines }),
      ),
    ).toEqual({ status: 0, output: "1\n2\n2998\n" });
  });

  it("leaves the rest for a built-in that reads next", async () => {
    expect(await run("seq 1 100000 | { read -r x; wc -l; }")).toEqual({
      status: 0,
      output: "99999\n",
    });
  });
});
