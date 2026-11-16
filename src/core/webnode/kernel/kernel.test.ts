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
import { FdReadable } from "../process/node/internal/fdStreams";
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
