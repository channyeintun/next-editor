// @vitest-environment node
// The fake process runtime: fd table, captured stdio, stdin, pipes, fake
// children, the loopback network and watch name mapping.
import { describe, expect, it } from "vitest";
import type { SystemError } from "../../errors";
import { O_CREAT, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { Vfs } from "../../kernel/vfs/vfs";
import type { ByteChannel, ExitStatus, SpawnRequest } from "../runtime";
import { createChannelPair, createFakeRuntime, FakeExit } from "./fakeRuntime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function text(data: Uint8Array): string {
  return decoder.decode(data);
}

/** Lets every queued microtask (and the ones they queue) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function failure(action: () => unknown): Partial<SystemError> {
  try {
    action();
  } catch (error) {
    const { code, syscall, path } = error as SystemError;
    return { code, syscall, path };
  }
  throw new Error("expected the call to throw");
}

function request(stdio: SpawnRequest["stdio"], command = "child"): SpawnRequest {
  return { command, args: [], cwd: "/", env: {}, stdio };
}

/** Collects what `readStart` delivers on `fd`, resolving at end of stream. */
function collect(runtime: ReturnType<typeof createFakeRuntime>, fd: number): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    runtime.fdStream.readStart(fd, (chunk) => {
      if (chunk === null) {
        resolve(out);
      } else {
        out += text(chunk);
      }
    });
  });
}

describe("process fields", () => {
  it("takes its identity and environment from the options", () => {
    const vfs = new Vfs();
    const runtime = createFakeRuntime({
      vfs,
      cwd: "/work",
      env: { HOME: "/home" },
      argv: ["node", "/a.js"],
      pid: 7,
    });
    expect(runtime.vfs).toBe(vfs);
    expect(runtime.pid).toBe(7);
    expect(runtime.cwd).toBe("/work");
    expect(runtime.env).toEqual({ HOME: "/home" });
    expect(runtime.argv).toEqual(["node", "/a.js"]);
    expect(runtime.threads.isMainThread).toBe(true);
    expect(runtime.threads.threadId).toBe(0);
    expect(runtime.threads.parentPort).toBeNull();
  });

  it("counts ref and unref", () => {
    const runtime = createFakeRuntime();
    runtime.ref();
    runtime.ref();
    runtime.unref();
    expect(runtime.refCount).toBe(1);
    runtime.unref();
    expect(() => runtime.unref()).toThrow(/without a matching ref/);
  });

  it("throws FakeExit from exit and records the code", () => {
    const runtime = createFakeRuntime();
    expect(runtime.exitCode).toBeNull();
    let caught: unknown;
    try {
      runtime.processes.exit(3);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FakeExit);
    expect((caught as FakeExit).code).toBe(3);
    expect(runtime.exitCode).toBe(3);
  });

  it("refuses to start worker threads", () => {
    const runtime = createFakeRuntime();
    expect(() =>
      runtime.threads.spawn({
        filename: "/w.js",
        eval: false,
        workerData: null,
        transferList: [],
        argv: [],
        execArgv: [],
        env: {},
        cwd: "/",
        name: "w",
      }),
    ).toThrow(/worker threads/);
  });
});

describe("fd table", () => {
  it("opens files from fd 3 and reuses the lowest free fd", () => {
    const runtime = createFakeRuntime();
    const a = runtime.fs.open("/a", O_RDWR | O_CREAT, 0o644);
    const b = runtime.fs.open("/b", O_RDWR | O_CREAT, 0o644);
    expect([a, b]).toEqual([3, 4]);
    runtime.fs.close(a);
    expect(runtime.fs.open("/c", O_RDWR | O_CREAT, 0o644)).toBe(3);
  });

  it("reads and writes files through fds", () => {
    const runtime = createFakeRuntime();
    const fd = runtime.fs.open("/f", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    expect(runtime.fs.write(fd, bytes("hello"), null)).toBe(5);
    runtime.fs.ftruncate(fd, 4);
    runtime.fs.fchmod(fd, 0o600);
    runtime.fs.fsync(fd);
    expect(runtime.fs.fstat(fd).size).toBe(4);
    runtime.fs.close(fd);
    const reader = runtime.fs.open("/f", O_RDONLY, 0);
    expect(text(runtime.fs.read(reader, 10, null))).toBe("hell");
    expect(runtime.fdStream.kind(reader)).toBe("file");
    runtime.fs.close(reader);
    expect(text(runtime.vfs.readFile("/f"))).toBe("hell");
  });

  it("raises EBADF for a closed or unknown fd", () => {
    const runtime = createFakeRuntime();
    const fd = runtime.fs.open("/f", O_RDWR | O_CREAT, 0o644);
    runtime.fs.close(fd);
    expect(failure(() => runtime.fs.read(fd, 1, null))).toMatchObject({ code: "EBADF" });
    expect(failure(() => runtime.fs.close(fd))).toMatchObject({ code: "EBADF" });
    expect(failure(() => runtime.fdStream.kind(99))).toMatchObject({ code: "EBADF" });
  });

  it("maps path calls straight to the Vfs", () => {
    const runtime = createFakeRuntime();
    runtime.fs.mkdir("/a/b", true, 0o777);
    runtime.fs.writeFile("/a/b/f", bytes("x"), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    runtime.fs.symlink("/a/b/f", "/link");
    expect(runtime.fs.realpath("/link")).toBe("/a/b/f");
    expect(runtime.fs.readdir("/a/b")).toEqual([{ name: "f", type: "file" }]);
    expect(text(runtime.fs.readFile("/link"))).toBe("x");
    expect(failure(() => runtime.fs.stat("/nope", true))).toMatchObject({
      code: "ENOENT",
      syscall: "stat",
      path: "/nope",
    });
  });

  it("reports stdio kinds and stats for pipes and terminals", () => {
    const plain = createFakeRuntime();
    expect([0, 1, 2].map((fd) => plain.fdStream.kind(fd))).toEqual(["pipe", "pipe", "pipe"]);
    expect(plain.tty.isatty(1)).toBe(false);
    expect(plain.fs.fstat(1).mode & 0o170000).toBe(0o010000);
    const terminal = createFakeRuntime({ tty: true });
    expect([0, 1, 2].map((fd) => terminal.fdStream.kind(fd))).toEqual(["tty", "tty", "tty"]);
    expect(terminal.fs.fstat(1).mode & 0o170000).toBe(0o020000);
  });
});

describe("stdio", () => {
  it("captures fd 1 and fd 2 from fs.write and fdStream.write", async () => {
    const runtime = createFakeRuntime();
    runtime.fs.write(1, bytes("out "), null);
    runtime.fs.write(2, bytes("err"), null);
    let doneWith: Error | null | undefined;
    runtime.fdStream.write(1, bytes("more"), (error) => {
      doneWith = error;
    });
    expect(doneWith).toBeUndefined();
    await settle();
    expect(doneWith).toBeNull();
    expect(runtime.stdout()).toBe("out more");
    expect(runtime.stderr()).toBe("err");
  });

  it("reports a failed stream write through done", async () => {
    const runtime = createFakeRuntime();
    let doneWith: Error | null = null;
    runtime.fdStream.write(42, bytes("x"), (error) => {
      doneWith = error;
    });
    await settle();
    expect((doneWith as SystemError | null)?.code).toBe("EBADF");
  });

  it("feeds stdin to fs.read, with EAGAIN when empty and EOF once closed", () => {
    const runtime = createFakeRuntime();
    expect(failure(() => runtime.fs.read(0, 10, null))).toMatchObject({ code: "EAGAIN" });
    runtime.feedStdin("hello");
    expect(text(runtime.fs.read(0, 3, null))).toBe("hel");
    expect(text(runtime.fs.read(0, 10, null))).toBe("lo");
    runtime.feedStdin(null);
    expect(runtime.fs.read(0, 10, null).length).toBe(0);
  });

  it("delivers stdin to readStart asynchronously and then null", async () => {
    const runtime = createFakeRuntime();
    const result = collect(runtime, 0);
    runtime.feedStdin("a");
    runtime.feedStdin(bytes("b"));
    runtime.feedStdin(null);
    expect(await result).toBe("ab");
  });

  it("stops delivering after readStop", async () => {
    const runtime = createFakeRuntime();
    const seen: string[] = [];
    runtime.fdStream.readStart(0, (chunk) => seen.push(chunk === null ? "EOF" : text(chunk)));
    runtime.fdStream.readStop(0);
    runtime.feedStdin("x");
    await settle();
    expect(seen).toEqual([]);
  });
});

describe("tty", () => {
  it("reports the window size, resizes and raw mode", () => {
    const runtime = createFakeRuntime({ tty: true });
    expect(runtime.tty.isatty(0)).toBe(true);
    expect(runtime.tty.windowSize(1)).toEqual({ columns: 80, rows: 24 });
    let resized = 0;
    const stop = runtime.tty.onResize(() => resized++);
    runtime.resize(120, 40);
    expect(runtime.tty.windowSize(1)).toEqual({ columns: 120, rows: 40 });
    stop();
    runtime.resize(100, 30);
    expect(resized).toBe(1);
    runtime.tty.setRawMode(0, true);
    expect(runtime.rawMode).toBe(true);
  });

  it("raises ENOTTY for terminal calls on a pipe", () => {
    const runtime = createFakeRuntime();
    expect(failure(() => runtime.tty.windowSize(1))).toMatchObject({ code: "ENOTTY" });
  });
});

describe("pipes", () => {
  it("passes bytes between its two fds and ends when the writer closes", async () => {
    const runtime = createFakeRuntime();
    const { readFd, writeFd } = runtime.processes.pipe();
    expect(runtime.fdStream.kind(readFd)).toBe("pipe");
    runtime.fs.write(writeFd, bytes("abc"), null);
    expect(text(runtime.fs.read(readFd, 10, null))).toBe("abc");
    expect(failure(() => runtime.fs.read(readFd, 10, null))).toMatchObject({ code: "EAGAIN" });
    const rest = collect(runtime, readFd);
    runtime.fdStream.write(writeFd, bytes("def"));
    runtime.fs.close(writeFd);
    expect(await rest).toBe("def");
  });

  it("raises EPIPE writing a pipe with no reader", () => {
    const runtime = createFakeRuntime();
    const { readFd, writeFd } = runtime.processes.pipe();
    runtime.fs.close(readFd);
    expect(failure(() => runtime.fs.write(writeFd, bytes("x"), null))).toMatchObject({
      code: "EPIPE",
    });
  });
});

describe("spawn", () => {
  it("raises ENOENT without a spawn callback", () => {
    const runtime = createFakeRuntime();
    expect(failure(() => runtime.processes.spawn(request(["pipe", "pipe", "pipe"], "ls")))).toEqual(
      { code: "ENOENT", syscall: "spawn ls", path: "ls" },
    );
  });

  it("runs the child with piped stdio and reports its exit", async () => {
    const runtime = createFakeRuntime({
      spawn: async (_request, io) => {
        await settle();
        const input = io.readStdin();
        io.writeStdout(`got ${text(input ?? new Uint8Array(0))}`);
        io.writeStderr("warn");
        return 4;
      },
    });
    const child = runtime.processes.spawn(request(["pipe", "pipe", "pipe"]));
    const [stdin, stdout, stderr] = child.stdio as number[];
    expect(child.pid).toBeGreaterThan(runtime.pid);
    expect(child.ipc).toBeNull();
    runtime.fs.write(stdin, bytes("data"), null);
    runtime.fs.close(stdin);
    const exit = new Promise<ExitStatus>((resolve) => runtime.processes.onExit(child.pid, resolve));
    const [out, err, status] = await Promise.all([
      collect(runtime, stdout),
      collect(runtime, stderr),
      exit,
    ]);
    expect(out).toBe("got data");
    expect(err).toBe("warn");
    expect(status).toEqual({ code: 4, signal: null });
  });

  it("drains stdin per call and returns null once closed", async () => {
    const reads: (string | null)[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createFakeRuntime({
      spawn: async (_request, io) => {
        const first = io.readStdin();
        reads.push(first === null ? null : text(first));
        await gate;
        const second = io.readStdin();
        reads.push(second === null ? null : text(second));
        const third = io.readStdin();
        reads.push(third === null ? null : text(third));
        return 0;
      },
    });
    const child = runtime.processes.spawn(request(["pipe", "ignore", "ignore"]));
    const stdin = child.stdio[0] as number;
    runtime.fs.write(stdin, bytes("one"), null);
    await settle();
    runtime.fs.write(stdin, bytes("two"), null);
    runtime.fs.close(stdin);
    release();
    await settle();
    expect(reads).toEqual(["one", "two", null]);
  });

  it("inherits the parent's stdio", async () => {
    const runtime = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("to parent out");
        io.writeStderr("to parent err");
        const input = io.readStdin();
        io.writeStdout(` [${input === null ? "eof" : text(input)}]`);
        return 0;
      },
    });
    runtime.feedStdin("typed");
    const child = runtime.processes.spawn(request(["inherit", "inherit", "inherit"]));
    expect(child.stdio).toEqual([null, null, null]);
    await settle();
    expect(runtime.stdout()).toBe("to parent out [typed]");
    expect(runtime.stderr()).toBe("to parent err");
  });

  it("discards ignored stdio", async () => {
    const runtime = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("lost");
        return io.readStdin() === null ? 0 : 1;
      },
    });
    const child = runtime.processes.spawn(request(["ignore", "ignore", "ignore"]));
    const status = await new Promise<ExitStatus>((resolve) =>
      runtime.processes.onExit(child.pid, resolve),
    );
    expect(status.code).toBe(0);
    expect(runtime.stdout()).toBe("");
  });

  it("writes to a parent fd given by number, ending the pipe when the child exits", async () => {
    const runtime = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("through the pipe");
        return 0;
      },
    });
    const { readFd, writeFd } = runtime.processes.pipe();
    const output = collect(runtime, readFd);
    runtime.processes.spawn(request(["ignore", writeFd, "ignore"]));
    runtime.fs.close(writeFd);
    expect(await output).toBe("through the pipe");
  });

  it("writes to a file fd given by number", async () => {
    const runtime = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("logged");
        return 0;
      },
    });
    const fd = runtime.fs.open("/log", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    const child = runtime.processes.spawn(request(["ignore", fd, fd]));
    await new Promise((resolve) => runtime.processes.onExit(child.pid, resolve));
    runtime.fs.close(fd);
    expect(text(runtime.vfs.readFile("/log"))).toBe("logged");
  });

  it("assigns increasing pids", () => {
    const runtime = createFakeRuntime({ spawn: () => 0 });
    const a = runtime.processes.spawn(request(["ignore", "ignore", "ignore"]));
    const b = runtime.processes.spawn(request(["ignore", "ignore", "ignore"]));
    expect(b.pid).toBeGreaterThan(a.pid);
  });

  it("reports an exit to a listener added after it", async () => {
    const runtime = createFakeRuntime({ spawn: () => 2 });
    const child = runtime.processes.spawn(request(["ignore", "ignore", "ignore"]));
    await settle();
    const status = await new Promise<ExitStatus>((resolve) =>
      runtime.processes.onExit(child.pid, resolve),
    );
    expect(status).toEqual({ code: 2, signal: null });
  });

  it("turns a throwing callback into exit code 1 with the error on stderr", async () => {
    const runtime = createFakeRuntime({
      spawn: () => {
        throw new Error("boom");
      },
    });
    const child = runtime.processes.spawn(request(["ignore", "ignore", "pipe"]));
    const err = collect(runtime, child.stdio[2] as number);
    const status = await new Promise<ExitStatus>((resolve) =>
      runtime.processes.onExit(child.pid, resolve),
    );
    expect(status.code).toBe(1);
    expect(await err).toContain("boom");
  });

  it("settles a running child on kill and raises ESRCH afterwards", async () => {
    const runtime = createFakeRuntime({ spawn: () => new Promise<number>(() => {}) });
    const child = runtime.processes.spawn(request(["ignore", "pipe", "ignore"]));
    const output = collect(runtime, child.stdio[1] as number);
    const exit = new Promise<ExitStatus>((resolve) => runtime.processes.onExit(child.pid, resolve));
    await settle();
    runtime.processes.kill(child.pid, "SIGTERM");
    expect(await exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(await output).toBe("");
    expect(failure(() => runtime.processes.kill(child.pid, "SIGTERM"))).toMatchObject({
      code: "ESRCH",
      syscall: "kill",
    });
    expect(failure(() => runtime.processes.kill(9999, "SIGTERM"))).toMatchObject({
      code: "ESRCH",
    });
  });

  it("delivers signals to onSignal listeners, ending the process without one", () => {
    const quiet = createFakeRuntime();
    quiet.signal("SIGINT");
    expect(quiet.exitCode).toBe(130);
    const runtime = createFakeRuntime();
    const seen: string[] = [];
    runtime.processes.onSignal((signal) => {
      seen.push(signal);
      return true;
    });
    runtime.signal("SIGINT");
    runtime.processes.kill(runtime.pid, "SIGTERM");
    expect(seen).toEqual(["SIGINT", "SIGTERM"]);
    expect(runtime.exitCode).toBeNull();
  });
});

describe("spawnSync", () => {
  it("runs the child and collects its output", () => {
    const runtime = createFakeRuntime({
      spawn: (req, io) => {
        const input = io.readStdin();
        io.writeStdout(`${req.command}:${input === null ? "" : text(input)}`);
        io.writeStderr("e");
        expect(io.readStdin()).toBeNull();
        return 5;
      },
    });
    const result = runtime.processes.spawnSync({
      ...request(["pipe", "pipe", "pipe"], "echo"),
      input: bytes("in"),
    });
    expect(result.status).toEqual({ code: 5, signal: null });
    expect(text(result.stdout)).toBe("echo:in");
    expect(text(result.stderr)).toBe("e");
    expect(result.error).toBeUndefined();
  });

  it("sends inherited output to the parent", () => {
    const runtime = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("shown");
        return 0;
      },
    });
    const result = runtime.processes.spawnSync(request(["pipe", "inherit", "pipe"]));
    expect(result.stdout.length).toBe(0);
    expect(runtime.stdout()).toBe("shown");
  });

  it("reports ENOENT without a spawn callback", () => {
    const runtime = createFakeRuntime();
    const result = runtime.processes.spawnSync(request(["pipe", "pipe", "pipe"], "nope"));
    expect(result.error).toEqual({ code: "ENOENT", syscall: "spawnSync nope", path: "nope" });
    expect(result.status).toEqual({ code: null, signal: null });
  });

  it("refuses a callback that returns a promise", () => {
    const runtime = createFakeRuntime({ spawn: async () => 0 });
    const result = runtime.processes.spawnSync(request(["pipe", "pipe", "pipe"]));
    expect(result.status.code).toBe(1);
    expect(text(result.stderr)).toContain("promise");
  });

  it("reports ENOBUFS past maxBuffer", () => {
    const runtime = createFakeRuntime({
      spawn: (_request, io) => {
        io.writeStdout("0123456789");
        return 0;
      },
    });
    const result = runtime.processes.spawnSync({
      ...request(["pipe", "pipe", "pipe"]),
      maxBuffer: 4,
    });
    expect(result.error).toBe("ENOBUFS");
  });
});

describe("loopback network", () => {
  it("connects a client to a listening server both ways", async () => {
    const runtime = createFakeRuntime();
    const serverGot: string[] = [];
    let serverEnded = false;
    const server = runtime.net.listen(3000, "127.0.0.1", (channel, remote) => {
      expect(remote.address).toBe("127.0.0.1");
      channel.onData = (chunk) => {
        serverGot.push(text(chunk));
        channel.write(bytes(`echo:${text(chunk)}`));
      };
      channel.onEnd = () => {
        serverEnded = true;
        channel.end();
      };
    });
    expect(server.port).toBe(3000);
    const client = await runtime.net.connect(3000, "localhost");
    const clientGot: string[] = [];
    let clientClosed = false;
    client.onData = (chunk) => clientGot.push(text(chunk));
    client.onClose = () => {
      clientClosed = true;
    };
    client.write(bytes("hi"));
    await settle();
    client.end();
    await settle();
    expect(serverGot).toEqual(["hi"]);
    expect(clientGot).toEqual(["echo:hi"]);
    expect(serverEnded).toBe(true);
    expect(clientClosed).toBe(true);
  });

  it("refuses a connection when nothing listens", async () => {
    const runtime = createFakeRuntime();
    await expect(runtime.net.connect(4000, "localhost")).rejects.toMatchObject({
      code: "ECONNREFUSED",
      syscall: "connect",
      port: 4000,
    });
  });

  it("picks a free port for 0 and raises EADDRINUSE for a taken one", () => {
    const runtime = createFakeRuntime();
    const first = runtime.net.listen(0, "0.0.0.0", () => {});
    const second = runtime.net.listen(0, "0.0.0.0", () => {});
    expect(first.port).toBe(49152);
    expect(second.port).toBe(49153);
    expect(failure(() => runtime.net.listen(49152, "0.0.0.0", () => {}))).toMatchObject({
      code: "EADDRINUSE",
      syscall: "listen",
    });
    first.close();
    expect(runtime.net.listen(49152, "0.0.0.0", () => {}).port).toBe(49152);
  });
});

describe("createChannelPair", () => {
  it("delivers in order, buffers until a data listener is set, and destroys both sides", async () => {
    const [a, b]: [ByteChannel, ByteChannel] = createChannelPair();
    a.write(bytes("1"));
    a.write(bytes("2"));
    await settle();
    const got: string[] = [];
    b.onData = (chunk) => got.push(text(chunk));
    await settle();
    expect(got).toEqual(["1", "2"]);
    const closed: string[] = [];
    a.onClose = () => closed.push("a");
    b.onClose = () => closed.push("b");
    b.destroy();
    await settle();
    expect(closed.sort()).toEqual(["a", "b"]);
    expect(() => a.write(bytes("late"))).toThrow(/write after end/);
  });
});

describe("watch", () => {
  it("reports names relative to the watched directory", () => {
    const runtime = createFakeRuntime();
    runtime.fs.mkdir("/src/lib", true, 0o777);
    const seen: string[] = [];
    const stop = runtime.fs.watch("/src", true, (eventType, filename) =>
      seen.push(`${eventType}:${filename}`),
    );
    runtime.fs.writeFile("/src/lib/a.js", bytes("x"), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    stop();
    runtime.fs.writeFile("/src/b.js", bytes("x"), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    expect(seen).toEqual(["rename:lib/a.js", "change:lib/a.js"]);
  });

  it("reports a watched file by its own name", () => {
    const runtime = createFakeRuntime();
    runtime.fs.writeFile("/f.txt", bytes(""), O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    const seen: string[] = [];
    runtime.fs.watch("/f.txt", false, (eventType, filename) =>
      seen.push(`${eventType}:${filename}`),
    );
    runtime.fs.writeFile("/f.txt", bytes("x"), O_WRONLY | O_TRUNC, 0o644);
    // The truncation and the write are a change each, as on Linux.
    expect(seen).toEqual(["change:f.txt", "change:f.txt"]);
  });
});
