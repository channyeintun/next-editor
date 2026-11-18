// @vitest-environment node
// The shell's writes: a write to a file is made before the command goes on,
// so the next command finds it there, and a write that fails for another
// reason than its reader going away is said and fails the command, whether
// the failure is known at once (a file) or only once the kernel reports it
// (the first write to a pipe or a terminal).
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import type { FdKind } from "../../runtime";
import { runShell } from "./index";
import { closeFd, isBrokenPipe, openPipe, writeFd } from "./io";
import { kernelShell, pause, readText, setupRuntime, sh } from "./testHelpers";

afterEach(() => {
  setRuntime(null);
});

describe("a built-in's write to a file", () => {
  /** Runs `script` and returns what kind of fd each write went to, by the call that made it. */
  async function writesOf(script: string, files: Record<string, string> = {}) {
    const { rt, vfs } = setupRuntime({ files });
    rt.feedStdin(null);
    const queued: FdKind[] = [];
    const direct: FdKind[] = [];
    const streamWrite = rt.fdStream.write;
    rt.fdStream.write = (fd, chunk, done) => {
      queued.push(rt.fdStream.kind(fd));
      streamWrite(fd, chunk, done);
    };
    const fileWrite = rt.fs.write;
    rt.fs.write = (fd, data, position) => {
      direct.push(rt.fdStream.kind(fd));
      return fileWrite(fd, data, position);
    };
    const status = await runShell(["sh", "-c", script]);
    return { status, out: rt.stdout(), queued, direct, vfs };
  }

  it("is a write(2), in the file when the command returns, not one the kernel makes later", async () => {
    // Through fds that stay open: `exec`, a redirected group, a redirected loop.
    const result = await writesOf(
      [
        "exec 3>log.txt; echo a >&3; printf 'b\\n' >&3; seq 3 4 >&3",
        "{ echo c; echo d; } > group.txt",
        "for i in 1 2; do echo $i; done > loop.txt",
        "cat log.txt group.txt loop.txt | tr '\\n' ' '",
      ].join("; "),
    );
    expect(result.out).toBe("a b 3 4 c d 1 2 ");
    // Seven writes to files, each made with the blocking call.
    expect(result.direct).toEqual(Array.from({ length: 7 }, () => "file"));
    expect(result.queued).not.toContain("file");
  });

  it("makes no write at all for what goes to /dev/null", async () => {
    const result = await writesOf(
      "{ echo a; echo b; } > /dev/null; echo c > /dev/null 2>&1; seq 1 3 >> /dev/null; echo done",
    );
    expect(result.out).toBe("done\n");
    expect(result.direct).toEqual([]);
    // The one write is `echo done`.
    expect(result.queued).toHaveLength(1);
    // Opened for reading only, it is an fd that cannot be written.
    const refused = await sh('exec 3< /dev/null; echo hi >&3; echo "st=$?"');
    expect(refused.out).toBe("st=1\n");
    expect(refused.err).toBe("echo: write error: Bad file descriptor\n");
  });

  it("still queues what goes to a pipe, which a blocking write would stop on", async () => {
    const result = await writesOf("echo x | cat; echo y");
    expect(result.out).toBe("x\ny\n");
    expect(result.direct).toEqual([]);
    expect(result.queued.length).toBeGreaterThan(0);
  });
});

describe("a write to a pipe whose reader is known to have gone", () => {
  it("fails at once, without asking the kernel again", async () => {
    const { rt } = setupRuntime();
    const pipe = openPipe();
    closeFd(pipe.readFd);
    let calls = 0;
    const streamWrite = rt.fdStream.write;
    rt.fdStream.write = (fd, chunk, done) => {
      calls += 1;
      streamWrite(fd, chunk, done);
    };
    // The kernel refuses the first write only once it has returned.
    expect(writeFd(pipe.writeFd, "first")).toBe(true);
    await pause(5);
    expect(isBrokenPipe(pipe.writeFd)).toBe(true);
    expect(writeFd(pipe.writeFd, "second")).toBe(false);
    expect(writeFd(pipe.writeFd, "third")).toBe(false);
    expect(calls).toBe(1);
    closeFd(pipe.writeFd);
  });
});

describe("a write that fails", () => {
  it("fails the command and says why, on a file opened for reading", async () => {
    const files = { "/work/f.txt": "data\n" };
    const echo = await sh('exec 3< f.txt; echo hi >&3; echo "st=$?"', { files });
    expect(echo.out).toBe("st=1\n");
    expect(echo.err).toBe("echo: write error: Bad file descriptor\n");
    const chained = await sh("exec 3< f.txt; echo hi >&3 || echo failed", { files });
    expect(chained.out).toBe("failed\n");
    const printf = await sh("exec 3< f.txt; printf 'x\\n' >&3 && echo wrote || echo failed", {
      files,
    });
    expect(printf.out).toBe("failed\n");
    expect(printf.err).toBe("printf: write error: Bad file descriptor\n");
    const seq = await sh('exec 3< f.txt; seq 1 3 >&3; echo "st=$?"', { files });
    expect(seq.out).toBe("st=1\n");
    expect(seq.err).toBe("seq: write error: Bad file descriptor\n");
    // A builtin of the shell says it as the shell.
    const pwd = await sh('exec 3< f.txt; pwd >&3; echo "st=$?"', { files });
    expect(pwd.out).toBe("st=1\n");
    expect(pwd.err).toBe("sh: pwd: write error: Bad file descriptor\n");
    expect(readText(echo.vfs, "/work/f.txt")).toBe("data\n");
  });

  it("fails the command on a closed standard output, once", async () => {
    const result = await sh('echo hi >&-; echo "st=$?"; seq 1 2 >&-; echo "st=$?"');
    expect(result.out).toBe("st=1\nst=1\n");
    expect(result.err).toBe(
      "echo: write error: Bad file descriptor\nseq: write error: Bad file descriptor\n",
    );
  });

  it("leaves a status the command failed with for another reason", async () => {
    const result = await sh('exec 3< f.txt; cat missing f.txt >&3; echo "st=$?"', {
      files: { "/work/f.txt": "data\n" },
    });
    expect(result.out).toBe("st=1\n");
    expect(result.err).toContain("cat: missing: No such file or directory\n");
    expect(result.err).toContain("cat: write error: Bad file descriptor\n");
  });

  it("fails the command when the kernel reports it after the write returned", async () => {
    // Standard output is the read end of the pipe: the first write to an fd
    // is answered by the kernel only once the command has gone on.
    const echo = kernelShell(["sh", "-c", 'echo x | { echo hi >&0; echo "st=$?"; }']);
    expect(await echo.done).toBe(0);
    expect(echo.output()).toBe("echo: write error: Bad file descriptor\nst=1\n");
    const printf = kernelShell([
      "sh",
      "-c",
      "echo x | { printf 'y\\n' >&0 && echo wrote || echo failed; }",
    ]);
    expect(await printf.done).toBe(0);
    expect(printf.output()).toBe("printf: write error: Bad file descriptor\nfailed\n");
  });

  it("ends `yes` on an output it cannot write, in its own words", async () => {
    const shell = kernelShell(["sh", "-c", 'echo x | { yes >&0; echo "st=$?"; }']);
    expect(await shell.done).toBe(0);
    expect(shell.output()).toBe("yes: standard output: Bad file descriptor\nst=1\n");
  });

  it("says nothing when the reader has gone: the command ends as of SIGPIPE", async () => {
    const shell = kernelShell([
      "sh",
      "-c",
      "set -o pipefail; seq 1 100000 | head -n 1; echo st=$?",
    ]);
    expect(await shell.done).toBe(0);
    expect(shell.output()).toBe("1\nst=141\n");
  });
});
