// @vitest-environment node
// The kernel over a real Vfs with fake process workers: the test plays each
// worker's side (raw sync/call/post messages, or a real sysClient), and checks
// spawn stdio, pipes and EOF, exit cleanup, signals, process groups, broken
// pipes, spawnSync limits, worker threads and listen/connect.
import { afterEach, describe, expect, it } from "vitest";
import { createProcessClient } from "../process/sysClient";
import type { ProcessClient } from "../process/sysClient";
import { setRuntime } from "../process/runtime";
import type { SpawnSyncResult } from "../process/runtime";
import childProcess from "../process/node/child_process";
import { FdReadable } from "../process/node/internal/fdStreams";
import * as net from "../process/node/net";
import { createProcess } from "../process/node/process";
import type { KernelEvent, KernelMessage, ProcessInit, ProcessMessage } from "../protocol";
import { SYNC_HEADER_BYTES, SYNC_OK, SYNC_PENDING, SYNC_STATE } from "../protocol";
import { decodePayload, readSyncAnswer } from "./codec";
import { Kernel } from "./kernel";
import type { KernelHost, KernelWorker } from "./kernel";
import { Vfs } from "./vfs/vfs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A process worker the test drives by hand. */
class FakeWorker implements KernelWorker {
  readonly name: string;
  readonly inbox: KernelMessage[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<ProcessMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  /** Set when a real sysClient plays this worker: messages reach it in a later task. */
  client: ProcessClient | null = null;

  constructor(name: string) {
    this.name = name;
  }

  postMessage(message: KernelMessage): void {
    this.inbox.push(message);
    const client = this.client;
    if (client && message.type !== "init") {
      setImmediate(() => {
        if (!this.terminated) {
          client.receive(message);
        }
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  get init(): ProcessInit {
    const init = this.inbox.find((message) => message.type === "init");
    if (!init) {
      throw new Error("no init yet");
    }
    return init;
  }

  /** What this worker sends the kernel. */
  send(message: ProcessMessage, ports: MessagePort[] = []): void {
    this.onmessage?.({ data: message, ports } as unknown as MessageEvent<ProcessMessage>);
  }

  post(op: string, ...args: unknown[]): void {
    this.send({ type: "post", op, args });
  }

  /** A blocking call: the answer, or `pending` while the kernel has not answered. */
  sync(op: string, ...args: unknown[]): SyncAnswer {
    const header = new Int32Array(this.init.syncBuffer, 0, SYNC_HEADER_BYTES / 4);
    Atomics.store(header, SYNC_STATE, SYNC_PENDING);
    this.send({ type: "sync", op, args });
    return this.answer();
  }

  answer(): SyncAnswer {
    const buffer = this.init.syncBuffer;
    const state = Atomics.load(new Int32Array(buffer, 0, SYNC_HEADER_BYTES / 4), SYNC_STATE);
    if (state === SYNC_PENDING) {
      return { pending: true, ok: false, value: undefined };
    }
    const { kind, bytes } = readSyncAnswer(buffer);
    return { pending: false, ok: state === SYNC_OK, value: decodePayload(kind, bytes) };
  }

  /** Waits for the answer to a blocking call the kernel answers later. */
  async settled(): Promise<SyncAnswer> {
    for (let turn = 0; turn < 200; turn += 1) {
      const answer = this.answer();
      if (!answer.pending) {
        return answer;
      }
      await tick();
    }
    throw new Error("no answer");
  }

  messages<T extends KernelMessage["type"]>(type: T): Extract<KernelMessage, { type: T }>[] {
    return this.inbox.filter((message) => message.type === type) as Extract<
      KernelMessage,
      { type: T }
    >[];
  }

  /** Plays this worker with a real sysClient. */
  attachClient(): ProcessClient {
    const client = createProcessClient(
      {
        postMessage: (message, transfer) =>
          this.send(
            message,
            (transfer ?? []).filter((item): item is MessagePort => item instanceof MessagePort),
          ),
      },
      this.init,
    );
    this.client = client;
    return client;
  }
}

interface SyncAnswer {
  pending: boolean;
  ok: boolean;
  value: unknown;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await tick();
  }
}

interface Harness {
  kernel: Kernel;
  workers: FakeWorker[];
  events: KernelEvent[];
  /** The worker of the process (or thread) with this id. */
  worker(id: number): FakeWorker;
  /** The newest worker. */
  last(): FakeWorker;
  env: Record<string, string>;
  cwd: string;
}

const openPorts: MessagePort[] = [];

function boot(): Harness {
  const workers: FakeWorker[] = [];
  const events: KernelEvent[] = [];
  const host: KernelHost = {
    createWorker(name) {
      const worker = new FakeWorker(name);
      workers.push(worker);
      return worker;
    },
    emit(event) {
      events.push(event);
    },
  };
  const kernel = new Kernel(new Vfs(), host, "app");
  const harness: Harness = {
    kernel,
    workers,
    events,
    worker(id) {
      const found = workers.find((worker) => {
        const init = worker.init;
        return (init.thread?.threadId ?? init.pid) === id;
      });
      if (!found) {
        throw new Error(`no worker ${id}`);
      }
      return found;
    },
    last: () => workers[workers.length - 1],
    env: kernel.defaultEnvironment(),
    cwd: kernel.workdir,
  };
  return harness;
}

/** Spawns a child from `parent` (a raw worker); returns its pid, its fds in the parent and its worker. */
function spawnFrom(
  h: Harness,
  parent: FakeWorker,
  stdio: unknown[] = ["pipe", "pipe", "pipe"],
  extra: Record<string, unknown> = {},
): { pid: number; stdio: (number | null)[]; worker: FakeWorker } {
  const answer = parent.sync(
    "proc.spawn",
    { command: "node", args: ["child.js"], cwd: h.cwd, env: h.env, stdio, ...extra },
    null,
  );
  expect(answer.ok).toBe(true);
  const value = answer.value as { pid: number; stdio: (number | null)[] };
  return { ...value, worker: h.last() };
}

/** Starts a worker thread of `owner`; returns its worker. */
function spawnThread(h: Harness, owner: FakeWorker): FakeWorker {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  owner.send({ type: "post", op: "handoff", args: ["thread:1", null] }, [port2]);
  const answer = owner.sync(
    "thread.spawn",
    {
      filename: "/w.js",
      eval: false,
      workerData: null,
      transferList: [],
      argv: [],
      execArgv: [],
      env: h.env,
      cwd: h.cwd,
      name: "",
    },
    "thread:1",
  );
  expect(answer.ok).toBe(true);
  return h.last();
}

afterEach(() => {
  setRuntime(null);
  for (const port of openPorts.splice(0)) {
    port.close();
  }
});

describe("spawn, pipes and exit", () => {
  it("wires a child's piped stdio to the parent and ends its stdout at exit", async () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("node", ["parent.js"], {});
    const parent = h.worker(parentPid);
    expect(parent.init.ttyFds).toEqual([0, 1, 2]);
    const child = spawnFrom(h, parent);
    expect(child.stdio).toHaveLength(3);
    expect(child.worker.init.ppid).toBe(parentPid);
    expect(child.worker.init.ttyFds).toEqual([]);

    // Parent → child stdin.
    const [stdinFd, stdoutFd] = child.stdio as number[];
    expect(parent.sync("fs.write", stdinFd, encoder.encode("ping"), null).value).toBe(4);
    const read = child.worker.sync("fs.read", 0, 100, null);
    expect(decoder.decode(read.value as Uint8Array)).toBe("ping");

    // Child stdout → parent, then end of stream once the child exits.
    child.worker.post("fd.write", 1, encoder.encode("pong"));
    parent.post("fd.readStart", stdoutFd);
    child.worker.post("proc.exit", 3);
    const data = parent.messages("fd-data").filter((message) => message.fd === stdoutFd);
    expect(data.map((message) => (message.chunk ? decoder.decode(message.chunk) : null))).toEqual([
      "pong",
      null,
    ]);
    expect(child.worker.terminated).toBe(true);
    expect(parent.messages("child-exit")).toEqual([
      { type: "child-exit", pid: child.pid, status: { code: 3, signal: null } },
    ]);
  });

  it("reports a page process's exit and closes its listeners", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["server.js"], {});
    const proc = h.worker(pid);
    const listened = proc.sync("net.listen", 3000).value as { port: number; listenerId: number };
    expect(listened.port).toBe(3000);
    expect(h.events).toContainEqual({ event: "port", port: 3000, type: "open" });
    proc.post("proc.exit", 0);
    expect(h.events).toContainEqual({ event: "port", port: 3000, type: "close" });
    expect(h.events).toContainEqual({ event: "exit", pid, code: 0 });
  });

  it("connects the page to a listening process and refuses a closed port", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["server.js"], {});
    const proc = h.worker(pid);
    const { port, listenerId } = proc.sync("net.listen", 4000).value as {
      port: number;
      listenerId: number;
    };
    const channel = await h.kernel.connect(port);
    const connection = proc.messages("connection")[0];
    expect(connection.listenerId).toBe(listenerId);
    openPorts.push(connection.port);
    proc.post("net.close", listenerId);
    await expect(h.kernel.connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    channel.destroy();
  });

  it("ends a process on an unhandled signal and delivers a handled one", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const handler = spawnFrom(h, parent);
    handler.worker.post("proc.signals", ["SIGTERM"]);
    parent.sync("proc.kill", handler.pid, "SIGTERM");
    expect(handler.worker.messages("signal")).toEqual([{ type: "signal", signal: "SIGTERM" }]);
    expect(handler.worker.terminated).toBe(false);

    const plain = spawnFrom(h, parent);
    parent.sync("proc.kill", plain.pid, "SIGTERM");
    expect(plain.worker.terminated).toBe(true);
    expect(parent.messages("child-exit").at(-1)).toEqual({
      type: "child-exit",
      pid: plain.pid,
      status: { code: null, signal: "SIGTERM" },
    });
    expect(parent.sync("proc.kill", plain.pid, "SIGTERM")).toMatchObject({ ok: false });
  });
});

describe("reading with backpressure", () => {
  it("loses no byte when a reader pauses with chunks already sent", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const client = parent.attachClient();
    setRuntime(client.runtime);
    const handle = client.runtime.processes.spawn({
      command: "node",
      args: ["child.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = h.last();

    // Five 64 KiB chunks are buffered before the parent reads, so the kernel
    // sends them all at once; the first one fills the stream's buffer.
    const expected: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      child.post("fd.write", 1, new Uint8Array(65536).fill(index + 1));
      expected.push(index + 1);
    }
    child.post("proc.exit", 0);

    const stdout = new FdReadable(handle.stdio[1]!);
    const received: Uint8Array[] = [];
    const done = (async () => {
      for await (const chunk of stdout) {
        received.push(chunk as Uint8Array);
        // A slow consumer.
        await settle(3);
      }
    })();
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream never ended")), 3000)),
    ]);
    const all = new Uint8Array(received.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of received) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(all.byteLength).toBe(5 * 65536);
    for (let index = 0; index < 5; index += 1) {
      expect(all[index * 65536]).toBe(expected[index]);
      expect(all[index * 65536 + 65535]).toBe(expected[index]);
    }
  });
});

describe("worker threads", () => {
  it("frees a thread's listeners and pumps when its process ends", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    const thread = spawnThread(h, main);
    const { port } = thread.sync("net.listen", 5000).value as { port: number };
    expect(port).toBe(5000);
    thread.post("fd.readStart", 0);
    main.post("proc.exit", 0);
    expect(thread.terminated).toBe(true);
    expect(h.events).toContainEqual({ event: "port", port: 5000, type: "close" });
    await expect(h.kernel.connect(5000)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    // The thread's stdin pump is gone: typed input does not reach a dead worker.
    h.kernel.writeInput(pid, "x\n");
    expect(thread.messages("fd-data")).toEqual([]);
  });

  it("keeps the main thread's handled signals when a thread publishes its own", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    main.post("proc.signals", ["SIGINT"]);
    const thread = spawnThread(h, main);
    thread.post("proc.signals", []);
    h.kernel.writeInput(pid, "\x03");
    expect(main.messages("signal")).toEqual([{ type: "signal", signal: "SIGINT" }]);
    expect(main.terminated).toBe(false);
  });

  it("reports a child's exit to the thread that spawned it", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    const thread = spawnThread(h, main);
    const child = spawnFrom(h, thread);
    expect(child.worker.init.ppid).toBe(pid);
    child.worker.post("proc.exit", 7);
    expect(thread.messages("child-exit")).toEqual([
      { type: "child-exit", pid: child.pid, status: { code: 7, signal: null } },
    ]);
    expect(main.messages("child-exit")).toEqual([]);
  });

  it("tells the process when one of its threads exits", () => {
    const h = boot();
    const main = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const thread = spawnThread(h, main);
    thread.post("proc.exit", 2);
    expect(main.messages("thread-exit")).toEqual([
      { type: "thread-exit", threadId: thread.init.thread!.threadId, code: 2 },
    ]);
  });
});

describe("Ctrl+C and process groups", () => {
  it("interrupts every process in the foreground's group, piped children too", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    main.post("proc.signals", ["SIGINT"]);
    // `piped` reads a pipe; `foreground` inherits the terminal and is the foreground reader.
    const piped = spawnFrom(h, main, ["pipe", "pipe", "pipe"]);
    const foreground = spawnFrom(h, main, ["inherit", "inherit", "inherit"]);
    expect(foreground.worker.init.ttyFds).toEqual([0, 1, 2]);
    h.kernel.writeInput(pid, "\x03");
    expect(piped.worker.terminated).toBe(true);
    expect(foreground.worker.terminated).toBe(true);
    expect(main.terminated).toBe(false);
    expect(main.messages("signal")).toEqual([{ type: "signal", signal: "SIGINT" }]);
  });

  it("leaves a process that started a group of its own alone", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    main.post("proc.signals", ["SIGINT"]);
    const background = spawnFrom(h, main);
    background.worker.post("proc.setpgid", 0);
    h.kernel.writeInput(pid, "\x03");
    expect(background.worker.terminated).toBe(false);
  });

  it("hands an exited process's children to its parent so killTree reaches them", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    const middle = spawnFrom(h, main);
    const grandchild = spawnFrom(h, middle.worker);
    middle.worker.post("proc.exit", 0);
    expect(grandchild.worker.terminated).toBe(false);
    h.kernel.killTree(pid);
    expect(grandchild.worker.terminated).toBe(true);
    expect(main.terminated).toBe(true);
  });

  it("keeps a parent's raw mode when a child attaches to the terminal", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    main.sync("tty.setRawMode", 0, true);
    const child = spawnFrom(h, main, ["inherit", "inherit", "inherit"]);
    child.worker.post("fd.readStart", 0);
    h.kernel.writeInput(pid, "a");
    // Raw: the key arrives at once, without a line ending.
    expect(child.worker.messages("fd-data").map((m) => decoder.decode(m.chunk!))).toEqual(["a"]);
  });
});

describe("broken pipes", () => {
  it("ends a writer that does not handle SIGPIPE", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const child = spawnFrom(h, parent);
    parent.post("fd.close", child.stdio[1]);
    const answer = child.worker.sync("fs.write", 1, encoder.encode("x"), null);
    expect(answer.pending).toBe(true);
    expect(child.worker.terminated).toBe(true);
    expect(parent.messages("child-exit").at(-1)?.status).toEqual({ code: null, signal: "SIGPIPE" });
  });

  it("ends a writer whose asynchronous write hits a broken pipe", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const child = spawnFrom(h, parent);
    parent.post("fd.close", child.stdio[1]);
    child.worker.post("fd.write", 1, encoder.encode("x"));
    expect(child.worker.terminated).toBe(true);
  });

  it("fails the write with EPIPE when the writer handles SIGPIPE", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const child = spawnFrom(h, parent);
    child.worker.post("proc.signals", ["SIGPIPE"]);
    parent.post("fd.close", child.stdio[1]);
    const answer = child.worker.sync("fs.write", 1, encoder.encode("x"), null);
    expect(answer.ok).toBe(false);
    expect((answer.value as { code?: string }).code).toBe("EPIPE");
    expect(child.worker.messages("signal")).toEqual([{ type: "signal", signal: "SIGPIPE" }]);
    expect(child.worker.terminated).toBe(false);

    child.worker.send({ type: "call", id: 9, op: "fd.write", args: [1, encoder.encode("y")] });
    const reply = child.worker.messages("reply").find((message) => message.id === 9);
    expect(reply).toMatchObject({ ok: false, error: { code: "EPIPE" } });
  });
});

describe("spawnSync", () => {
  it("kills a child that overruns maxBuffer and reports ENOBUFS", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const answer = parent.sync("proc.spawnSync", {
      command: "node",
      args: ["noisy.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10,
    });
    expect(answer.pending).toBe(true);
    const child = h.last();
    child.post("fd.write", 1, encoder.encode("0123456789abcdef"));
    expect(child.terminated).toBe(true);
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(result.error).toBe("ENOBUFS");
    expect(decoder.decode(result.stdout)).toBe("0123456789");
    expect(result.status).toEqual({ code: null, signal: "SIGTERM" });
    // spawnSync collects the exit itself: no child-exit for nobody to hear.
    expect(parent.messages("child-exit")).toEqual([]);
  });

  it("collects output within maxBuffer as usual", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "node",
      args: ["quiet.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10,
    });
    const child = h.last();
    child.post("fd.write", 1, encoder.encode("0123456789"));
    child.post("proc.exit", 0);
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(result.error).toBeUndefined();
    expect(decoder.decode(result.stdout)).toBe("0123456789");
    expect(result.status).toEqual({ code: 0, signal: null });
  });
});

describe("leaks", () => {
  it("cancels a dead process's blocked read so it cannot take another reader's bytes", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const { readFd, writeFd } = parent.sync("proc.pipe").value as {
      readFd: number;
      writeFd: number;
    };
    const child = spawnFrom(h, parent, [readFd, "pipe", "pipe"]);
    expect(child.worker.sync("fs.read", 0, 100, null).pending).toBe(true);
    parent.sync("proc.kill", child.pid, "SIGKILL");
    parent.sync("fs.write", writeFd, encoder.encode("hi"), null);
    const read = parent.sync("fs.read", readFd, 100, null);
    expect(decoder.decode(read.value as Uint8Array)).toBe("hi");
  });

  it("closes the ipc port posted ahead of a spawn that fails", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const { port1, port2 } = new MessageChannel();
    openPorts.push(port1);
    const closed = new Promise<void>((resolve) =>
      (port1 as unknown as { once(event: string, listener: () => void): void }).once("close", () =>
        resolve(),
      ),
    );
    parent.send({ type: "post", op: "handoff", args: ["ipc:1", null] }, [port2]);
    const answer = parent.sync(
      "proc.spawn",
      {
        command: "missing",
        args: [],
        cwd: h.cwd,
        env: h.env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
      "ipc:1",
    );
    expect(answer.ok).toBe(false);
    expect((answer.value as { code?: string }).code).toBe("ENOENT");
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("port left open")), 2000)),
    ]);
  });
});

describe("SIGPIPE in a node process", () => {
  it("fails the write with EPIPE on the stream and leaves the process alive, as Node does", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["parent.js"], {}));
    setRuntime(parent.attachClient().runtime);
    // What `node` does at boot.
    createProcess({ loadBuiltin: () => ({}), ipc: null });
    const child = childProcess.spawn("node", ["child.js"]);
    const errors: string[] = [];
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? ""));
    // The child closes its input without reading it, and keeps running.
    h.last().post("fd.close", 0);
    child.stdin!.write("data nobody reads\n");
    await settle(10);
    expect(parent.terminated).toBe(false);
    expect(errors).toEqual(["EPIPE"]);
  });
});

describe("ephemeral ports", () => {
  it("stay in 49152-65535 however many connections a session makes", async () => {
    const h = boot();
    const server = h.worker(h.kernel.spawnFromPage("node", ["server.js"], {}));
    server.sync("net.listen", 3000);
    const client = h.worker(h.kernel.spawnFromPage("node", ["client.js"], {}));
    let refused = 0;
    for (let index = 0; index < 16400; index += 1) {
      (await h.kernel.connect(3000)).destroy();
      refused += client.sync("net.connect", 3000).ok ? 0 : 1;
    }
    expect(refused).toBe(0);
    for (const message of server.messages("connection")) {
      expect(message.remotePort).toBeGreaterThanOrEqual(49152);
      expect(message.remotePort).toBeLessThanOrEqual(65535);
      message.port.close();
    }
    const { port } = server.sync("net.listen", 0).value as { port: number };
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("skip ports in use and do not spend listen ports on connections", () => {
    const h = boot();
    const server = h.worker(h.kernel.spawnFromPage("node", ["server.js"], {}));
    server.sync("net.listen", 49152);
    server.sync("net.listen", 3000);
    const first = server.sync("net.listen", 0).value as { port: number };
    expect(first.port).toBe(49153);
    server.sync("net.connect", 3000);
    const second = server.sync("net.listen", 0).value as { port: number };
    expect(second.port).toBe(49154);
    for (const message of server.messages("connection")) {
      message.port.close();
    }
  });
});

describe("the terminal and background jobs", () => {
  it("keeps the shell's input and Ctrl+C when a job starts in a group of its own", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("proc.signals", ["SIGINT"]);
    const background = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    shell.sync("tty.setRawMode", 0, true);
    shell.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "ls\r");
    expect(shell.messages("fd-data")).toHaveLength(1);
    expect(background.worker.messages("fd-data")).toEqual([]);
    shell.post("fd.readStop", 0);
    shell.sync("tty.setRawMode", 0, false);
    h.kernel.writeInput(shellPid, "\x03");
    expect(background.worker.terminated).toBe(false);
    expect(shell.messages("signal")).toEqual([{ type: "signal", signal: "SIGINT" }]);
  });

  it("does not hand the terminal to what a background job starts", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    const job = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    const grandchild = spawnFrom(h, job.worker, ["inherit", "inherit", "inherit"]);
    shell.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "a\r");
    expect(shell.messages("fd-data")).toHaveLength(1);
    expect(grandchild.worker.messages("fd-data")).toEqual([]);
  });

  it("still hands the terminal to a foreground child", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    const child = spawnFrom(h, shell, [0, 1, 2]);
    child.worker.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "a\r");
    expect(child.worker.messages("fd-data")).toHaveLength(1);
  });
});

describe("process groups and default signal actions", () => {
  it("signals a whole group with a negative pid", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const leader = spawnFrom(h, parent, ["ignore", "ignore", "ignore"], { newGroup: true });
    const member = spawnFrom(h, leader.worker, ["ignore", "ignore", "ignore"]);
    const answer = parent.sync("proc.kill", -leader.pid, "SIGTERM");
    expect(answer.ok).toBe(true);
    expect(leader.worker.terminated).toBe(true);
    expect(member.worker.terminated).toBe(true);
    expect(parent.terminated).toBe(false);
    expect(parent.sync("proc.kill", -leader.pid, "SIGTERM")).toMatchObject({ ok: false });
  });

  it("signals the caller's own group with pid 0", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    parent.post("proc.signals", ["SIGTERM"]);
    const same = spawnFrom(h, parent, ["ignore", "ignore", "ignore"]);
    const other = spawnFrom(h, parent, ["ignore", "ignore", "ignore"], { newGroup: true });
    expect(parent.sync("proc.kill", 0, "SIGTERM").ok).toBe(true);
    expect(same.worker.terminated).toBe(true);
    expect(other.worker.terminated).toBe(false);
    expect(parent.messages("signal")).toEqual([{ type: "signal", signal: "SIGTERM" }]);
  });

  it("ignores SIGCHLD, SIGURG, SIGWINCH and SIGCONT, and does not end a process on a stop signal", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent, ["ignore", "ignore", "ignore"]);
    for (const signal of [
      "SIGCHLD",
      "SIGURG",
      "SIGWINCH",
      "SIGCONT",
      "SIGSTOP",
      "SIGTSTP",
      "SIGTTIN",
      "SIGTTOU",
    ]) {
      expect(parent.sync("proc.kill", child.pid, signal).ok).toBe(true);
    }
    expect(child.worker.terminated).toBe(false);
    expect(parent.messages("child-exit")).toEqual([]);
  });

  it("delivers an ignored-by-default signal the process listens for", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent, ["ignore", "ignore", "ignore"]);
    child.worker.post("proc.signals", ["SIGWINCH"]);
    parent.sync("proc.kill", child.pid, "SIGWINCH");
    expect(child.worker.messages("signal")).toEqual([{ type: "signal", signal: "SIGWINCH" }]);
  });
});

describe("terminal size", () => {
  it("tells a child whose stdout is the terminal about a resize", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["a.js"], {});
    const parent = h.worker(pid);
    const child = spawnFrom(h, parent, ["pipe", "inherit", "inherit"]);
    const piped = spawnFrom(h, parent, ["pipe", "pipe", "pipe"]);
    h.kernel.resizeTerminal(pid, { cols: 120, rows: 40 });
    expect(child.worker.messages("resize")).toEqual([
      { type: "resize", terminal: { cols: 120, rows: 40 } },
    ]);
    expect(parent.messages("resize")).toHaveLength(1);
    expect(piped.worker.messages("resize")).toEqual([]);
  });
});

describe("what an exited page process leaves behind", () => {
  it("can still be ended through the page process's pid", () => {
    const h = boot();
    const pagePid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(pagePid);
    const server = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    const grandchild = spawnFrom(h, server.worker, ["ignore", "ignore", "ignore"]);
    server.worker.sync("net.listen", 5173);
    shell.post("proc.exit", 0);
    expect(server.worker.terminated).toBe(false);
    h.kernel.killTree(pagePid);
    expect(server.worker.terminated).toBe(true);
    expect(grandchild.worker.terminated).toBe(true);
    expect(h.events).toContainEqual({ event: "port", port: 5173, type: "close" });
  });

  it("reaches the children of a left-behind process that exits in turn", () => {
    const h = boot();
    const pagePid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(pagePid);
    const middle = spawnFrom(h, shell, ["ignore", "ignore", "ignore"]);
    const leaf = spawnFrom(h, middle.worker, ["ignore", "ignore", "ignore"]);
    shell.post("proc.exit", 0);
    middle.worker.post("proc.exit", 0);
    h.kernel.killTree(pagePid);
    expect(leaf.worker.terminated).toBe(true);
  });
});

describe("a client socket's own address", () => {
  it("reports the port the kernel gave the connection", async () => {
    const h = boot();
    const server = h.worker(h.kernel.spawnFromPage("node", ["server.js"], {}));
    server.sync("net.listen", 4000);
    const client = h.worker(h.kernel.spawnFromPage("node", ["client.js"], {}));
    setRuntime(client.attachClient().runtime);
    const socket = net.connect(4000, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    const connection = server.messages("connection")[0];
    openPorts.push(connection.port);
    expect(socket.localPort).toBe(connection.remotePort);
    expect(socket.localAddress).toBe("127.0.0.1");
    expect(socket.address()).toEqual({
      address: "127.0.0.1",
      family: "IPv4",
      port: connection.remotePort,
    });
    socket.destroy();
  });
});

describe("fs.watch names", () => {
  it("reports entry names when the watched path is not canonical or goes through a link", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["w.js"], {}));
    h.kernel.vfs.mkdir("/p/real", true, 0o755);
    h.kernel.vfs.symlink("/p/real", "/p/link");
    const dot = proc.sync("fs.watch", "/p/.", false).value as number;
    const link = proc.sync("fs.watch", "/p/link", false).value as number;
    const slash = proc.sync("fs.watch", "/p/real/", false).value as number;
    h.kernel.vfs.writeFile("/p/a.txt", encoder.encode("1"), 0o1101, 0o644);
    h.kernel.vfs.writeFile("/p/real/b.txt", encoder.encode("1"), 0o1101, 0o644);
    const names = (watchId: number) => [
      ...new Set(
        proc
          .messages("watch")
          .filter((message) => message.watchId === watchId)
          .map((message) => message.filename),
      ),
    ];
    expect(names(dot)).toEqual(["a.txt"]);
    expect(names(link)).toEqual(["b.txt"]);
    expect(names(slash)).toEqual(["b.txt"]);
  });
});

describe("devices by path", () => {
  /** A child whose stdin is a pipe from its parent, and the parent's fds for its stdio. */
  function piped(h: Harness) {
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent);
    const [stdin, stdout] = child.stdio as number[];
    return { parent, child: child.worker, stdin, stdout };
  }

  const isRegularFileAt = (h: Harness, path: string) => {
    try {
      return (h.kernel.vfs.stat(path, false).mode & 0o170000) === 0o100000;
    } catch {
      return false;
    }
  };

  it("reads /dev/stdin to its end, waiting for the writer", async () => {
    const h = boot();
    const { parent, child, stdin } = piped(h);
    parent.sync("fs.write", stdin, encoder.encode("hello\n"), null);
    expect(child.sync("fs.readFile", "/dev/stdin").pending).toBe(true);
    parent.sync("fs.write", stdin, encoder.encode("world\n"), null);
    parent.sync("fs.close", stdin);
    const answer = await child.settled();
    expect(answer.ok).toBe(true);
    expect(decoder.decode(answer.value as Uint8Array)).toBe("hello\nworld\n");
  });

  it("writes /dev/stdout and /dev/stderr to the descriptors, never to a file", () => {
    const h = boot();
    const { parent, child, stdout } = piped(h);
    expect(
      child.sync("fs.writeFile", "/dev/stdout", encoder.encode("out\n"), 0o1101, 0o666).ok,
    ).toBe(true);
    expect(
      child.sync("fs.writeFile", "//dev/stderr", encoder.encode("err\n"), 0o1101, 0o666).ok,
    ).toBe(true);
    const read = parent.sync("fs.read", stdout, 100, null);
    expect(decoder.decode(read.value as Uint8Array)).toBe("out\n");
    expect(isRegularFileAt(h, "/dev/stdout")).toBe(false);
    expect(isRegularFileAt(h, "/dev/stderr")).toBe(false);
  });

  it("makes /dev/null exist, empty and a character device under every spelling", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.mkdir("/p", true, 0o755);
    h.kernel.vfs.symlink("/dev/null", "/p/null-link");
    h.kernel.vfs.symlink("/dev", "/p/dev-link");
    for (const spelling of [
      "/dev/null",
      "//dev/null",
      "/dev/./null",
      "/dev/../dev/null",
      "/tmp/../dev/null",
      "/p/null-link",
      "/p/dev-link/null",
    ]) {
      expect(proc.sync("fs.writeFile", spelling, encoder.encode("junk"), 0o1101, 0o666).ok).toBe(
        true,
      );
      expect(proc.sync("fs.exists", spelling).value).toBe(true);
      const stat = proc.sync("fs.stat", spelling, true).value as { mode: number };
      expect(stat.mode & 0o170000).toBe(0o020000);
      expect((proc.sync("fs.readFile", spelling).value as Uint8Array).byteLength).toBe(0);
      expect(proc.sync("fs.realpath", spelling).value).toBe("/dev/null");
      expect(proc.sync("fs.access", spelling, 0).ok).toBe(true);
    }
    expect(isRegularFileAt(h, "/dev/null")).toBe(false);
  });

  it("reaches the descriptors through a link and through /dev/fd/N", () => {
    const h = boot();
    const { parent, child, stdin, stdout } = piped(h);
    h.kernel.vfs.mkdir("/p", true, 0o755);
    h.kernel.vfs.symlink("/dev", "/p/d");
    child.sync("fs.writeFile", "/p/d/stdout", encoder.encode("a"), 0o1101, 0o666);
    child.sync("fs.writeFile", "/dev/fd/1", encoder.encode("b"), 0o1101, 0o666);
    const fd = child.sync("fs.open", "/p/d/fd/1", 1, 0o666).value as number;
    child.sync("fs.write", fd, encoder.encode("c"), null);
    expect(decoder.decode(parent.sync("fs.read", stdout, 100, null).value as Uint8Array)).toBe("a");
    expect(decoder.decode(parent.sync("fs.read", stdout, 100, null).value as Uint8Array)).toBe("b");
    expect(decoder.decode(parent.sync("fs.read", stdout, 100, null).value as Uint8Array)).toBe("c");
    const names = (child.sync("fs.readdir", "/dev/fd").value as { name: string }[]).map(
      (entry) => entry.name,
    );
    expect(names).toEqual(["0", "1", "2", String(fd)]);
    expect(child.sync("fs.exists", "/dev/fd/99").value).toBe(false);
    parent.sync("fs.close", stdin);
    expect(child.sync("fs.readFile", "/dev/fd/0").ok).toBe(true);
  });

  it("refuses to remove, rename or replace a device, and keeps it a device", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const code = (answer: SyncAnswer) => (answer.value as { code?: string }).code;
    expect(code(proc.sync("fs.unlink", "/dev/null"))).toBe("EACCES");
    expect(code(proc.sync("fs.rm", "//dev/null", false, true))).toBe("EACCES");
    expect(code(proc.sync("fs.rename", "/dev/null", "/tmp/x"))).toBe("EACCES");
    expect(code(proc.sync("fs.rename", "/tmp", "/dev/stdout"))).toBe("EACCES");
    expect(code(proc.sync("fs.mkdir", "/dev/tty", false, 0o755))).toBe("EEXIST");
    expect(code(proc.sync("fs.symlink", "/tmp", "/dev/null"))).toBe("EEXIST");
    expect(code(proc.sync("fs.readlink", "/dev/null"))).toBe("EINVAL");
    expect(code(proc.sync("fs.open", "/dev/null", 0o301, 0o666))).toBe("EEXIST");
    expect(proc.sync("fs.utimes", "/dev/null", 1, 1, true).ok).toBe(true);
    expect(proc.sync("fs.exists", "/dev/null").value).toBe(true);
    expect(isRegularFileAt(h, "/dev/null")).toBe(false);
  });

  it("copies from /dev/stdin into a file and from a file into /dev/null", async () => {
    const h = boot();
    const { parent, child, stdin } = piped(h);
    parent.sync("fs.write", stdin, encoder.encode("piped"), null);
    parent.sync("fs.close", stdin);
    expect(
      (
        await (async () => {
          child.sync("fs.copyFile", "/dev/stdin", "/tmp/copy.txt", 0);
          return child.settled();
        })()
      ).ok,
    ).toBe(true);
    expect(decoder.decode(h.kernel.vfs.readFile("/tmp/copy.txt"))).toBe("piped");
    expect(child.sync("fs.copyFile", "/tmp/copy.txt", "/dev/null", 0).ok).toBe(true);
    expect(isRegularFileAt(h, "/dev/null")).toBe(false);
  });

  it("still opens an ordinary path and reports a real loop of links", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.symlink("/tmp/loop", "/tmp/loop");
    expect((proc.sync("fs.readFile", "/tmp/loop").value as { code?: string }).code).toBe("ELOOP");
    expect(proc.sync("fs.exists", "/tmp/loop").value).toBe(false);
    const fd = proc.sync("fs.open", "/tmp/f.txt", 0o101, 0o644).value as number;
    proc.sync("fs.write", fd, encoder.encode("x"), null);
    expect(decoder.decode(h.kernel.vfs.readFile("/tmp/f.txt"))).toBe("x");
  });
});
