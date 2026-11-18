// @vitest-environment node
// The kernel over a real Vfs with fake process workers: the test plays each
// worker's side (raw sync/call/post messages, or a real sysClient), and checks
// spawn stdio, pipes and EOF, exit cleanup, signals, process groups, broken
// pipes, spawnSync limits, worker threads and listen/connect.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessClient } from "../process/sysClient";
import type { ProcessClient } from "../process/sysClient";
import { setRuntime } from "../process/runtime";
import type { SpawnSyncResult } from "../process/runtime";
import childProcess from "../process/node/child_process";
import { FdReadable } from "../process/node/internal/fdStreams";
import * as net from "../process/node/net";
import { createProcess } from "../process/node/process";
import type { KernelEvent, KernelMessage, ProcessInit, ProcessMessage } from "../protocol";
import { SYNC_BROKEN, SYNC_HEADER_BYTES, SYNC_OK, SYNC_PENDING, SYNC_STATE } from "../protocol";
import { decodePayload, readSyncAnswer } from "./codec";
import { Kernel } from "./kernel";
import type { KernelHost, KernelWorker } from "./kernel";
import { COPYFILE_EXCL, F_OK, R_OK, W_OK, X_OK, type StatData } from "./vfs/types";
import { Vfs } from "./vfs/vfs";
import type { SystemErrorRecord } from "../errors";
import { readUmask, writeUmask } from "../umask";

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

  /** What went with each message, by its place in `inbox`. */
  readonly transfers: Transferable[][] = [];

  postMessage(message: KernelMessage, transfer: Transferable[] = []): void {
    this.inbox.push(message);
    this.transfers.push(transfer);
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

/** Waits until the kernel has told the page of a port just listened on (it waits 50 ms). */
const announced = () => new Promise<void>((resolve) => setTimeout(resolve, 70));

describe("spawn, pipes and exit", () => {
  it("tells a child which descriptors above 2 it starts with", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["parent.js"], {}));
    expect(parent.init.inheritedFds).toEqual([]);
    // O_WRONLY | O_CREAT
    const opened = parent.sync("fs.open", `${h.cwd}/log.txt`, 0o101, 0o644);
    expect(opened.value).toBe(3);
    const child = spawnFrom(h, parent, ["pipe", "pipe", "pipe", "ignore", 3]);
    expect(child.worker.init.inheritedFds).toEqual([4]);
  });

  it("leaves closed a descriptor above 2 that is ignored or closed in the parent, as libuv does", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["parent.js"], {}));
    // O_WRONLY | O_CREAT
    expect(parent.sync("fs.open", `${h.cwd}/log.txt`, 0o101, 0o644).value).toBe(3);
    // 4 is ignored, 5 inherits the parent's closed 5, 6 takes the closed 9.
    const child = spawnFrom(h, parent, [
      "ignore",
      "ignore",
      "ignore",
      "inherit",
      "ignore",
      "inherit",
      9,
    ]);
    expect(child.worker.init.inheritedFds).toEqual([3]);
    for (const fd of [4, 5, 6]) {
      const answer = child.worker.sync("fs.fstat", fd);
      expect(answer.ok).toBe(false);
      expect((answer.value as { code?: string }).code).toBe("EBADF");
    }
    // 0, 1 and 2 still read and write /dev/null when ignored or closed.
    expect(child.worker.sync("fs.fstat", 0).value).toMatchObject({ mode: 0o20666, uid: 0 });
    // The lowest free number is the first closed one above 2.
    expect(child.worker.sync("fs.open", `${h.cwd}/log.txt`, 0o101, 0o644).value).toBe(4);
  });

  it("wires a child's piped stdio to the parent and ends its stdout at exit", async () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("node", ["parent.js"], {});
    const parent = h.worker(parentPid);
    expect(parent.init.ttyFds).toEqual([0, 1, 2]);
    const child = spawnFrom(h, parent);
    expect(child.stdio).toHaveLength(3);
    expect(child.worker.init.ppid).toBe(parentPid);
    expect(child.worker.init.ttyFds).toEqual([]);
    expect(child.worker.init.inheritedFds).toEqual([]);

    // Parent → child stdin.
    const [stdinFd, stdoutFd] = child.stdio as number[];
    expect(parent.sync("fs.write", stdinFd, encoder.encode("ping"), null).value).toBe(4);
    const read = child.worker.sync("fs.read", 0, 100, null);
    expect(decoder.decode(read.value as Uint8Array)).toBe("ping");

    // Child stdout → parent, then end of stream once the child exits.
    child.worker.post("fd.write", 1, encoder.encode("pong"));
    parent.post("fd.readStart", stdoutFd);
    child.worker.post("proc.exit", 3);
    // The end follows once the parent says it received what came before.
    parent.post("fd.ack", stdoutFd, 4);
    const data = parent.messages("fd-data").filter((message) => message.fd === stdoutFd);
    expect(data.map((message) => (message.chunk ? decoder.decode(message.chunk) : null))).toEqual([
      "pong",
      null,
    ]);
    expect(child.worker.terminated).toBe(true);
    // Told after the answers the exit settled (see "reports EPIPE … before the exit").
    await Promise.resolve();
    expect(parent.messages("child-exit")).toEqual([
      { type: "child-exit", pid: child.pid, status: { code: 3, signal: null } },
    ]);
  });

  it("gives a new descriptor the lowest free number, 0 to 2 included", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const open = (path: string) => proc.sync("fs.open", path, 0o101, 0o666).value;
    expect(proc.sync("fs.close", 2).ok).toBe(true);
    expect(open(`${h.cwd}/a.txt`)).toBe(2);
    expect(open(`${h.cwd}/b.txt`)).toBe(3);
    expect(proc.sync("fs.close", 0).ok).toBe(true);
    expect(proc.sync("proc.pipe").value).toEqual({ readFd: 0, writeFd: 4 });
    expect(proc.sync("fs.close", 1).ok).toBe(true);
    expect(open("/dev/null")).toBe(1);
    const child = spawnFrom(h, proc, ["ignore", "pipe", "ignore"]);
    expect(child.stdio).toEqual([null, 5, null]);
  });

  it("reports a page process's exit and closes its listeners", () => {
    vi.useFakeTimers();
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["server.js"], {});
    const proc = h.worker(pid);
    const listened = proc.sync("net.listen", 3000).value as { port: number; listenerId: number };
    expect(listened.port).toBe(3000);
    // The page hears of the port once the listener has stayed a moment.
    expect(h.events).not.toContainEqual({ event: "port", port: 3000, type: "open" });
    vi.advanceTimersByTime(50);
    expect(h.events).toContainEqual({ event: "port", port: 3000, type: "open" });
    proc.post("proc.exit", 0);
    expect(h.events).toContainEqual({ event: "port", port: 3000, type: "close" });
    expect(h.events).toContainEqual({ event: "exit", pid, code: 0 });
    vi.useRealTimers();
  });

  it("does not announce a port that was only tried, as Vite tries its port before listening", () => {
    vi.useFakeTimers();
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["server.js"], {}));
    const ports = () => h.events.filter((event) => event.event === "port");
    for (let probe = 0; probe < 3; probe++) {
      const tried = proc.sync("net.listen", 4173).value as { listenerId: number };
      proc.post("net.close", tried.listenerId);
    }
    vi.advanceTimersByTime(200);
    // Nothing was said of the probes: neither that they opened nor that they closed.
    expect(ports()).toEqual([]);
    const real = proc.sync("net.listen", 4173).value as { listenerId: number };
    vi.advanceTimersByTime(49);
    expect(ports()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ports()).toEqual([{ event: "port", port: 4173, type: "open" }]);
    proc.post("net.close", real.listenerId);
    expect(ports()).toEqual([
      { event: "port", port: 4173, type: "open" },
      { event: "port", port: 4173, type: "close" },
    ]);
    vi.useRealTimers();
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

  it("ends a process on an unhandled signal and delivers a handled one", async () => {
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
    await Promise.resolve();
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

describe("pipe capacity", () => {
  const KIB64 = 65536;

  /** A parent with a child whose stdout is a pipe the parent reads (`stdoutFd`). */
  function piped(h: Harness) {
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const child = spawnFrom(h, parent);
    return { parent, child: child.worker, stdoutFd: child.stdio[1]!, stdinFd: child.stdio[0]! };
  }

  it("answers a blocking write to a full pipe once the reader has taken its bytes", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    const data = new Uint8Array(100_000).fill(5);
    expect(child.sync("fs.write", 1, data, null).pending).toBe(true);
    // The pipe took 64 KiB; a read makes room for the rest.
    const first = parent.sync("fs.read", stdoutFd, 1 << 20, null).value as Uint8Array;
    expect(first.byteLength).toBe(KIB64);
    expect(await child.settled()).toMatchObject({ ok: true, value: 100_000 });
    const rest = parent.sync("fs.read", stdoutFd, 1 << 20, null).value as Uint8Array;
    expect(rest.byteLength).toBe(100_000 - KIB64);
  });

  it("holds the writer until the reading process acknowledges what it was sent", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    parent.post("fd.readStart", stdoutFd);
    expect(child.sync("fs.write", 1, new Uint8Array(KIB64 + 1000), null).pending).toBe(true);
    const sent = parent.messages("fd-data");
    expect(sent.map((message) => [message.chunk?.byteLength, message.counted])).toEqual([
      [KIB64, true],
    ]);
    await settle();
    expect(child.answer().pending).toBe(true);
    parent.post("fd.ack", stdoutFd, 1000);
    expect(await child.settled()).toMatchObject({ ok: true, value: KIB64 + 1000 });
    // One delivery at a time: the rest waits in the pipe until the reader
    // has received all of the first, then goes as one message.
    expect(parent.messages("fd-data")).toHaveLength(1);
    parent.post("fd.ack", stdoutFd, KIB64 - 1000);
    expect(parent.messages("fd-data").at(-1)?.chunk?.byteLength).toBe(1000);
  });

  it("sends what was written while a delivery was on its way as one message, in order", () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    parent.post("fd.readStart", stdoutFd);
    for (const word of ["a", "b", "c", "d"]) {
      child.post("fd.write", 1, encoder.encode(word));
    }
    const chunks = () =>
      parent.messages("fd-data").map((message) => decoder.decode(message.chunk ?? undefined));
    expect(chunks()).toEqual(["a"]);
    parent.post("fd.ack", stdoutFd, 1);
    expect(chunks()).toEqual(["a", "bcd"]);
    parent.post("fd.ack", stdoutFd, 3);
    child.post("fd.write", 1, encoder.encode("e"));
    expect(chunks()).toEqual(["a", "bcd", "e"]);
  });

  it("leaves the writer waiting while the reader is stopped, as Linux does", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    parent.post("fd.readStart", stdoutFd);
    parent.post("fd.readStop", stdoutFd);
    expect(child.sync("fs.write", 1, new Uint8Array(2 * KIB64), null).pending).toBe(true);
    await settle();
    expect(child.answer().pending).toBe(true);
    // Reading again (and taking what arrives) lets it finish.
    parent.post("fd.readStart", stdoutFd);
    parent.post("fd.ack", stdoutFd, KIB64);
    expect(await child.settled()).toMatchObject({ ok: true, value: 2 * KIB64 });
  });

  it("puts what was on its way to a reader that closes its fd back, for the other reader", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const { readFd, writeFd } = parent.sync("proc.pipe").value as {
      readFd: number;
      writeFd: number;
    };
    // A child holding the read end too keeps the pipe open after the parent closes its fd.
    const child = spawnFrom(h, parent, [readFd, "pipe", "pipe"]).worker;
    parent.post("fd.readStart", readFd);
    const data = new Uint8Array(KIB64).map((_, index) => index & 0xff);
    expect(parent.sync("fs.write", writeFd, data, null).value).toBe(KIB64);
    expect(parent.messages("fd-data")).toHaveLength(1);
    parent.sync("fs.close", readFd);
    // The parent never received them, as if it had never read(2) them.
    expect(parent.sync("fs.write", writeFd, new Uint8Array(1), null).pending).toBe(true);
    expect(child.sync("fs.read", 0, 1 << 20, null).value).toEqual(data);
    expect(await parent.settled()).toMatchObject({ ok: true, value: 1 });
  });

  it("takes back what a reader did not use, ahead of what was on its way to it (fd.unread)", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const { readFd, writeFd } = parent.sync("proc.pipe").value as {
      readFd: number;
      writeFd: number;
    };
    const child = spawnFrom(h, parent, [readFd, "pipe", "pipe"]).worker;
    const bytes = (length: number, value: number) => new Uint8Array(length).fill(value);
    parent.post("fd.readStart", readFd);
    // Two deliveries: the parent receives the first, the second is still on its way.
    expect(parent.sync("fs.write", writeFd, bytes(40000, 1), null).value).toBe(40000);
    expect(parent.sync("fs.write", writeFd, bytes(20000, 2), null).value).toBe(20000);
    const sent = () => parent.messages("fd-data").map((message) => message.chunk?.byteLength);
    // The second goes once the first has arrived.
    expect(sent()).toEqual([40000]);
    parent.post("fd.ack", readFd, 40000);
    expect(sent()).toEqual([40000, 20000]);
    parent.post("fd.readStop", readFd);
    // It used 10 bytes of the first, and gives back the rest.
    parent.send({ type: "call", id: 1, op: "fd.unread", args: [readFd, [bytes(39990, 1)]] });
    expect(parent.messages("reply").find((reply) => reply.id === 1)).toMatchObject({ ok: true });
    expect(parent.sync("fs.write", writeFd, bytes(5, 3), null).value).toBe(5);
    parent.sync("fs.close", writeFd);
    // Each run of equal bytes read, as [value, length], however the reads divide them.
    const got: number[][] = [];
    for (;;) {
      const chunk = child.sync("fs.read", 0, 1 << 20, null).value as Uint8Array;
      if (chunk.byteLength === 0) {
        break;
      }
      for (const byte of chunk) {
        const last = got.at(-1);
        if (last && last[0] === byte) {
          last[1] += 1;
        } else {
          got.push([byte, 1]);
        }
      }
    }
    // In order: the given-back bytes, the ones that never arrived, the rest.
    expect(got).toEqual([
      [1, 39990],
      [2, 20000],
      [3, 5],
    ]);
  });

  it("answers a writer blocked when the reader goes with the bytes that went in, then EPIPE", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    child.post("proc.signals", ["SIGPIPE"]);
    expect(child.sync("fs.write", 1, new Uint8Array(KIB64 + 10), null).pending).toBe(true);
    parent.sync("fs.close", stdoutFd);
    expect(await child.settled()).toMatchObject({ ok: true, value: KIB64 });
    expect(child.messages("signal")).toEqual([{ type: "signal", signal: "SIGPIPE" }]);
    expect(child.sync("fs.write", 1, new Uint8Array(1), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
  });

  it("drops the rest of a blocked write when its process dies, and keeps what went in", () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    const pid = child.init.pid;
    expect(child.sync("fs.write", 1, new Uint8Array(3 * KIB64).fill(1), null).pending).toBe(true);
    parent.sync("proc.kill", pid, "SIGKILL");
    const first = parent.sync("fs.read", stdoutFd, 1 << 20, null).value as Uint8Array;
    expect(first.byteLength).toBe(KIB64);
    // Then the end: the dead writer's other 128 KiB never arrive.
    const end = parent.sync("fs.read", stdoutFd, 1 << 20, null).value as Uint8Array;
    expect(end.byteLength).toBe(0);
  });

  it("puts a queued write (with a completion) in after its process exits", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    child.send({ type: "call", id: 1, op: "fd.write", args: [1, new Uint8Array(KIB64 + 5)] });
    child.post("proc.exit", 0);
    let total = 0;
    for (;;) {
      const chunk = parent.sync("fs.read", stdoutFd, 1 << 20, null);
      const bytes = (chunk.pending ? (await parent.settled()).value : chunk.value) as Uint8Array;
      if (bytes.byteLength === 0) {
        break;
      }
      total += bytes.byteLength;
    }
    expect(total).toBe(KIB64 + 5);
  });

  it("tells every worker writing to a pipe, in its sync buffer, that the pipe lost its readers", () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    const thread = spawnThread(h, child);
    const broken = (worker: FakeWorker) =>
      Atomics.load(new Int32Array(worker.init.syncBuffer, 0, SYNC_HEADER_BYTES / 4), SYNC_BROKEN);
    expect([broken(child), broken(thread), broken(parent)]).toEqual([0, 0, 0]);
    parent.sync("fs.close", stdoutFd);
    // The child and its thread share the write end; the parent writes to none of it.
    expect([broken(child), broken(thread), broken(parent)]).toEqual([1, 1, 0]);
    // A bigger sync buffer carries the count on.
    const bigger = new SharedArrayBuffer(SYNC_HEADER_BYTES + (2 << 20));
    child.send({ type: "sync-buffer", buffer: bigger });
    expect(Atomics.load(new Int32Array(bigger, 0, SYNC_HEADER_BYTES / 4), SYNC_BROKEN)).toBe(1);
  });

  it("feeds spawnSync input and collects output larger than a pipe", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const input = new Uint8Array(200_000).map((_, index) => index & 0xff);
    const request = { command: "node", args: ["c.js"], cwd: h.cwd, env: h.env, input };
    expect(
      parent.sync("proc.spawnSync", { ...request, stdio: ["pipe", "pipe", "pipe"] }),
    ).toMatchObject({ pending: true });
    const child = h.last();
    // The child echoes its input back, reading and writing with blocking calls.
    for (;;) {
      const answer = child.sync("fs.read", 0, KIB64, null);
      const bytes = (answer.pending ? (await child.settled()).value : answer.value) as Uint8Array;
      if (bytes.byteLength === 0) {
        break;
      }
      const written = child.sync("fs.write", 1, bytes, null);
      expect(written.pending ? (await child.settled()).ok : written.ok).toBe(true);
    }
    child.post("proc.exit", 0);
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(result.status).toEqual({ code: 0, signal: null });
    expect(result.stdout).toEqual(input);
  });

  /** Reads `fd` with blocking reads to its end; the bytes read. */
  async function readToEnd(worker: FakeWorker, fd: number): Promise<number> {
    let total = 0;
    for (;;) {
      const answer = worker.sync("fs.read", fd, 1 << 20, null);
      const bytes = (answer.pending ? (await worker.settled()).value : answer.value) as Uint8Array;
      if (bytes.byteLength === 0) {
        return total;
      }
      total += bytes.byteLength;
    }
  }

  it("lets another reader have the rest once the first, a real process, stops reading", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const client = parent.attachClient();
    setRuntime(client.runtime);
    const stdio: ("pipe" | number)[] = ["pipe", "pipe", "pipe"];
    const request = { command: "node", args: ["w.js"], cwd: h.cwd, env: h.env, stdio };
    const stdoutFd = client.runtime.processes.spawn(request).stdio[1]!;
    const writer = h.last();
    expect(writer.sync("fs.write", 1, new Uint8Array(16 * KIB64), null).pending).toBe(true);
    // As a shell `read` does: one chunk, then stop. The next is already on its way.
    const first = await new Promise<number>((resolve) =>
      client.runtime.fdStream.readStart(stdoutFd, (chunk) => {
        client.runtime.fdStream.readStop(stdoutFd);
        resolve(chunk!.byteLength);
      }),
    );
    await settle();
    // Then `node count.js` reads the same pipe.
    const other = h.worker(client.runtime.processes.spawn({ ...request, stdio: [stdoutFd] }).pid);
    const reading = readToEnd(other, 0);
    expect(await writer.settled()).toMatchObject({ ok: true, value: 16 * KIB64 });
    writer.post("proc.exit", 0);
    const rest = await reading;
    // What the parent got stays its own, as bytes libuv read before a stop would.
    expect(first).toBe(KIB64);
    expect(rest).toBeGreaterThanOrEqual(14 * KIB64);
  });

  it("keeps a writer within the pipe and one chunk of a reader that takes a line and gives the rest back", async () => {
    // `writer | while read -r line; do sleep 0.05; program; done`: the shell
    // reads a chunk, stops, and gives back all but one line before each program.
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("sh", ["-c", "loop"], {}));
    const client = parent.attachClient();
    setRuntime(client.runtime);
    const stdio: ("pipe" | number)[] = ["pipe", "pipe", "pipe"];
    const request = { command: "node", args: ["w.js"], cwd: h.cwd, env: h.env, stdio };
    const stdoutFd = client.runtime.processes.spawn(request).stdio[1]!;
    const writer = h.last();
    const LINE = 1000;
    const ROUNDS = 160;
    /** Line `number`: its number, then padding. */
    const numbered = (number: number) => {
      const line = new Uint8Array(LINE);
      new DataView(line.buffer).setUint32(0, number);
      return line;
    };
    let issued = 0;
    let waiting = false;
    /** The writer writes line after line, until one waits for room. */
    const feed = () => {
      for (;;) {
        if (waiting) {
          if (writer.answer().pending) {
            return;
          }
          waiting = false;
        }
        waiting = writer.sync("fs.write", 1, numbered(issued), null).pending;
        issued += 1;
        if (waiting) {
          return;
        }
      }
    };
    /** The bytes the pipe took from the writer. */
    const accepted = () => (issued - (waiting ? 1 : 0)) * LINE;
    const read: number[] = [];
    const ahead: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      feed();
      const chunk = await new Promise<Uint8Array>((resolve) =>
        client.runtime.fdStream.readStart(stdoutFd, (bytes) => {
          client.runtime.fdStream.readStop(stdoutFd);
          resolve(bytes!);
        }),
      );
      read.push(new DataView(chunk.buffer, chunk.byteOffset).getUint32(0));
      // The loop's body takes a while: whatever the kernel had sent arrives meanwhile.
      for (let turn = 0; turn < 4; turn += 1) {
        await tick();
        feed();
      }
      client.runtime.fdStream.unread(stdoutFd, chunk.subarray(LINE));
      await settle();
      feed();
      ahead.push(accepted() - read.length * LINE);
    }
    // Each line once, in order: what was given back is what the next read starts with.
    expect(read).toEqual(Array.from({ length: ROUNDS }, (_, index) => index));
    // However many lines were read, the writer is ahead by what the pipe
    // holds and the chunk the reader was handed, and no more.
    expect(Math.max(...ahead)).toBeLessThanOrEqual(2 * KIB64);
    // It gets no further ahead with the lines read: this many more than drain a chunk.
    expect(Math.max(...ahead.slice(-ROUNDS / 2))).toBeLessThanOrEqual(
      Math.max(...ahead.slice(0, 2)),
    );
  });

  it("puts what never reached a reader that ended back in the pipe, for the next", () => {
    const h = boot();
    const { parent, child: writer, stdoutFd } = piped(h);
    const first = spawnFrom(h, parent, [stdoutFd, "pipe", "pipe"]).worker;
    const second = spawnFrom(h, parent, [stdoutFd, "pipe", "pipe"]).worker;
    const data = new Uint8Array(1000).map((_, index) => index & 0xff);
    expect(writer.sync("fs.write", 1, data, null).value).toBe(1000);
    first.post("fd.readStart", 0);
    expect(first.messages("fd-data")).toHaveLength(1);
    // It ends before the message reaches it.
    first.post("proc.exit", 0);
    expect(second.sync("fs.read", 0, 1 << 20, null).value).toEqual(data);
  });

  it("frees what a worker was sent while it waits in a blocking call, for another reader", async () => {
    const h = boot();
    const { parent, child: writer, stdoutFd } = piped(h);
    const other = spawnFrom(h, parent, [stdoutFd, "pipe", "pipe"]).worker;
    parent.post("fd.readStart", stdoutFd);
    expect(writer.sync("fs.write", 1, new Uint8Array(3 * KIB64), null).pending).toBe(true);
    expect(parent.messages("fd-data")).toHaveLength(1);
    // The parent waits in spawnSync (here: a read of an empty pipe) before it took its chunk.
    const empty = parent.sync("proc.pipe").value as { readFd: number };
    expect(parent.sync("fs.read", empty.readFd, 10, null).pending).toBe(true);
    // The chunk is the parent's now; the other reader gets the rest, and the writer finishes.
    const reading = readToEnd(other, 0);
    expect(await writer.settled()).toMatchObject({ ok: true, value: 3 * KIB64 });
    writer.post("proc.exit", 0);
    expect(await reading).toBe(2 * KIB64);
    // Nothing more was sent to the waiting parent.
    expect(parent.messages("fd-data").filter((message) => message.chunk)).toHaveLength(1);
  });

  it("stops every stream of a worker that waits before it frees what the worker was sent", async () => {
    const h = boot();
    const { parent, child: writer, stdoutFd } = piped(h);
    const other = spawnFrom(h, parent, [stdoutFd, "pipe", "pipe"]).worker;
    // The parent streams the pipe through two descriptors.
    const second = parent.sync("fs.open", `/dev/fd/${stdoutFd}`, 0, 0).value as number;
    parent.post("fd.readStart", stdoutFd);
    parent.post("fd.readStart", second);
    expect(writer.sync("fs.write", 1, new Uint8Array(3 * KIB64), null).pending).toBe(true);
    expect(parent.messages("fd-data")).toHaveLength(1);
    // The parent waits: the chunk on its way is its own, and its room is the
    // writer's. What goes in then must not be sent to the parent's other stream.
    const empty = parent.sync("proc.pipe").value as { readFd: number };
    expect(parent.sync("fs.read", empty.readFd, 10, null).pending).toBe(true);
    expect(parent.messages("fd-data")).toHaveLength(1);
    const reading = readToEnd(other, 0);
    expect(await writer.settled()).toMatchObject({ ok: true, value: 3 * KIB64 });
    writer.post("proc.exit", 0);
    expect(await reading).toBe(2 * KIB64);
    expect(parent.messages("fd-data").filter((message) => message.chunk)).toHaveLength(1);
  });

  it("sends a worker that waits in a blocking call nothing, and streams to it again once it is answered", async () => {
    const h = boot();
    const { parent, child: writer, stdoutFd } = piped(h);
    const bytes = (length: number, value: number) => new Uint8Array(length).fill(value);
    // The parent's stream is flowing, with nothing on its way, when it runs spawnSync.
    parent.post("fd.readStart", stdoutFd);
    const request = { command: "node", args: ["take.js"], cwd: h.cwd, env: h.env };
    expect(
      parent.sync("proc.spawnSync", { ...request, stdio: [stdoutFd, "pipe", "pipe"] }).pending,
    ).toBe(true);
    const child = h.last();
    // What is written now is for the child, which reads the same pipe: the
    // parent cannot take a message until it is answered.
    expect(writer.sync("fs.write", 1, bytes(1000, 1), null).value).toBe(1000);
    expect(parent.messages("fd-data")).toEqual([]);
    expect(child.sync("fs.read", 0, 1 << 20, null).value).toEqual(bytes(1000, 1));
    expect(writer.sync("fs.write", 1, bytes(500, 2), null).value).toBe(500);
    await settle();
    expect(parent.messages("fd-data")).toEqual([]);
    // The child ends, the parent is answered, and its stream goes on with what the child left.
    child.post("proc.exit", 0);
    expect((await parent.settled()).ok).toBe(true);
    expect(parent.messages("fd-data").map((message) => message.chunk)).toEqual([bytes(500, 2)]);
    // And with what comes after.
    parent.post("fd.ack", stdoutFd, 500);
    expect(writer.sync("fs.write", 1, bytes(300, 3), null).value).toBe(300);
    expect(parent.messages("fd-data").map((message) => message.chunk?.byteLength)).toEqual([
      500, 300,
    ]);
  });

  it("answers a blocking read of a pipe the worker also streams, and resumes the stream after", async () => {
    const h = boot();
    const { parent, child: writer, stdoutFd } = piped(h);
    parent.post("fd.readStart", stdoutFd);
    const data = new Uint8Array(3 * KIB64).map((_, index) => (index >> 16) + 1);
    expect(writer.sync("fs.write", 1, data, null).pending).toBe(true);
    expect(parent.messages("fd-data")).toHaveLength(1);
    // readFileSync(0) after a 'data' event: the pump had taken all there was.
    const read = parent.sync("fs.read", stdoutFd, 1 << 20, null);
    const bytes = (read.pending ? (await parent.settled()).value : read.value) as Uint8Array;
    expect(bytes.byteLength).toBe(KIB64);
    expect(bytes[0]).toBe(2);
    // The stream goes on once the parent has received the chunk it was sent.
    expect(parent.messages("fd-data")).toHaveLength(1);
    parent.post("fd.ack", stdoutFd, KIB64);
    const sent = parent.messages("fd-data");
    expect(sent.map((message) => message.chunk?.[0])).toEqual([1, 3]);
    expect(await writer.settled()).toMatchObject({ ok: true, value: 3 * KIB64 });
  });

  it("lets go of a device a killed writer was waiting on, so its reader gets the end", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    const write = child.sync(
      "fs.writeFile",
      "/dev/stdout",
      new Uint8Array(3 * KIB64),
      0o1101,
      0o644,
    );
    expect(write.pending).toBe(true);
    parent.sync("proc.kill", child.init.pid, "SIGKILL");
    // The given-up write settles, and with it the device's reference goes.
    await settle();
    expect((parent.sync("fs.read", stdoutFd, 1 << 20, null).value as Uint8Array).byteLength).toBe(
      KIB64,
    );
    const end = parent.sync("fs.read", stdoutFd, 1 << 20, null);
    expect(end.pending).toBe(false);
    expect((end.value as Uint8Array).byteLength).toBe(0);
  });

  it("lets go of a device a killed reader was waiting on, so its writer gets EPIPE", async () => {
    const h = boot();
    const { parent, child, stdinFd } = piped(h);
    parent.post("proc.signals", ["SIGPIPE"]);
    expect(child.sync("fs.readFile", "/dev/stdin").pending).toBe(true);
    parent.sync("proc.kill", child.init.pid, "SIGKILL");
    await settle();
    expect(parent.sync("fs.write", stdinFd, new Uint8Array(1), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
  });

  it("fails writeFile to a pipe whose reader goes part of the way through with EPIPE", async () => {
    const h = boot();
    const { parent, child, stdoutFd } = piped(h);
    child.post("proc.signals", ["SIGPIPE"]);
    const data = new Uint8Array(KIB64 + 10);
    expect(child.sync("fs.writeFile", "/dev/stdout", data, 0o1101, 0o644).pending).toBe(true);
    parent.sync("fs.close", stdoutFd);
    expect(await child.settled()).toMatchObject({ ok: false, value: { code: "EPIPE" } });
  });

  it("reports EPIPE for spawnSync input the child left, and keeps its status and output", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const run = (input: Uint8Array) =>
      parent.sync("proc.spawnSync", {
        command: "node",
        args: ["c.js"],
        cwd: h.cwd,
        env: h.env,
        stdio: ["pipe", "pipe", "pipe"],
        input,
      });
    expect(run(new Uint8Array(200_000)).pending).toBe(true);
    let child = h.last();
    expect((child.sync("fs.read", 0, 10, null).value as Uint8Array).byteLength).toBe(10);
    child.post("fd.write", 1, encoder.encode("out"));
    child.post("proc.exit", 0);
    const broken = (await parent.settled()).value as SpawnSyncResult;
    expect(broken.status).toEqual({ code: 0, signal: null });
    expect(decoder.decode(broken.stdout)).toBe("out");
    expect(broken.error).toMatchObject({ code: "EPIPE" });
    // Input that fits the pipe is all in, read or not.
    expect(run(new Uint8Array(1000)).pending).toBe(true);
    child = h.last();
    child.post("proc.exit", 0);
    expect(((await parent.settled()).value as SpawnSyncResult).error).toBeUndefined();
  });

  it("reports EPIPE for a write to a child's stdin before the child's exit", async () => {
    const h = boot();
    const { parent, child, stdinFd } = piped(h);
    parent.post("proc.signals", ["SIGPIPE"]);
    parent.send({
      type: "call",
      id: 9,
      op: "fd.write",
      args: [stdinFd, new Uint8Array(KIB64 + 10)],
    });
    child.post("proc.exit", 0);
    await settle();
    const heard = parent.inbox
      .filter(
        (message) =>
          (message.type === "reply" && message.id === 9) || message.type === "child-exit",
      )
      .map((message) =>
        message.type === "reply" ? `reply ${message.ok ? "ok" : message.error.code}` : message.type,
      );
    expect(heard).toEqual(["reply EPIPE", "child-exit"]);
  });
});

describe("worker threads", () => {
  it("hands the ports inside a thread's workerData on to the thread", () => {
    const h = boot();
    const main = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const control = new MessageChannel();
    const first = new MessageChannel();
    const second = new MessageChannel();
    openPorts.push(control.port1, control.port2, first.port1, first.port2, second.port1);
    openPorts.push(second.port2);
    const workerData = { ports: [first.port2, second.port2] };
    main.send({ type: "post", op: "handoff", args: ["thread:9", workerData] }, [
      control.port2,
      first.port2,
      second.port2,
    ]);
    const answer = main.sync(
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
      "thread:9",
    );
    expect(answer.ok).toBe(true);
    const thread = h.last();
    expect(thread.init.thread?.workerData).toBe(workerData);
    expect(thread.init.thread?.port).toBe(control.port2);
    // A port can only be sent on in a message that transfers it.
    expect(thread.transfers[thread.inbox.indexOf(thread.init)]).toEqual([
      control.port2,
      first.port2,
      second.port2,
    ]);
  });

  it("frees a thread's listeners and pumps when its process ends", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    const thread = spawnThread(h, main);
    const { port } = thread.sync("net.listen", 5000).value as { port: number };
    expect(port).toBe(5000);
    // Long enough for the page to have been told of the port.
    await announced();
    thread.post("fd.readStart", 0);
    main.post("proc.exit", 0);
    expect(thread.terminated).toBe(true);
    expect(h.events).toContainEqual({ event: "port", port: 5000, type: "close" });
    await expect(h.kernel.connect(5000)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    // The thread's stdin pump is gone: typed input does not reach a dead worker.
    h.kernel.writeInput(pid, "x\n");
    expect(thread.messages("fd-data")).toEqual([]);
  });

  it("puts what a pipe sent a thread that ends back in the pipe, for the process's next reader", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const child = spawnFrom(h, parent);
    const thread = spawnThread(h, parent);
    const data = new Uint8Array(1000).map((_, index) => index & 0xff);
    // The thread streams the child's stdout; a chunk is on its way to it when it ends.
    thread.post("fd.readStart", child.stdio[1]!);
    expect(child.worker.sync("fs.write", 1, data, null).value).toBe(1000);
    expect(thread.messages("fd-data").map((message) => message.chunk?.byteLength)).toEqual([1000]);
    parent.post("thread.terminate", thread.init.thread!.threadId);
    expect(thread.terminated).toBe(true);
    // The process keeps the fd: the bytes the thread never received are still to read,
    // and count against the pipe as before.
    expect(parent.sync("fs.read", child.stdio[1]!, 1 << 20, null).value).toEqual(data);
    expect(child.worker.sync("fs.write", 1, new Uint8Array(65536), null).value).toBe(65536);
  });

  it("stops a thread's stream of a descriptor its process closes", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const child = spawnFrom(h, parent);
    const fd = child.stdio[1]!;
    // Another process holds the read end too, so the pipe outlives the close.
    const other = spawnFrom(h, parent, [fd, "pipe", "pipe"]).worker;
    const thread = spawnThread(h, parent);
    const data = new Uint8Array(1000).map((_, index) => index & 0xff);
    thread.post("fd.readStart", fd);
    expect(child.worker.sync("fs.write", 1, data, null).value).toBe(1000);
    expect(thread.messages("fd-data")).toHaveLength(1);
    // The descriptors are the process's: once the main thread closes this
    // one, the thread reads it no more, and what was on its way goes back.
    parent.sync("fs.close", fd);
    expect(child.worker.sync("fs.write", 1, data, null).value).toBe(1000);
    expect(thread.messages("fd-data")).toHaveLength(1);
    // Both writes are in the pipe, the first one back in front.
    expect(other.sync("fs.read", 0, 1 << 20, null).value).toEqual(
      new Uint8Array([...data, ...data]),
    );
    expect(other.sync("fs.read", 0, 1 << 20, null).pending).toBe(true);
  });

  it("leaves a number a thread took alone when the process that closed it marks the close", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const thread = spawnThread(h, parent);
    const client = parent.attachClient();
    const { readFd } = client.runtime.processes.pipe();
    client.runtime.fdStream.readStart(readFd, () => {});
    // The thread opens a pipe between the main thread's close and what the
    // main thread sends next: it gets the number just freed.
    const send = parent.send.bind(parent);
    let reused: number | null = null;
    parent.send = (message, ports) => {
      if (message.type === "call" && reused === null) {
        reused = (thread.sync("proc.pipe").value as { readFd: number }).readFd;
      }
      send(message, ports);
    };
    client.runtime.fs.close(readFd);
    expect(reused).toBe(readFd);
    expect(thread.sync("fs.fstat", readFd).ok).toBe(true);
  });

  it("keeps the main thread's handled signals when a thread publishes its own", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    main.post("proc.signals", ["SIGINT"]);
    const thread = spawnThread(h, main);
    thread.post("proc.signals", []);
    h.kernel.writeInput(pid, "\x03");
    expect(main.messages("signal")).toEqual([
      { type: "signal", signal: "SIGINT", fromTerminal: true },
    ]);
    expect(main.terminated).toBe(false);
  });

  it("reports a child's exit to the thread that spawned it", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    const thread = spawnThread(h, main);
    const child = spawnFrom(h, thread);
    expect(child.worker.init.ppid).toBe(pid);
    child.worker.post("proc.exit", 7);
    await Promise.resolve();
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
    expect(main.messages("signal")).toEqual([
      { type: "signal", signal: "SIGINT", fromTerminal: true },
    ]);
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
  it("ends a writer that does not handle SIGPIPE", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    const child = spawnFrom(h, parent);
    parent.post("fd.close", child.stdio[1]);
    const answer = child.worker.sync("fs.write", 1, encoder.encode("x"), null);
    expect(answer.pending).toBe(true);
    expect(child.worker.terminated).toBe(true);
    await Promise.resolve();
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

  it("lets a write of no bytes succeed on a pipe nobody reads, as Linux does", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent, ["pipe", "pipe", "pipe"]);
    child.worker.post("proc.signals", ["SIGPIPE"]);
    parent.sync("fs.close", child.stdio[1]!);
    // write(2) of no bytes returns 0 before it looks for a reader.
    expect(child.worker.sync("fs.write", 1, new Uint8Array(0), null)).toMatchObject({
      ok: true,
      value: 0,
    });
    child.worker.send({ type: "call", id: 1, op: "fd.write", args: [1, new Uint8Array(0)] });
    expect(child.worker.messages("reply")).toMatchObject([{ id: 1, ok: true, value: 0 }]);
    expect(child.worker.messages("signal")).toEqual([]);
    expect(child.worker.sync("fs.write", 1, encoder.encode("x"), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
    expect(child.worker.messages("signal")).toEqual([{ type: "signal", signal: "SIGPIPE" }]);
  });

  it("ends a worker that crashed with code 1 even when its stderr is a pipe nobody reads", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent, ["pipe", "pipe", "pipe"]);
    parent.sync("fs.close", child.stdio[2]!);
    // The kernel writes the crash's message for the process: no write of the
    // process's own, so no SIGPIPE, whose default action would be its status.
    child.worker.onerror?.({ message: "Uncaught Error: boom" } as ErrorEvent);
    await settle();
    expect(child.worker.terminated).toBe(true);
    expect(parent.messages("child-exit")).toEqual([
      { type: "child-exit", pid: child.pid, status: { code: 1, signal: null } },
    ]);
  });

  it("fails a write that waited in the pipe when its reader goes, without a signal", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["a.js"], {});
    const parent = h.worker(pid);
    const child = spawnFrom(h, parent, ["pipe", "pipe", "pipe"]);
    child.worker.post("proc.signals", ["SIGPIPE"]);
    const broken = () =>
      Atomics.load(
        new Int32Array(child.worker.init.syncBuffer, 0, SYNC_HEADER_BYTES / 4),
        SYNC_BROKEN,
      );
    // Handed over (a write with a completion), and too large to go in at once.
    child.worker.send({
      type: "call",
      id: 1,
      op: "fd.write",
      args: [1, new Uint8Array(100_000)],
    });
    await settle();
    expect(child.worker.messages("reply")).toEqual([]);
    parent.sync("fs.close", child.stdio[1]!);
    await settle();
    // The bytes were as good as in the pipe, and bytes a reader leaves there
    // go without SIGPIPE: the write's completion says EPIPE, and that is all.
    expect(child.worker.messages("reply")).toMatchObject([
      { id: 1, ok: false, error: { code: "EPIPE" } },
    ]);
    expect(child.worker.messages("signal")).toEqual([]);
    expect(child.worker.terminated).toBe(false);
    // The writer is told its pipe broke: once for the reader that went, once for the write.
    expect(broken()).toBe(2);
    // Only a write after the reader has gone gets the signal.
    expect(child.worker.sync("fs.write", 1, encoder.encode("x"), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
    expect(child.worker.messages("signal")).toEqual([{ type: "signal", signal: "SIGPIPE" }]);
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
  it("kills a child that overruns maxBuffer, keeps the read that crossed it whole and reports ENOBUFS", async () => {
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
    expect(decoder.decode(result.stdout)).toBe("0123456789abcdef");
    expect(result.status).toEqual({ code: null, signal: "SIGTERM" });
    // spawnSync collects the exit itself: no child-exit for nobody to hear.
    expect(parent.messages("child-exit")).toEqual([]);
  });

  it("stops at the first write that takes the total over maxBuffer", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "node",
      args: ["small.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10,
    });
    const child = h.last();
    for (let index = 0; index < 6; index += 1) {
      child.post("fd.write", 1, encoder.encode("ab"));
    }
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(result.error).toBe("ENOBUFS");
    expect(decoder.decode(result.stdout)).toBe("abababababab");
    expect(result.status).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("waits for the captured pipes to end when a descendant still holds them", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "sh",
      args: ["-c", "(sleep 1; echo late) & echo early"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = h.last();
    const grandchild = spawnFrom(h, child, ["inherit", "inherit", "inherit"]);
    child.post("fd.write", 1, encoder.encode("early\n"));
    child.post("proc.exit", 0);
    await settle();
    expect(parent.answer().pending).toBe(true);
    grandchild.worker.post("fd.write", 1, encoder.encode("late\n"));
    grandchild.worker.post("fd.write", 2, encoder.encode("oops\n"));
    grandchild.worker.post("proc.exit", 0);
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(result.error).toBeUndefined();
    expect(decoder.decode(result.stdout)).toBe("early\nlate\n");
    expect(decoder.decode(result.stderr)).toBe("oops\n");
    expect(result.status).toEqual({ code: 0, signal: null });
  });

  it("ends at the timeout with what was captured, keeping the status of a child that had exited", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "sh",
      args: ["-c", "(sleep 1; echo late) & echo early"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 30,
    });
    const child = h.last();
    const grandchild = spawnFrom(h, child, ["inherit", "inherit", "inherit"]);
    child.post("fd.write", 1, encoder.encode("early\n"));
    child.post("proc.exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const answer = parent.answer();
    expect(answer.pending).toBe(false);
    const result = answer.value as SpawnSyncResult;
    expect(result.error).toBe("ETIMEDOUT");
    expect(decoder.decode(result.stdout)).toBe("early\n");
    expect(result.status).toEqual({ code: 0, signal: null });
    // The kernel let go of the pipe: what the descendant still writes is a broken pipe.
    grandchild.worker.post("proc.signals", ["SIGPIPE"]);
    expect(grandchild.worker.sync("fs.write", 1, encoder.encode("late\n"), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
  });

  it("tells a writer that had written by post that the pipes are let go at the timeout", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "sh",
      args: ["-c", "(sleep 1; echo late) & echo early"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 30,
    });
    const child = h.last();
    const broken = () =>
      Atomics.load(new Int32Array(child.init.syncBuffer, 0, SYNC_HEADER_BYTES / 4), SYNC_BROKEN);
    child.post("fd.write", 1, encoder.encode("early\n"));
    child.sync("proc.forkAndExit", { code: 0, signal: null });
    expect(broken()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((parent.answer().value as SpawnSyncResult).error).toBe("ETIMEDOUT");
    // Its next write asks the kernel, which fails it, as for any pipe whose
    // reader closed: one count for stdout, one for stderr.
    expect(broken()).toBe(2);
    child.post("proc.signals", ["SIGPIPE"]);
    expect(child.sync("fs.write", 1, encoder.encode("late\n"), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
  });

  it("sends the kill signal to the child alone at the timeout and waits for its end", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "sh",
      args: ["-c", 'trap "exit 7" TERM; (sleep 1) & sleep 5'],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 30,
      killSignal: "SIGTERM",
    });
    const child = h.last();
    child.post("proc.signals", ["SIGTERM"]);
    const job = spawnFrom(h, child, ["ignore", "inherit", "inherit"]);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The child's handler has the signal; nothing ended; the call still waits.
    expect(child.messages("signal")).toEqual([{ type: "signal", signal: "SIGTERM" }]);
    expect([child.terminated, job.worker.terminated]).toEqual([false, false]);
    expect(parent.answer().pending).toBe(true);
    // What the child started still writes; the pipe is no longer read.
    job.worker.post("proc.signals", ["SIGPIPE"]);
    expect(job.worker.sync("fs.write", 1, encoder.encode("x"), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
    // The trap ends the child with its own status, which the call reports.
    child.post("proc.exit", 7);
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(result.error).toBe("ETIMEDOUT");
    expect(result.status).toEqual({ code: 7, signal: null });
    expect(job.worker.terminated).toBe(false);
  });

  it("ends a child that does not handle the kill signal with that signal", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "node",
      args: ["slow.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 30,
      killSignal: "SIGINT",
    });
    const child = h.last();
    const grandchild = spawnFrom(h, child, ["ignore", "ignore", "ignore"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = parent.answer().value as SpawnSyncResult;
    expect(result.error).toBe("ETIMEDOUT");
    expect(result.status).toEqual({ code: null, signal: "SIGINT" });
    expect([child.terminated, grandchild.worker.terminated]).toEqual([true, false]);
  });

  it("closes the captured pipes when the caller ends while it waits", () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("node", ["p.js"], {});
    const parent = h.worker(parentPid);
    parent.sync("proc.spawnSync", {
      command: "node",
      args: ["leaver.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = h.last();
    const grandchild = spawnFrom(h, child, ["inherit", "inherit", "inherit"]);
    child.post("proc.exit", 0);
    const other = h.worker(h.kernel.spawnFromPage("node", ["k.js"], {}));
    expect(other.sync("proc.kill", parentPid, "SIGTERM").ok).toBe(true);
    expect(parent.terminated).toBe(true);
    grandchild.worker.post("proc.signals", ["SIGPIPE"]);
    expect(grandchild.worker.sync("fs.write", 1, encoder.encode("late\n"), null)).toMatchObject({
      ok: false,
      value: { code: "EPIPE" },
    });
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
    // Two connections a turn: once past the 16,384 ports of the range.
    for (let index = 0; index < 8200; index += 1) {
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
    expect(shell.messages("signal")).toEqual([
      { type: "signal", signal: "SIGINT", fromTerminal: true },
    ]);
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

describe("what a finished foreground job leaves running (job control)", () => {
  /** jsh, a foreground job it ran (`node par.js`), and the server that job started. */
  function orphaned(serverStdio: unknown[]) {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("proc.signals", ["SIGINT"]);
    const job = spawnFrom(h, shell, [0, 1, 2]);
    const server = spawnFrom(h, job.worker, serverStdio);
    // The job's process is killed; its server runs on, an orphan.
    shell.sync("proc.kill", job.pid, "SIGKILL");
    return { h, shellPid, shell, job, server };
  }

  it("keeps a Ctrl+C typed for a later command from the orphan, as on Linux", () => {
    for (const stdio of [
      ["inherit", "inherit", "inherit"],
      ["pipe", "inherit", "inherit"],
    ]) {
      const { h, shellPid, shell, job, server } = orphaned(stdio);
      // The shell takes the terminal back for its own group.
      shell.post("tty.reclaim", 0);
      const next = spawnFrom(h, shell, [0, 1, 2]);
      h.kernel.writeInput(shellPid, "\x03");
      expect(next.worker.terminated).toBe(true);
      expect(server.worker.terminated).toBe(false);
      expect(shell.messages("signal")).toEqual([
        { type: "signal", signal: "SIGINT", fromTerminal: true },
      ]);
      // It stays in its job's group, as on Linux: that group still reaches it.
      expect(shell.sync("proc.kill", -job.pid, "SIGTERM").ok).toBe(true);
      expect(server.worker.terminated).toBe(true);
    }
  });

  it("no longer gives the orphan what is typed", () => {
    const { h, shellPid, shell, server } = orphaned(["inherit", "inherit", "inherit"]);
    shell.post("tty.reclaim", 0);
    server.worker.post("fd.readStart", 0);
    shell.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "ls\r");
    expect(shell.messages("fd-data")).toHaveLength(1);
    expect(server.worker.messages("fd-data")).toEqual([]);
  });

  it("moves only what the reclaiming shell's own jobs left, not its parent", () => {
    // jsh runs an interactive jsh, whose job leaves an orphan.
    const h = boot();
    const outerPid = h.kernel.spawnFromPage("jsh", [], {});
    const outer = h.worker(outerPid);
    outer.post("proc.signals", ["SIGINT"]);
    const inner = spawnFrom(h, outer, [0, 1, 2]);
    inner.worker.post("proc.signals", ["SIGINT"]);
    const job = spawnFrom(h, inner.worker, [0, 1, 2]);
    const server = spawnFrom(h, job.worker, ["ignore", "inherit", "inherit"]);
    inner.worker.sync("proc.kill", job.pid, "SIGKILL");
    inner.worker.post("tty.reclaim", 0);
    h.kernel.writeInput(outerPid, "\x03");
    expect(server.worker.terminated).toBe(false);
    // The shells are still the terminal's foreground: both get the Ctrl+C.
    expect(outer.messages("signal")).toEqual([
      { type: "signal", signal: "SIGINT", fromTerminal: true },
    ]);
    expect(inner.worker.messages("signal")).toEqual([
      { type: "signal", signal: "SIGINT", fromTerminal: true },
    ]);
  });

  it("leaves a background job where it is, and does nothing for a shell in the background", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("proc.signals", ["SIGINT"]);
    const background = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    const backgroundChild = spawnFrom(h, background.worker, ["ignore", "ignore", "ignore"]);
    shell.post("tty.reclaim", 0);
    // `jsh &`: a shell in a group of its own reclaims nothing, and keeps nothing from the shell.
    background.worker.post("tty.reclaim", 0);
    const next = spawnFrom(h, shell, [0, 1, 2]);
    next.worker.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "a\r");
    expect(next.worker.messages("fd-data")).toHaveLength(1);
    expect(shell.sync("proc.kill", -background.pid, "SIGTERM").ok).toBe(true);
    expect(backgroundChild.worker.terminated).toBe(true);
  });

  it("keeps what the programs of one pipeline left running in one group, the job's", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    // `node a.js | node b.js`: each program starts a server and is then killed.
    const first = spawnFrom(h, shell, [0, "pipe", 2]);
    const second = spawnFrom(h, shell, ["pipe", 1, 2]);
    const firstServer = spawnFrom(h, first.worker, ["ignore", "inherit", "inherit"]);
    const secondServer = spawnFrom(h, second.worker, ["ignore", "inherit", "inherit"]);
    shell.sync("proc.kill", first.pid, "SIGKILL");
    shell.sync("proc.kill", second.pid, "SIGKILL");
    shell.post("tty.reclaim", 0);
    // The group is numbered by the job's first process, as a shell with job control numbers it.
    expect(shell.sync("proc.kill", -second.pid, "SIGTERM").ok).toBe(false);
    expect(shell.sync("proc.kill", -first.pid, "SIGTERM").ok).toBe(true);
    expect(firstServer.worker.terminated).toBe(true);
    expect(secondServer.worker.terminated).toBe(true);
    // The next job has a group of its own.
    const next = spawnFrom(h, shell, [0, 1, 2]);
    const nextServer = spawnFrom(h, next.worker, ["ignore", "inherit", "inherit"]);
    shell.sync("proc.kill", next.pid, "SIGKILL");
    shell.post("tty.reclaim", 0);
    expect(shell.sync("proc.kill", -next.pid, "SIGTERM").ok).toBe(true);
    expect(nextServer.worker.terminated).toBe(true);
  });
});

/** What `worker`'s stream on `fd` was sent so far, as text. */
function streamed(worker: FakeWorker, fd = 0): string {
  return worker
    .messages("fd-data")
    .filter((message) => message.fd === fd)
    .map((message) => (message.chunk ? decoder.decode(message.chunk) : "<end>"))
    .join("");
}

describe("who reads the terminal", () => {
  const inherit = ["inherit", "inherit", "inherit"];

  /** jsh running a program in the foreground. */
  function running() {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    const program = spawnFrom(h, shell, [0, 1, 2]);
    return { h, shellPid, shell, program };
  }

  it("leaves the terminal to a process started beside one that ends", () => {
    const { h, shellPid, shell, program } = running();
    // The program starts two children on the terminal; the first ends first.
    const first = spawnFrom(h, program.worker, inherit);
    const second = spawnFrom(h, program.worker, inherit);
    second.worker.post("fd.readStart", 0);
    first.worker.post("proc.exit", 0);
    h.kernel.writeInput(shellPid, "hello\r");
    expect(streamed(second.worker)).toBe("hello\n");
    // The other order: a helper started after the reader comes and goes.
    const helper = spawnFrom(h, program.worker, inherit);
    helper.worker.post("proc.exit", 0);
    h.kernel.writeInput(shellPid, "again\r");
    expect(streamed(second.worker)).toBe("hello\nagain\n");
    shell.post("fd.readStart", 0);
    expect(streamed(shell)).toBe("");
  });

  it("takes the terminal from what an ended process started, with no shell taking it back", async () => {
    const { h, shellPid, shell, program } = running();
    const child = spawnFrom(h, program.worker, inherit);
    child.worker.post("fd.readStart", 0);
    shell.sync("proc.kill", program.pid, "SIGKILL");
    // The shell (one without job control: no `tty.reclaim`) reads on after its program.
    shell.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "ls\r");
    expect(streamed(shell)).toBe("ls\n");
    expect(streamed(child.worker)).toBe("");
    // Neither what it starts next nor a new read of its own brings it back.
    const grandchild = spawnFrom(h, child.worker, inherit);
    grandchild.worker.post("fd.readStart", 0);
    expect(child.worker.sync("fs.read", 0, 100, null).pending).toBe(true);
    h.kernel.writeInput(shellPid, "pwd\r");
    await settle();
    expect(streamed(shell)).toBe("ls\npwd\n");
    expect(child.worker.answer().pending).toBe(true);
    expect(streamed(grandchild.worker)).toBe("");
    // The terminal's Ctrl+C still reaches it: it stayed in the group.
    shell.post("proc.signals", ["SIGINT"]);
    h.kernel.writeInput(shellPid, "\x03");
    expect(child.worker.terminated).toBe(true);
  });

  it("gives what is typed while a process waits in spawnSync to the child, not to the waiting process", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["p.js"], {});
    const parent = h.worker(pid);
    // The parent listens on its stdin, the terminal, and then waits for a child.
    parent.post("fd.readStart", 0);
    const waiting = parent.sync("proc.spawnSync", {
      command: "node",
      args: ["c.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: inherit,
    });
    expect(waiting.pending).toBe(true);
    const child = h.last();
    // A line is typed before the child gets to its read.
    h.kernel.writeInput(pid, "hello\r");
    expect(streamed(parent)).toBe("");
    const read = child.sync("fs.read", 0, 100, null);
    expect(decoder.decode(read.value as Uint8Array)).toBe("hello\n");
    // What the child leaves is the parent's once it is answered.
    h.kernel.writeInput(pid, "later\r");
    expect(streamed(parent)).toBe("");
    child.post("proc.exit", 0);
    expect((await parent.settled()).ok).toBe(true);
    await settle();
    expect(streamed(parent)).toBe("later\n");
  });

  it("gives what is typed to a reader behind a process that waits in a blocking call", () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["p.js"], {});
    const older = h.worker(pid);
    older.post("fd.readStart", 0);
    const newer = spawnFrom(h, older, inherit);
    newer.worker.post("fd.readStart", 0);
    // The newer reader waits for a child that reads nothing: it reads nothing either.
    const waiting = newer.worker.sync("proc.spawnSync", {
      command: "node",
      args: ["c.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    expect(waiting.pending).toBe(true);
    h.kernel.writeInput(pid, "one\r");
    h.kernel.writeInput(pid, "two\r");
    expect(streamed(older)).toBe("one\ntwo\n");
    expect(streamed(newer.worker)).toBe("");
  });

  it("answers a blocking read of the terminal a process also streams, and resumes the stream after", async () => {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["p.js"], {});
    const main = h.worker(pid);
    main.post("fd.readStart", 0);
    expect(main.sync("fs.read", 0, 100, null).pending).toBe(true);
    h.kernel.writeInput(pid, "hello\r");
    const read = await main.settled();
    expect(decoder.decode(read.value as Uint8Array)).toBe("hello\n");
    expect(streamed(main)).toBe("");
    await settle();
    h.kernel.writeInput(pid, "more\r");
    expect(streamed(main)).toBe("more\n");
  });

  it("makes a foreground process that opens /dev/tty a reader, whatever its stdio is", async () => {
    const { h, shellPid, shell, program } = running();
    program.worker.post("fd.readStart", 0);
    // `echo x | node ask.js`, and a child with no stdio on the terminal at all.
    for (const stdio of [
      ["pipe", "inherit", "inherit"],
      ["pipe", "pipe", "pipe"],
    ]) {
      const asker = spawnFrom(h, shell, stdio);
      const fd = asker.worker.sync("fs.open", "/dev/tty", 0, 0).value as number;
      expect(asker.worker.sync("fs.read", fd, 100, null).pending).toBe(true);
      h.kernel.writeInput(shellPid, "hello\r");
      const read = await asker.worker.settled();
      expect(decoder.decode(read.value as Uint8Array)).toBe("hello\n");
      // Once it has closed the terminal and ended, the reader before it reads again.
      asker.worker.sync("fs.close", fd);
      asker.worker.post("proc.exit", 0);
      h.kernel.writeInput(shellPid, "next\r");
    }
    expect(streamed(program.worker)).toBe("next\nnext\n");
    // A stream on the opened terminal reads too.
    const streamer = spawnFrom(h, shell, ["pipe", "inherit", "inherit"]);
    const fd = streamer.worker.sync("fs.open", "/dev/tty", 0, 0).value as number;
    streamer.worker.post("fd.readStart", fd);
    h.kernel.writeInput(shellPid, "line\r");
    expect(streamed(streamer.worker, fd)).toBe("line\n");
  });

  it("gives the lines a streaming reader was sent and never took back to the terminal when it ends", () => {
    const { h, shellPid, shell, program } = running();
    program.worker.post("fd.readStart", 0);
    // Three lines typed ahead; the program's reader takes the first, and that ends the program.
    h.kernel.writeInput(shellPid, "1\r2\r3\r");
    expect(streamed(program.worker)).toBe("1\n2\n3\n");
    program.worker.post("fd.ack", 0, 2);
    program.worker.post("proc.exit", 0);
    // The rest is still the terminal's: the shell reads it next, in order, and nothing twice.
    expect(decoder.decode(shell.sync("fs.read", 0, 100, null).value as Uint8Array)).toBe("2\n");
    expect(decoder.decode(shell.sync("fs.read", 0, 100, null).value as Uint8Array)).toBe("3\n");
    expect(shell.sync("fs.read", 0, 100, null).pending).toBe(true);
  });

  it("gives back what a thread was sent and never took when the thread ends", () => {
    const { h, shellPid, program } = running();
    const thread = spawnThread(h, program.worker);
    thread.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "line\r");
    expect(streamed(thread)).toBe("line\n");
    // The thread ends; its process, which keeps the terminal open, reads the line next.
    program.worker.post("thread.terminate", thread.init.thread!.threadId);
    program.worker.post("fd.readStart", 0);
    expect(streamed(program.worker)).toBe("line\n");
  });

  it("gives nothing back that was typed before the Ctrl+C that ended the reader", () => {
    const { h, shellPid, shell, program } = running();
    shell.post("proc.signals", ["SIGINT"]);
    program.worker.post("fd.readStart", 0);
    // The program is busy and takes nothing of what is typed; then Ctrl+C.
    h.kernel.writeInput(shellPid, "rm -rf x\r");
    h.kernel.writeInput(shellPid, "\x03");
    expect(program.worker.terminated).toBe(true);
    // Flushed with the rest of the input: the shell must not run it.
    expect(shell.sync("fs.read", 0, 100, null).pending).toBe(true);
  });

  it("gives them back when the reader closes the terminal, too, and to the reader before it", () => {
    const { h, shellPid, shell, program } = running();
    program.worker.post("fd.readStart", 0);
    const asker = spawnFrom(h, shell, ["pipe", "inherit", "inherit"]);
    const fd = asker.worker.sync("fs.open", "/dev/tty", 0, 0).value as number;
    asker.worker.post("fd.readStart", fd);
    h.kernel.writeInput(shellPid, "yes\rmore\r");
    expect(streamed(asker.worker, fd)).toBe("yes\nmore\n");
    asker.worker.post("fd.ack", fd, 4);
    asker.worker.sync("fs.close", fd);
    expect(streamed(program.worker)).toBe("more\n");
  });

  it("gives keys a raw reader never took back as typed, to be edited for a cooked reader", () => {
    const { h, shellPid, shell, program } = running();
    program.worker.sync("tty.setRawMode", 0, true);
    program.worker.post("fd.readStart", 0);
    h.kernel.writeInput(shellPid, "q");
    h.kernel.writeInput(shellPid, "ls\r");
    // `q` reaches its reader, which ends the program; `ls` and Enter never do.
    program.worker.post("fd.ack", 0, 1);
    program.worker.sync("tty.setRawMode", 0, false);
    program.worker.post("proc.exit", 0);
    const before = h.events.length;
    expect(decoder.decode(shell.sync("fs.read", 0, 100, null).value as Uint8Array)).toBe("ls\n");
    // Echoed as the cooked reader takes them, as keys typed ahead are.
    expect(
      h.events
        .slice(before)
        .map((event) => (event.event === "output" ? event.data : ""))
        .join(""),
    ).toBe("ls\r\n");
  });

  it("leaves a background job that opens /dev/tty waiting", async () => {
    const { h, shellPid, program } = running();
    program.worker.post("fd.readStart", 0);
    const job = spawnFrom(h, program.worker, ["pipe", "inherit", "inherit"], { newGroup: true });
    const fd = job.worker.sync("fs.open", "/dev/tty", 0, 0).value as number;
    expect(job.worker.sync("fs.read", fd, 100, null).pending).toBe(true);
    h.kernel.writeInput(shellPid, "hello\r");
    await settle();
    expect(job.worker.answer().pending).toBe(true);
    expect(streamed(program.worker)).toBe("hello\n");
  });
});

describe("raw mode", () => {
  const inherit = ["inherit", "inherit", "inherit"];

  /** A page process streaming its terminal; `keys` types and returns what reached it since. */
  function streaming() {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    main.post("fd.readStart", 0);
    let seen = 0;
    const keys = (text: string) => {
      h.kernel.writeInput(pid, text);
      const all = streamed(main);
      const fresh = all.slice(seen);
      seen = all.length;
      return fresh;
    };
    return { h, pid, main, keys };
  }

  it("is cooked again when the process that made the terminal raw is killed", () => {
    const { h, main, keys } = streaming();
    const child = spawnFrom(h, main, ["ignore", "inherit", "inherit"]);
    child.worker.sync("tty.setRawMode", 1, true);
    expect(keys("a")).toBe("a");
    main.sync("proc.kill", child.pid, "SIGKILL");
    // Cooked: nothing arrives before the line ends.
    expect(keys("b")).toBe("");
    expect(keys("\r")).toBe("b\n");
  });

  it("is cooked again when the process whose thread made the terminal raw ends", () => {
    const { h, main, keys } = streaming();
    const child = spawnFrom(h, main, ["ignore", "inherit", "inherit"]);
    const thread = spawnThread(h, child.worker);
    thread.sync("tty.setRawMode", 1, true);
    expect(keys("a")).toBe("a");
    // The thread's end changes nothing: the mode is its process's.
    child.worker.post("thread.terminate", thread.init.thread!.threadId);
    expect(keys("b")).toBe("b");
    main.sync("proc.kill", child.pid, "SIGKILL");
    expect(keys("c")).toBe("");
  });

  it("stays on for a parent whose child also turned it on, however the child leaves it", () => {
    const { h, main, keys } = streaming();
    main.sync("tty.setRawMode", 0, true);
    // A child that turns raw mode on and exits.
    const first = spawnFrom(h, main, inherit);
    first.worker.sync("tty.setRawMode", 0, true);
    first.worker.post("proc.exit", 0);
    expect(keys("k")).toBe("k");
    // A child that turns it on and off again: it puts back the mode it found.
    const second = spawnFrom(h, main, inherit);
    second.worker.sync("tty.setRawMode", 0, true);
    second.worker.sync("tty.setRawMode", 0, false);
    second.worker.post("proc.exit", 0);
    expect(keys("l")).toBe("l");
    main.sync("tty.setRawMode", 0, false);
    expect(keys("m")).toBe("");
  });

  it("is not a background job's to change", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("fd.readStart", 0);
    // At the prompt, a background job turns raw mode on and exits.
    shell.sync("tty.setRawMode", 0, true);
    const atPrompt = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    expect(atPrompt.worker.sync("tty.setRawMode", 0, true).ok).toBe(true);
    atPrompt.worker.post("proc.exit", 0);
    h.kernel.writeInput(shellPid, "e");
    expect(streamed(shell)).toBe("e");
    // While a command reads lines, a background job turns raw mode on.
    shell.sync("tty.setRawMode", 0, false);
    const during = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    during.worker.sync("tty.setRawMode", 0, true);
    h.kernel.writeInput(shellPid, "x");
    expect(streamed(shell)).toBe("e");
    h.kernel.writeInput(shellPid, "\r");
    expect(streamed(shell)).toBe("ex\n");
  });

  it("is cooked again once the processes that made the terminal raw are left behind", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("fd.readStart", 0);
    // A supervisor's program makes the terminal raw, and so does a helper it starts.
    const supervisor = spawnFrom(h, shell, [0, 1, 2]);
    const program = spawnFrom(h, supervisor.worker, inherit);
    program.worker.sync("tty.setRawMode", 0, true);
    const helper = spawnFrom(h, program.worker, inherit);
    helper.worker.sync("tty.setRawMode", 0, true);
    // The supervisor is killed; both run on. Each puts back what it found, the newest first.
    shell.sync("proc.kill", supervisor.pid, "SIGKILL");
    h.kernel.writeInput(shellPid, "x");
    expect(streamed(shell)).toBe("");
    h.kernel.writeInput(shellPid, "\r");
    expect(streamed(shell)).toBe("x\n");
  });

  it("is cooked again for a shell that takes the terminal back from raw-mode processes", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("fd.readStart", 0);
    const job = spawnFrom(h, shell, [0, 1, 2]);
    job.worker.sync("tty.setRawMode", 0, true);
    const helper = spawnFrom(h, job.worker, inherit);
    helper.worker.sync("tty.setRawMode", 0, true);
    // Both still run when the shell takes the terminal back.
    shell.post("tty.reclaim", 0);
    h.kernel.writeInput(shellPid, "x");
    expect(streamed(shell)).toBe("");
    h.kernel.writeInput(shellPid, "\r");
    expect(streamed(shell)).toBe("x\n");
  });

  it("is not put back by what an ended process left running", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    shell.post("fd.readStart", 0);
    // A raw-mode program starts a raw-mode child, which found the terminal raw, and is killed.
    const program = spawnFrom(h, shell, [0, 1, 2]);
    program.worker.sync("tty.setRawMode", 0, true);
    const child = spawnFrom(h, program.worker, inherit);
    child.worker.sync("tty.setRawMode", 0, true);
    shell.sync("proc.kill", program.pid, "SIGKILL");
    // Cooked again; neither the child's requests nor its end change that.
    child.worker.sync("tty.setRawMode", 0, false);
    child.worker.sync("tty.setRawMode", 0, true);
    child.worker.post("proc.exit", 0);
    h.kernel.writeInput(shellPid, "x");
    expect(streamed(shell)).toBe("");
    h.kernel.writeInput(shellPid, "\r");
    expect(streamed(shell)).toBe("x\n");
  });
});

describe("giving up a read", () => {
  /** A page process played by a real sysClient. */
  function client() {
    const h = boot();
    const pid = h.kernel.spawnFromPage("node", ["main.js"], {});
    const main = h.worker(pid);
    return { h, pid, main, runtime: main.attachClient().runtime };
  }

  it("withdraws a read waiting for the terminal: it fails with EINTR and takes nothing", async () => {
    const { h, pid, runtime } = client();
    const withdrawn = new AbortController();
    const read = runtime.fs.readAsync(0, 100, null, withdrawn.signal);
    const outcome = read.then(
      (bytes) => decoder.decode(bytes),
      (error: SystemErrorRecord) => error.code,
    );
    await settle();
    withdrawn.abort();
    expect(await outcome).toBe("EINTR");
    // What is typed afterwards is the next reader's.
    h.kernel.writeInput(pid, "ls\r");
    expect(decoder.decode(await runtime.fs.readAsync(0, 100, null))).toBe("ls\n");
  });

  it("withdraws a read waiting for a pipe, and leaves the pipe to its next reader", async () => {
    const { runtime } = client();
    const { readFd, writeFd } = runtime.processes.pipe();
    const withdrawn = new AbortController();
    const outcome = runtime.fs.readAsync(readFd, 100, null, withdrawn.signal).then(
      (bytes) => decoder.decode(bytes),
      (error: SystemErrorRecord) => error.code,
    );
    await settle();
    withdrawn.abort();
    expect(await outcome).toBe("EINTR");
    runtime.fs.write(writeFd, encoder.encode("hi"), null);
    expect(decoder.decode(runtime.fs.read(readFd, 100, null))).toBe("hi");
  });

  it("answers with the bytes a read took before the kernel heard it was given up", async () => {
    const { h, pid, runtime } = client();
    const withdrawn = new AbortController();
    const read = runtime.fs.readAsync(0, 100, null, withdrawn.signal);
    await settle();
    // The kernel answers; the process gives the read up before the answer reaches it.
    h.kernel.writeInput(pid, "ls\r");
    withdrawn.abort();
    expect(decoder.decode(await read)).toBe("ls\n");
  });

  it("takes what is there for a read that is given up from the start, and withdraws it otherwise", async () => {
    const { h, pid, runtime } = client();
    const withdrawn = new AbortController();
    withdrawn.abort();
    h.kernel.writeInput(pid, "ls\r");
    expect(decoder.decode(await runtime.fs.readAsync(0, 100, null, withdrawn.signal))).toBe("ls\n");
    await expect(runtime.fs.readAsync(0, 100, null, withdrawn.signal)).rejects.toMatchObject({
      code: "EINTR",
    });
  });

  it("gives up only the read it is asked to, and forgets a read once it is answered", async () => {
    const { h, pid, main, runtime } = client();
    const first = new AbortController();
    const second = new AbortController();
    const kept = runtime.fs.readAsync(0, 100, null, first.signal);
    const givenUp = runtime.fs
      .readAsync(0, 100, null, second.signal)
      .catch((error: SystemErrorRecord) => error.code);
    await settle();
    second.abort();
    expect(await givenUp).toBe("EINTR");
    h.kernel.writeInput(pid, "one\r");
    expect(decoder.decode(await kept)).toBe("one\n");
    // Aborting after the answer asks the kernel for nothing.
    const sent = main.inbox.length;
    first.abort();
    await settle();
    expect(main.inbox.length).toBe(sent);
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

  it("ends a process that asks to die of a signal, as kill(getpid()) would (a shell)", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent, ["ignore", "ignore", "ignore"]);
    child.worker.post("proc.die", "SIGWINCH");
    expect(child.worker.terminated).toBe(false);
    child.worker.post("proc.die", "SIGINT");
    expect(child.worker.terminated).toBe(true);
    await Promise.resolve();
    expect(parent.messages("child-exit")).toEqual([
      { type: "child-exit", pid: child.pid, status: { code: null, signal: "SIGINT" } },
    ]);
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

describe("going on as a new process (forkAndExit)", () => {
  const forked = (answer: SyncAnswer) => {
    expect(answer.ok).toBe(true);
    return answer.value as { pid: number; ppid: number };
  };

  it("reports the exit at once and keeps the pipes open until the new process ends", async () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("node", ["parent.js"], {});
    const parent = h.worker(parentPid);
    const child = spawnFrom(h, parent);
    const stdoutFd = child.stdio[1] as number;
    parent.post("fd.readStart", stdoutFd);
    child.worker.post("fd.write", 1, encoder.encode("early\n"));
    const next = forked(child.worker.sync("proc.forkAndExit", { code: 3, signal: null }));
    expect(next.pid).not.toBe(child.pid);
    expect(next.pid).toBeGreaterThan(child.pid);
    // The page process's child leaves its parent running: the orphan's parent is the page process.
    expect(next.ppid).toBe(parentPid);
    expect(child.worker.terminated).toBe(false);
    await Promise.resolve();
    expect(parent.messages("child-exit")).toEqual([
      { type: "child-exit", pid: child.pid, status: { code: 3, signal: null } },
    ]);
    const chunks = () =>
      parent
        .messages("fd-data")
        .filter((message) => message.fd === stdoutFd)
        .map((message) => (message.chunk ? decoder.decode(message.chunk) : null));
    parent.post("fd.ack", stdoutFd, 6);
    // The pipe has not ended: the new process holds its write end.
    expect(chunks()).toEqual(["early\n"]);
    child.worker.post("fd.write", 1, encoder.encode("late\n"));
    parent.post("fd.ack", stdoutFd, 5);
    child.worker.post("proc.exit", 0);
    expect(child.worker.terminated).toBe(true);
    expect(chunks()).toEqual(["early\n", "late\n", null]);
    await Promise.resolve();
    // Nobody hears the new process's exit.
    expect(parent.messages("child-exit")).toHaveLength(1);
  });

  it("lets spawnSync return the old status once the new process has let go of the pipes", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "sh",
      args: ["-c", "(sleep 1; echo late) & exit 3"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = h.last();
    const oldPid = child.init.pid;
    child.post("fd.write", 1, encoder.encode("early\n"));
    forked(child.sync("proc.forkAndExit", { code: 3, signal: null }));
    await settle();
    expect(parent.answer().pending).toBe(true);
    child.post("fd.write", 1, encoder.encode("late\n"));
    child.post("proc.exit", 0);
    const result = (await parent.settled()).value as SpawnSyncResult;
    expect(result.pid).toBe(oldPid);
    expect(result.status).toEqual({ code: 3, signal: null });
    expect(decoder.decode(result.stdout)).toBe("early\nlate\n");
  });

  it("leaves a spawnSync that times out the new process running, as Node kills only the child", async () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["p.js"], {}));
    parent.sync("proc.spawnSync", {
      command: "sh",
      args: ["-c", "(sleep 1; echo late) & echo early"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 30,
    });
    const child = h.last();
    child.post("fd.write", 1, encoder.encode("early\n"));
    forked(child.sync("proc.forkAndExit", { code: 0, signal: null }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = parent.answer().value as SpawnSyncResult;
    expect(result.error).toBe("ETIMEDOUT");
    expect(decoder.decode(result.stdout)).toBe("early\n");
    expect(result.status).toEqual({ code: 0, signal: null });
    expect(child.terminated).toBe(false);
  });

  it("makes the old pid name no process and the new one a member of the old group", () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("node", ["a.js"], {});
    const parent = h.worker(parentPid);
    const child = spawnFrom(h, parent, ["ignore", "ignore", "ignore"], { newGroup: true });
    const next = forked(child.worker.sync("proc.forkAndExit", { code: 0, signal: null }));
    expect(parent.sync("proc.kill", child.pid, "0")).toMatchObject({
      ok: false,
      value: { code: "ESRCH" },
    });
    expect(parent.sync("proc.kill", next.pid, "0").ok).toBe(true);
    const listed = parent.sync("proc.list").value as { pid: number; ppid: number }[];
    expect(listed.map((entry) => entry.pid)).not.toContain(child.pid);
    expect(listed).toContainEqual(expect.objectContaining({ pid: next.pid, ppid: parentPid }));
    // The group the old process led goes on with the new one in it.
    expect(parent.sync("proc.kill", -child.pid, "SIGTERM").ok).toBe(true);
    expect(child.worker.terminated).toBe(true);
    expect(parent.sync("proc.kill", next.pid, "0")).toMatchObject({ ok: false });
  });

  it("gives the new process the children the worker started, which report to it", async () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(parentPid);
    const job = spawnFrom(h, shell, ["ignore", "ignore", "ignore"]);
    const sleeper = spawnFrom(h, job.worker, ["ignore", "ignore", "ignore"]);
    const next = forked(job.worker.sync("proc.forkAndExit", { code: 0, signal: null }));
    const listed = shell.sync("proc.list").value as { pid: number; ppid: number }[];
    expect(listed).toContainEqual(expect.objectContaining({ pid: sleeper.pid, ppid: next.pid }));
    sleeper.worker.post("proc.exit", 4);
    await Promise.resolve();
    expect(job.worker.messages("child-exit")).toEqual([
      { type: "child-exit", pid: sleeper.pid, status: { code: 4, signal: null } },
    ]);
    expect(shell.messages("child-exit")).toEqual([
      { type: "child-exit", pid: job.pid, status: { code: 0, signal: null } },
    ]);
  });

  it("tells the page a page process ended, and still lets the page end what goes on", async () => {
    const h = boot();
    const pagePid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(pagePid);
    const next = forked(shell.sync("proc.forkAndExit", { code: null, signal: "SIGTERM" }));
    expect(next.ppid).toBe(pagePid);
    expect(h.events).toContainEqual({ event: "exit", pid: pagePid, code: 143 });
    shell.sync("net.listen", 5174);
    await announced();
    expect(h.events).toContainEqual({ event: "port", port: 5174, type: "open" });
    h.kernel.killTree(pagePid);
    expect(shell.terminated).toBe(true);
    expect(h.events).toContainEqual({ event: "port", port: 5174, type: "close" });
    // One exit for the page process, none for what it went on as.
    expect(h.events.filter((event) => event.event === "exit")).toHaveLength(1);
  });

  it("takes the old process out of the terminal's foreground, and the new one is not in it", () => {
    const h = boot();
    const pagePid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(pagePid);
    const editor = spawnFrom(h, shell, [0, 1, 2]);
    expect(editor.worker.sync("tty.setRawMode", 0, true).ok).toBe(true);
    const next = forked(shell.sync("proc.forkAndExit", { code: 0, signal: null }));
    // What the old process started is out of the foreground: its raw mode is
    // undone, and the terminal's input is not its to read.
    h.kernel.writeInput(next.pid, "x");
    expect(editor.worker.sync("fs.read", 0, 10, null).pending).toBe(true);
    expect(shell.sync("tty.setRawMode", 0, true).ok).toBe(true);
    expect(shell.sync("fs.read", 0, 10, null).pending).toBe(true);
  });

  it("keeps a thread's spawnSync waiting for its child's output", async () => {
    const h = boot();
    const main = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const thread = spawnThread(h, main);
    thread.sync("proc.spawnSync", {
      command: "node",
      args: ["slow.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = h.last();
    forked(main.sync("proc.forkAndExit", { code: 0, signal: null }));
    await settle();
    expect(thread.answer().pending).toBe(true);
    child.post("fd.write", 1, encoder.encode("out\n"));
    child.post("proc.exit", 0);
    const result = (await thread.settled()).value as SpawnSyncResult;
    expect(decoder.decode(result.stdout)).toBe("out\n");
    expect(result.status).toEqual({ code: 0, signal: null });
  });

  it("tells the worker its new pid and ppid", () => {
    const h = boot();
    const parentPid = h.kernel.spawnFromPage("node", ["parent.js"], {});
    const child = spawnFrom(h, h.worker(parentPid), ["ignore", "ignore", "ignore"]);
    const { runtime } = child.worker.attachClient();
    expect(runtime.pid).toBe(child.pid);
    const next = runtime.processes.forkAndExit({ code: 0, signal: null });
    expect(next).not.toBe(child.pid);
    expect([runtime.pid, runtime.ppid]).toEqual([next, parentPid]);
  });

  it("refuses a worker thread", () => {
    const h = boot();
    const main = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const thread = spawnThread(h, main);
    expect(thread.sync("proc.forkAndExit", { code: 0, signal: null })).toMatchObject({
      ok: false,
      value: { code: "EINVAL" },
    });
  });

  it("moves the threads and connections with the worker, and frees everything at its end", async () => {
    const h = boot();
    const main = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    const thread = spawnThread(h, main);
    const server = h.worker(h.kernel.spawnFromPage("node", ["server.js"], {}));
    server.sync("net.listen", 4000);
    const connected = main.sync("net.connect", 4000);
    expect(connected.ok).toBe(true);
    const { channelId } = connected.value as { channelId: number };
    const next = forked(main.sync("proc.forkAndExit", { code: 0, signal: null }));
    expect(thread.sync("fs.stat", "/", true).ok).toBe(true);
    // The connection is the new process's: it hears that its peer is gone.
    server.post("proc.exit", 0);
    expect(main.messages("channel-dead")).toEqual([{ type: "channel-dead", channelId }]);
    main.post("proc.exit", 0);
    expect(thread.terminated).toBe(true);
    const other = h.worker(h.kernel.spawnFromPage("node", ["k.js"], {}));
    expect(other.sync("proc.kill", next.pid, "0")).toMatchObject({ ok: false });
    expect(other.sync("proc.list").value).toEqual([
      expect.objectContaining({ pid: other.init.pid }),
    ]);
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

  it("sends SIGWINCH to the foreground group after a change of size, and none for the same size", () => {
    const h = boot();
    const shellPid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(shellPid);
    const foreground = spawnFrom(h, shell, [0, 1, 2]);
    const background = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    foreground.worker.post("proc.signals", ["SIGWINCH"]);
    background.worker.post("proc.signals", ["SIGWINCH"]);
    h.kernel.resizeTerminal(shellPid, { cols: 100, rows: 30 });
    const inbox = foreground.worker.inbox;
    const resized = inbox.findIndex((message) => message.type === "resize");
    const signalled = inbox.findIndex(
      (message) => message.type === "signal" && message.signal === "SIGWINCH",
    );
    expect(resized).toBeGreaterThanOrEqual(0);
    expect(signalled).toBeGreaterThan(resized);
    expect(background.worker.messages("resize")).toHaveLength(1);
    expect(background.worker.messages("signal")).toEqual([]);
    h.kernel.resizeTerminal(shellPid, { cols: 100, rows: 30 });
    expect(foreground.worker.messages("resize")).toHaveLength(2);
    expect(foreground.worker.messages("signal")).toEqual([{ type: "signal", signal: "SIGWINCH" }]);
    h.kernel.resizeTerminal(shellPid, { cols: 100, rows: 31 });
    expect(foreground.worker.messages("signal")).toHaveLength(2);
    expect(background.worker.messages("signal")).toEqual([]);
  });
});

describe("what an exited page process leaves behind", () => {
  it("can still be ended through the page process's pid", async () => {
    const h = boot();
    const pagePid = h.kernel.spawnFromPage("jsh", [], {});
    const shell = h.worker(pagePid);
    const server = spawnFrom(h, shell, [0, 1, 2], { newGroup: true });
    const grandchild = spawnFrom(h, server.worker, ["ignore", "ignore", "ignore"]);
    server.worker.sync("net.listen", 5173);
    await announced();
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

  it("reports a descriptor on /dev/null as the device stat says: root's, 0666", () => {
    // Linux and macOS: fstat of an fd on /dev/null is crw-rw-rw- root root, as its stat.
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const fd = proc.sync("fs.open", "/dev/null", 0, 0).value as number;
    const opened = proc.sync("fs.fstat", fd).value as StatData;
    const named = proc.sync("fs.stat", "/dev/null", true).value as StatData;
    expect(opened.mode).toBe(0o20666);
    expect([opened.uid, opened.gid]).toEqual([0, 0]);
    expect([opened.mode, opened.uid, opened.gid]).toEqual([named.mode, named.uid, named.gid]);
    // A child given "ignore" has /dev/null there too.
    const child = spawnFrom(h, proc, ["ignore", "ignore", "ignore"]);
    expect((child.worker.sync("fs.fstat", 0).value as StatData).mode).toBe(0o20666);
    expect((child.worker.sync("fs.stat", "/dev/stdin", true).value as StatData).uid).toBe(0);
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
    // The three writes, in order, in the one pipe.
    expect(decoder.decode(parent.sync("fs.read", stdout, 100, null).value as Uint8Array)).toBe(
      "abc",
    );
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
    // Its times set to now, as `touch` asks: it stays the device.
    expect(proc.sync("fs.utimes", "/dev/null", null, null, true).ok).toBe(true);
    expect(proc.sync("fs.exists", "/dev/null").value).toBe(true);
    expect(isRegularFileAt(h, "/dev/null")).toBe(false);
  });

  it("copies nothing from a pipe, as libuv copies the size fstat reports, and a file into /dev/null", () => {
    const h = boot();
    const { parent, child, stdin } = piped(h);
    parent.sync("fs.write", stdin, encoder.encode("piped"), null);
    parent.sync("fs.close", stdin);
    expect(child.sync("fs.copyFile", "/dev/stdin", "/tmp/copy.txt", 0).ok).toBe(true);
    expect(h.kernel.vfs.readFile("/tmp/copy.txt").byteLength).toBe(0);
    // The pipe still holds what was written: the copy read none of it.
    expect(decoder.decode(child.sync("fs.read", 0, 100, null).value as Uint8Array)).toBe("piped");
    // A file that was there is emptied and given the pipe's mode.
    h.kernel.vfs.writeFile("/tmp/old.txt", encoder.encode("old"), 0o101, 0o644);
    expect(child.sync("fs.copyFile", "/dev/fd/0", "/tmp/old.txt", 0).ok).toBe(true);
    expect(h.kernel.vfs.readFile("/tmp/old.txt").byteLength).toBe(0);
    expect(h.kernel.vfs.stat("/tmp/old.txt", true).mode & 0o7777).toBe(0o600);
    h.kernel.vfs.writeFile("/tmp/copy.txt", encoder.encode("text"), 0o1101, 0o644);
    expect(child.sync("fs.copyFile", "/tmp/copy.txt", "/dev/null", 0).ok).toBe(true);
    expect(isRegularFileAt(h, "/dev/null")).toBe(false);
  });

  it("copies the whole of a file /dev/stdin stands for", () => {
    const h = boot();
    h.kernel.vfs.writeFile("/tmp/in.txt", encoder.encode("from a file"), 0o101, 0o640);
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const fd = parent.sync("fs.open", "/tmp/in.txt", 0, 0).value as number;
    const child = spawnFrom(h, parent, [fd, "pipe", "pipe"]).worker;
    expect(child.sync("fs.copyFile", "/dev/stdin", "/tmp/copy.txt", 0).ok).toBe(true);
    expect(decoder.decode(h.kernel.vfs.readFile("/tmp/copy.txt"))).toBe("from a file");
    expect(h.kernel.vfs.stat("/tmp/copy.txt", true).mode & 0o7777).toBe(0o640);
  });

  it("keeps the answers of a copy from a pipe onto what refuses it", () => {
    const h = boot();
    const { child } = piped(h);
    const failed = (answer: SyncAnswer) =>
      answer.ok ? "ok" : (answer.value as { system: SystemErrorRecord }).system.code;
    h.kernel.vfs.writeFile("/tmp/there", encoder.encode("kept"), 0o101, 0o644);
    expect(failed(child.sync("fs.copyFile", "/dev/stdin", "/tmp/there", COPYFILE_EXCL))).toBe(
      "EEXIST",
    );
    h.kernel.vfs.chmod("/tmp/there", 0o444, true);
    expect(failed(child.sync("fs.copyFile", "/dev/stdin", "/tmp/there", 0))).toBe("EACCES");
    expect(decoder.decode(h.kernel.vfs.readFile("/tmp/there"))).toBe("kept");
    h.kernel.vfs.mkdir("/tmp/ro", true, 0o555);
    expect(failed(child.sync("fs.copyFile", "/dev/stdin", "/tmp/ro/new", 0))).toBe("EACCES");
  });

  it("gives a copy of /dev/stdin on a pipe the pipe's own mode", async () => {
    const h = boot();
    const { parent, child, stdin } = piped(h);
    parent.sync("fs.write", stdin, encoder.encode("piped"), null);
    parent.sync("fs.close", stdin);
    child.sync("fs.copyFile", "/dev/stdin", "/tmp/from-pipe", 0);
    expect((await child.settled()).ok).toBe(true);
    const pipeMode = (child.sync("fs.fstat", 0).value as { mode: number }).mode & 0o7777;
    expect(pipeMode).not.toBe(0o644);
    expect(h.kernel.vfs.stat("/tmp/from-pipe", true).mode & 0o7777).toBe(pipeMode);
  });

  it("says copyfile, with both paths, when a copy from or to a device fails", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.mkdir("/tmp/ro", true, 0o555);
    // As Node reports it: `EACCES: permission denied, copyfile '/dev/null' -> '/tmp/ro/new'`.
    expect(proc.sync("fs.copyFile", "/dev/null", "/tmp/ro/new", 0).value).toMatchObject({
      system: { code: "EACCES", syscall: "copyfile", path: "/dev/null", dest: "/tmp/ro/new" },
    });
    expect(proc.sync("fs.copyFile", "/tmp/missing", "/dev/null", 0).value).toMatchObject({
      system: { code: "ENOENT", syscall: "copyfile", path: "/tmp/missing", dest: "/dev/null" },
    });
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

describe("permissions", () => {
  const code = (answer: SyncAnswer) => (answer.value as { code?: string }).code;

  it("checks what a process does, and not what the page or the kernel's setup does", () => {
    const h = boot();
    const dir = `${h.cwd}/locked`;
    h.kernel.mount([{ path: `${dir}/a.txt`, data: encoder.encode("one") }]);
    h.kernel.vfs.chmod(`${dir}/a.txt`, 0o444, true);
    h.kernel.vfs.chmod(dir, 0o555, true);
    // The page writes and makes what it likes: mount, as the editor saves.
    h.kernel.mount([
      { path: `${dir}/a.txt`, data: encoder.encode("two") },
      { path: `${dir}/b.txt`, data: encoder.encode("b") },
      { path: `${dir}/sub`, directory: true },
    ]);
    expect(decoder.decode(h.kernel.vfs.privileged.readFile(`${dir}/a.txt`))).toBe("two");
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    // A process is refused: by the descriptor calls the kernel answers…
    expect(code(proc.sync("fs.open", `${dir}/a.txt`, 0o1, 0))).toBe("EACCES");
    expect(code(proc.sync("fs.open", `${dir}/c.txt`, 0o101, 0o644))).toBe("EACCES");
    // …and by the path calls, which the kernel answers when the filesystem is its own.
    expect(
      code(proc.sync("fs.writeFile", `${dir}/a.txt`, encoder.encode("x"), 0o1101, 0o644)),
    ).toBe("EACCES");
    expect(code(proc.sync("fs.unlink", `${dir}/b.txt`))).toBe("EACCES");
    expect(code(proc.sync("fs.rm", `${dir}/sub`, true, true))).toBe("EACCES");
    h.kernel.vfs.chmod(`${dir}/a.txt`, 0, true);
    expect(code(proc.sync("fs.readFile", `${dir}/a.txt`))).toBe("EACCES");
    expect(proc.sync("fs.stat", `${dir}/a.txt`, true).ok).toBe(true);
    h.kernel.vfs.chmod(dir, 0o644, true);
    expect(proc.sync("fs.exists", `${dir}/a.txt`).value).toBe(false);
    expect(code(proc.sync("fs.stat", `${dir}/a.txt`, true))).toBe("EACCES");
  });

  it("reads, writes, lists, makes, removes and renames for the page whatever the modes", () => {
    const h = boot();
    const files = h.kernel.pageFiles;
    h.kernel.mount([
      { path: `${h.cwd}/keep.txt`, data: encoder.encode("learner's file") },
      { path: `${h.cwd}/dir/in.txt`, data: encoder.encode("in") },
      { path: `${h.cwd}/dir/sub/deep.txt`, data: encoder.encode("deep") },
    ]);
    // As a learner's `chmod 000 keep.txt dir` leaves them.
    h.kernel.vfs.chmod(`${h.cwd}/keep.txt`, 0o000, true);
    h.kernel.vfs.chmod(`${h.cwd}/dir`, 0o000, true);
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    expect(code(proc.sync("fs.readFile", `${h.cwd}/keep.txt`))).toBe("EACCES");
    expect(code(proc.sync("fs.readdir", `${h.cwd}/dir`))).toBe("EACCES");

    // The editor's paths are relative to the project, or absolute.
    expect(decoder.decode(files.readFile("keep.txt"))).toBe("learner's file");
    expect(decoder.decode(files.readFile(`${h.cwd}/dir/in.txt`))).toBe("in");
    expect(
      files
        .readdir("./dir")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["in.txt", "sub"]);
    files.writeFile("keep.txt", encoder.encode("saved"));
    files.writeFile("dir/new.txt", encoder.encode("new"));
    files.mkdir("dir/made/deeper", true);
    files.rename("dir/in.txt", "dir/made/moved.txt");
    files.rm("dir/sub", true, false);
    expect(decoder.decode(files.readFile("keep.txt"))).toBe("saved");
    expect(
      files
        .readdir("dir")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["made", "new.txt"]);
    expect(
      files
        .readdir("dir/made")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["deeper", "moved.txt"]);
    // A save keeps the mode the learner gave the file; what the page makes is ordinary.
    expect(h.kernel.vfs.privileged.stat(`${h.cwd}/keep.txt`, true).mode & 0o7777).toBe(0o000);
    expect(h.kernel.vfs.privileged.stat(`${h.cwd}/dir`, true).mode & 0o7777).toBe(0o000);
    expect(h.kernel.vfs.privileged.stat(`${h.cwd}/dir/new.txt`, true).mode & 0o7777).toBe(0o644);
    expect(h.kernel.vfs.privileged.stat(`${h.cwd}/dir/made`, true).mode & 0o7777).toBe(0o755);
    // The process is still refused.
    expect(code(proc.sync("fs.readFile", `${h.cwd}/keep.txt`))).toBe("EACCES");
    // A failure is the filesystem's own.
    expect(() => files.readFile("missing.txt")).toThrow(/ENOENT/);
    expect(() => files.rm("missing", true, false)).toThrow(/ENOENT/);
    expect(() => files.rm("missing", true, true)).not.toThrow();
  });

  it("checks the working directory a child changes into, not the one it inherits", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.mkdir(`${h.cwd}/in`, false, 0o755);
    h.kernel.vfs.chmod(`${h.cwd}/in`, 0o600, true);
    const spawn = (extra: Record<string, unknown>) =>
      parent.sync(
        "proc.spawn",
        { command: "node", args: ["-v"], cwd: `${h.cwd}/in`, env: h.env, stdio: [], ...extra },
        null,
      );
    // child_process's `cwd` option: libuv's child chdirs, and is refused.
    expect(code(spawn({}))).toBe("EACCES");
    // Fork and exec, as a shell runs a command: nothing changes directory.
    expect(spawn({ inheritCwd: true }).ok).toBe(true);
    h.kernel.vfs.chmod(h.cwd, 0o600, true);
    expect(code(spawn({}))).toBe("EACCES");
    expect(spawn({ inheritCwd: true }).ok).toBe(true);
  });

  it("checks the working directory of a page's process only when the page chose it", () => {
    const h = boot();
    h.kernel.mount([{ path: `${h.cwd}/in/a.js`, data: encoder.encode("") }]);
    // A learner takes the search bit from the project directory (`chmod 000 .`).
    h.kernel.vfs.chmod(h.cwd, 0o000, true);
    // The editor names no directory for Run or a new terminal: they still
    // start, so the learner can undo the chmod from a shell.
    expect(h.kernel.spawnFromPage("sh", ["-c", "chmod 755 ."], {})).toBeGreaterThan(0);
    expect(h.kernel.spawnFromPage("jsh", [], { env: { TERM: "dumb" } })).toBeGreaterThan(0);
    expect(h.last().init.cwd).toBe(h.cwd);
    // A directory the page chose is one its process changes into, and is checked.
    expect(() => h.kernel.spawnFromPage("sh", [], { cwd: "." })).toThrow(/EACCES/);
    expect(() => h.kernel.spawnFromPage("sh", [], { cwd: "in" })).toThrow(/EACCES/);
    expect(() => h.kernel.spawnFromPage("sh", [], { cwd: `${h.cwd}/in` })).toThrow(/EACCES/);
    h.kernel.vfs.chmod(h.cwd, 0o755, true);
    expect(h.kernel.spawnFromPage("sh", [], { cwd: "in" })).toBeGreaterThan(0);
    expect(h.last().init.cwd).toBe(`${h.cwd}/in`);
  });

  it("answers access on a device by the owner bits its stat reports", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const child = spawnFrom(h, parent).worker;
    const allowed = (path: string, mode: number) => {
      const answer = child.sync("fs.access", path, mode);
      return answer.ok ? "ok" : code(answer);
    };
    // /dev/null is crw-rw-rw-, /dev/fd dr-xr-xr-x, /dev/stdout here a pipe.
    for (const path of ["/dev/null", "//dev/./null", "/dev/stdout", "/dev/fd/1"]) {
      expect([R_OK, W_OK, X_OK, R_OK | W_OK].map((mode) => allowed(path, mode))).toEqual([
        "ok",
        "ok",
        "EACCES",
        "ok",
      ]);
    }
    expect([R_OK, W_OK, X_OK].map((mode) => allowed("/dev/fd", mode))).toEqual([
      "ok",
      "EACCES",
      "ok",
    ]);
    const refused = child.sync("fs.access", "/dev/null", X_OK).value as {
      system?: SystemErrorRecord;
    };
    expect(refused.system).toMatchObject({ code: "EACCES", syscall: "access", path: "/dev/null" });
    expect(allowed("/dev/fd/99", F_OK)).toBe("ENOENT");
  });

  it("makes /tmp as Linux has it, and the kernel's own directories searchable", () => {
    const h = boot();
    expect(h.kernel.vfs.stat("/tmp", true).mode & 0o7777).toBe(0o1777);
    const paths = ["/", "/bin", "/usr/bin", h.cwd];
    expect(paths.map((path) => h.kernel.vfs.stat(path, true).mode & 0o7777)).toEqual(
      paths.map(() => 0o755),
    );
    expect(h.kernel.vfs.stat("/bin/node", true).mode & 0o7777).toBe(0o755);
    // Root's, as on Linux: searchable and readable, and nobody but root may write it.
    const dev = h.kernel.vfs.stat("/dev", true);
    expect([(dev.mode & 0o7777).toString(8), dev.uid, dev.gid]).toEqual(["755", 0, 0]);
  });

  it("lets nobody but root change /dev itself, or link to a device", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.symlink("/dev", `${h.cwd}/devlink`);
    h.kernel.vfs.writeFile(`${h.cwd}/mine`, encoder.encode("m"), 0o101, 0o644);
    const failed = (answer: SyncAnswer) => {
      if (answer.ok) {
        return "ok";
      }
      const { system } = answer.value as { system: SystemErrorRecord };
      return `${system.code} ${system.syscall}`;
    };
    expect(failed(proc.sync("fs.chmod", "/dev", 0o755, true))).toBe("EPERM chmod");
    expect(failed(proc.sync("fs.chmod", `${h.cwd}/devlink`, 0o777, true))).toBe("EPERM chmod");
    expect(failed(proc.sync("fs.utimes", "/dev", 1000, 1000, true))).toBe("EPERM utime");
    expect(failed(proc.sync("fs.access", "/dev", W_OK))).toBe("EACCES access");
    expect(failed(proc.sync("fs.access", "/dev", R_OK | X_OK))).toBe("ok");
    expect(failed(proc.sync("fs.rm", "/dev/x", false, true))).toBe("ok");
    expect(failed(proc.sync("fs.rename", `${h.cwd}/mine`, "/dev/mine"))).toBe("EACCES rename");
    expect(failed(proc.sync("fs.link", `${h.cwd}/mine`, "/dev/hl"))).toBe("EACCES link");
    // Linux's protected hard links refuse a device the user does not own,
    // before the directory is asked; a name a device has is taken.
    expect(failed(proc.sync("fs.link", "/dev/null", "/dev/hl"))).toBe("EPERM link");
    expect(failed(proc.sync("fs.link", "/dev/null", `${h.cwd}/hl`))).toBe("EPERM link");
    expect(failed(proc.sync("fs.link", `${h.cwd}/mine`, "/dev/null"))).toBe("EEXIST link");
    expect(failed(proc.sync("fs.chmod", "/dev/null", 0o600, true))).toBe("EPERM chmod");
    const dev = proc.sync("fs.stat", "/dev", true).value as StatData;
    expect([(dev.mode & 0o7777).toString(8), dev.uid, dev.gid]).toEqual(["755", 0, 0]);
    // /dev/null is root's crw-rw-rw-.
    const nul = proc.sync("fs.stat", "/dev/null", true).value as StatData;
    expect([(nul.mode & 0o177777).toString(8), nul.uid, nul.gid]).toEqual(["20666", 0, 0]);
    expect(failed(proc.sync("fs.access", "/dev/null", R_OK | W_OK))).toBe("ok");
    // Its own entry is in root's `/` on Linux.
    expect(failed(proc.sync("fs.rmdir", "/dev"))).toBe("EACCES rmdir");
    expect(failed(proc.sync("fs.rename", "/dev", "/dev2"))).toBe("EACCES rename");
    expect(failed(proc.sync("fs.rename", "/tmp/../dev/", "/dev2"))).toBe("EACCES rename");
    expect(failed(proc.sync("fs.rename", `${h.cwd}/mine`, "/dev"))).toBe("EACCES rename");
    expect(h.kernel.vfs.exists("/dev2")).toBe(false);
  });

  /** The code and syscall a call failed with, or "ok". */
  const outcome = (answer: SyncAnswer) => {
    if (answer.ok) {
      return "ok";
    }
    const { system } = answer.value as { system: SystemErrorRecord };
    return `${system.code} ${system.syscall}`;
  };

  it("keeps /dev where it is by every path, a link to / too, before the kind", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const root = `${h.cwd}/root`;
    h.kernel.vfs.symlink("/", root);
    h.kernel.vfs.mkdir(`${h.cwd}/empty`, false, 0o755);
    expect(outcome(proc.sync("fs.unlink", "/dev"))).toBe("EACCES unlink");
    expect(outcome(proc.sync("fs.unlink", `${root}/dev`))).toBe("EACCES unlink");
    expect(outcome(proc.sync("fs.rmdir", `${root}/dev`))).toBe("EACCES rmdir");
    expect(outcome(proc.sync("fs.rm", `${root}/dev`, true, true))).toBe("EACCES rm");
    expect(outcome(proc.sync("fs.rename", `${root}/dev`, `${root}/devx`))).toBe("EACCES rename");
    expect(outcome(proc.sync("fs.rename", `${h.cwd}/empty`, `${root}/dev`))).toBe("EACCES rename");
    const dev = proc.sync("fs.stat", "/dev", true).value as StatData;
    expect([dev.uid, h.kernel.vfs.readdir("/dev").length]).toEqual([0, 6]);
  });

  it("answers utimes on a device as utimensat: now with write permission, times only to its owner", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const proc = spawnFrom(h, parent).worker;
    h.kernel.vfs.symlink("/dev", `${h.cwd}/devlink`);
    for (const path of ["/dev/null", `${h.cwd}/devlink/null`, "/dev/tty"]) {
      expect(outcome(proc.sync("fs.utimes", path, 1000, 1000, true))).toBe("EPERM utime");
      expect(outcome(proc.sync("fs.utimes", path, null, 1000, true))).toBe("EPERM utime");
      expect(outcome(proc.sync("fs.utimes", path, null, null, true))).toBe("ok");
    }
    expect(outcome(proc.sync("fs.utimes", "/dev/null", 1000, 1000, false))).toBe("EPERM utime");
    expect(outcome(proc.sync("fs.utimes", `${h.cwd}/devlink/null`, 1, 1, false))).toBe(
      "EPERM utime",
    );
    // A pipe behind /dev/stdout is the user's; /dev itself, root's, is not writable.
    expect(outcome(proc.sync("fs.utimes", "/dev/stdout", 1000, 1000, true))).toBe("ok");
    expect(outcome(proc.sync("fs.utimes", "/dev", null, null, true))).toBe("EACCES utime");
    expect(outcome(proc.sync("fs.utimes", "/dev/fd", null, null, true))).toBe("EACCES utime");
  });

  it("refuses a directory open of a device, and the owner's calls on a descriptor of root's", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    const O_DIRECTORY = 0o200000;
    expect(outcome(proc.sync("fs.open", "/dev/null", O_DIRECTORY, 0))).toBe("ENOTDIR open");
    expect(outcome(proc.sync("fs.open", "/dev/tty", O_DIRECTORY, 0))).toBe("ENOTDIR open");
    expect(outcome(proc.sync("fs.open", "/dev/stdin", O_DIRECTORY, 0))).toBe("ENOTDIR open");
    const nul = proc.sync("fs.open", "/dev/null", 0, 0).value as number;
    expect(outcome(proc.sync("fs.fchmod", nul, 0o600))).toBe("EPERM fchmod");
    expect(outcome(proc.sync("fs.futimes", nul, 1, 1))).toBe("EPERM futime");
    // The user's terminal is no file whose mode the kernel keeps.
    expect(outcome(proc.sync("fs.fchmod", 0, 0o600))).toBe("EINVAL fchmod");
  });

  it("answers for /dev/fd and every device by each spelling, its last link not followed", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.symlink("/", `${h.cwd}/root`);
    h.kernel.vfs.symlink("/dev", `${h.cwd}/devlink`);
    h.kernel.vfs.symlink("/dev/null", `${h.cwd}/mine`);
    const kind = (path: string) => {
      const stat = proc.sync("fs.stat", path, false).value as StatData;
      return [(stat.mode & 0o170000).toString(8), stat.uid];
    };
    for (const path of ["/dev/fd", `${h.cwd}/root/dev/fd`, `${h.cwd}/devlink/fd`]) {
      expect(kind(path)).toEqual(["40000", 0]);
      expect(outcome(proc.sync("fs.readlink", path))).toBe("EINVAL readlink");
    }
    for (const path of ["/dev/null", `${h.cwd}/root/dev/null`, `${h.cwd}/devlink/tty`]) {
      expect(kind(path)).toEqual(["20000", 0]);
      expect(outcome(proc.sync("fs.readlink", path))).toBe("EINVAL readlink");
    }
    // A link of the user's to a device is a link.
    expect(kind(`${h.cwd}/mine`)).toEqual(["120000", 1]);
    expect(proc.sync("fs.readlink", `${h.cwd}/mine`).value).toBe("/dev/null");
    expect(proc.sync("fs.readdir", `${h.cwd}/root/dev/fd`).value).toEqual(
      proc.sync("fs.readdir", "/dev/fd").value,
    );
  });

  it("takes /dev/fd/.. for /dev, and a name after any other device for ENOTDIR, by every path", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.symlink("/", `${h.cwd}/root`);
    h.kernel.vfs.symlink("/dev", `${h.cwd}/devlink`);
    const devNames = h.kernel.vfs.readdir("/dev").map((entry) => entry.name);
    const names = (answer: SyncAnswer) =>
      (answer.value as { name: string }[]).map((entry) => entry.name);
    for (const path of [
      "/dev/fd/..",
      "/dev/fd/./..",
      "/dev/fd/../",
      "/dev/fd/../fd/..",
      `${h.cwd}/root/dev/fd/..`,
      `${h.cwd}/devlink/fd/..`,
      `${h.cwd}/devlink/fd/./..`,
    ]) {
      const kind = (follow: boolean) => {
        const stat = proc.sync("fs.stat", path, follow).value as StatData;
        return [(stat.mode & 0o170000).toString(8), stat.uid];
      };
      expect({
        path,
        stat: kind(true),
        lstat: kind(false),
        access: outcome(proc.sync("fs.access", path, 0)),
        realpath: proc.sync("fs.realpath", path).value,
        readdir: names(proc.sync("fs.readdir", path)),
        exists: proc.sync("fs.exists", path).value,
      }).toEqual({
        path,
        stat: ["40000", 0],
        lstat: ["40000", 0],
        access: "ok",
        realpath: "/dev",
        readdir: devNames,
        exists: true,
      });
    }
    // Into /dev again by a name.
    expect(proc.sync("fs.realpath", "/dev/fd/../fd/../null").value).toBe("/dev/null");
    expect(
      outcome(proc.sync("fs.writeFile", "/dev/fd/../null", encoder.encode("x"), 0o1101, 0o666)),
    ).toBe("ok");
    // A missing name, and a refusal, are the tree's, named as given.
    expect(proc.sync("fs.stat", "/dev/fd/../nope", true).value).toMatchObject({
      system: { code: "ENOENT", syscall: "stat", path: "/dev/fd/../nope" },
    });
    expect(outcome(proc.sync("fs.mkdir", `${h.cwd}/devlink/fd/../xd`, false, 0o777))).toBe(
      "EACCES mkdir",
    );
    expect(outcome(proc.sync("fs.stat", "/dev/fd/nope", true))).toBe("ENOENT stat");
    // A device that is no directory: nothing goes through it.
    for (const path of [
      "/dev/fd/0/..",
      "/dev/null/..",
      "/dev/null/.",
      "/dev/null/",
      "/dev/tty/../null",
      `${h.cwd}/root/dev/fd/0/..`,
      `${h.cwd}/devlink/null/..`,
    ]) {
      expect({
        path,
        stat: outcome(proc.sync("fs.stat", path, true)),
        lstat: outcome(proc.sync("fs.stat", path, false)),
        access: outcome(proc.sync("fs.access", path, 0)),
        readdir: outcome(proc.sync("fs.readdir", path)),
        exists: proc.sync("fs.exists", path).value,
      }).toEqual({
        path,
        stat: "ENOTDIR stat",
        lstat: "ENOTDIR lstat",
        access: "ENOTDIR access",
        readdir: "ENOTDIR scandir",
        exists: false,
      });
    }
  });

  it("refuses to make, rename or remove entries in /dev, also through a link to it, and keeps its devices", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    h.kernel.vfs.symlink("/dev", `${h.cwd}/devlink`);
    const create = 0o101;
    expect(code(proc.sync("fs.open", "/dev/x", create, 0o666))).toBe("EACCES");
    expect(code(proc.sync("fs.writeFile", "/dev/x", encoder.encode(""), create, 0o666))).toBe(
      "EACCES",
    );
    expect(code(proc.sync("fs.mkdir", "/dev/xd", false, 0o777))).toBe("EACCES");
    expect(
      code(proc.sync("fs.writeFile", `${h.cwd}/devlink/x`, encoder.encode(""), create, 0o666)),
    ).toBe("EACCES");
    expect(code(proc.sync("fs.mkdir", `${h.cwd}/devlink/xd`, false, 0o777))).toBe("EACCES");
    expect(code(proc.sync("fs.symlink", "/tmp", "/dev/xl"))).toBe("EACCES");
    expect(code(proc.sync("fs.access", "/dev", 2))).toBe("EACCES");
    expect(h.kernel.vfs.readdir("/dev").map((entry) => entry.name)).not.toContain("x");
    // The devices open for reading and writing as before.
    const fd = proc.sync("fs.open", "/dev/null", create | 0o1000, 0o666);
    expect(fd.ok).toBe(true);
    expect(proc.sync("fs.close", fd.value).ok).toBe(true);
    expect(proc.sync("fs.writeFile", "/dev/null", encoder.encode("x"), create, 0o666).ok).toBe(
      true,
    );
    expect(proc.sync("fs.readFile", "/dev/null")).toMatchObject({ ok: true });
  });

  it("refuses to spawn a file without its execute bit, from the page and from a process", () => {
    const h = boot();
    h.kernel.mount([{ path: `${h.cwd}/run.sh`, data: encoder.encode("#!/bin/sh\necho hi\n") }]);
    expect(() => h.kernel.spawnFromPage("./run.sh", [], {})).toThrow(/EACCES/);
    const parent = h.worker(h.kernel.spawnFromPage("node", ["parent.js"], {}));
    const refused = parent.sync(
      "proc.spawn",
      { command: "./run.sh", args: [], cwd: h.cwd, env: h.env, stdio: ["pipe", "pipe", "pipe"] },
      null,
    );
    expect(refused.ok).toBe(false);
    expect(code(refused)).toBe("EACCES");
    h.kernel.vfs.chmod(`${h.cwd}/run.sh`, 0o755, true);
    expect(h.kernel.spawnFromPage("./run.sh", [], {})).toBeGreaterThan(0);
  });
});

describe("the file mode creation mask", () => {
  const perm = (h: Harness, path: string) => h.kernel.vfs.stat(path, false).mode & 0o7777;
  const WRITE = 0o1101;

  it("starts a page's process with 022 and creates what it asks for under its own mask", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    expect(readUmask(proc.init.umask)).toBe(0o022);
    expect(proc.sync("fs.writeFile", `${h.cwd}/f`, encoder.encode("x"), WRITE, 0o666).ok).toBe(
      true,
    );
    expect(perm(h, `${h.cwd}/f`)).toBe(0o644);
    // The process sets its mask in its own cell; the kernel reads it there.
    expect(writeUmask(proc.init.umask, 0o077)).toBe(0o022);
    proc.sync("fs.writeFile", `${h.cwd}/g`, encoder.encode("x"), WRITE, 0o666);
    proc.sync("fs.mkdir", `${h.cwd}/d`, false, 0o777);
    proc.sync("fs.mkdir", `${h.cwd}/r/s`, true, 0o777);
    const fd = proc.sync("fs.open", `${h.cwd}/o`, 0o101, 0o666).value as number;
    proc.sync("fs.close", fd);
    const temp = proc.sync("fs.mkdtemp", `${h.cwd}/t-`).value as string;
    expect(
      ["g", "d", "r", "r/s", "o"].map((name) => perm(h, `${h.cwd}/${name}`)).concat(perm(h, temp)),
    ).toEqual([0o600, 0o700, 0o700, 0o700, 0o600, 0o700]);
    // mkdtemp asks for 0700, which only a mask on the owner's bits shows.
    writeUmask(proc.init.umask, 0o277);
    expect(perm(h, proc.sync("fs.mkdtemp", `${h.cwd}/u-`).value as string)).toBe(0o500);
    // A copy has its source's mode, as libuv's fchmod leaves it.
    h.kernel.vfs.chmod(`${h.cwd}/f`, 0o777, true);
    proc.sync("fs.copyFile", `${h.cwd}/f`, `${h.cwd}/copy`, 0);
    expect(perm(h, `${h.cwd}/copy`)).toBe(0o777);
  });

  it("gives a copy of a device the device's mode, whatever the mask and over a file that was there", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    writeUmask(proc.init.umask, 0o077);
    expect(proc.sync("fs.copyFile", "/dev/null", `${h.cwd}/dn`, 0).ok).toBe(true);
    expect(perm(h, `${h.cwd}/dn`)).toBe(0o666);
    h.kernel.vfs.writeFile(`${h.cwd}/old`, encoder.encode("old"), WRITE, 0o600);
    expect(proc.sync("fs.copyFile", "/dev/null", `${h.cwd}/old`, 0).ok).toBe(true);
    expect(perm(h, `${h.cwd}/old`)).toBe(0o666);
    expect(h.kernel.vfs.readFile(`${h.cwd}/old`).byteLength).toBe(0);
  });

  it("keeps the page's own requests at 0644 and 0755 whatever a process set", () => {
    const h = boot();
    const proc = h.worker(h.kernel.spawnFromPage("node", ["a.js"], {}));
    writeUmask(proc.init.umask, 0o077);
    proc.sync("fs.mkdir", `${h.cwd}/mine`, false, 0o777);
    h.kernel.mount([{ path: `${h.cwd}/mounted/a.txt`, data: encoder.encode("a") }]);
    h.kernel.pageFiles.writeFile("saved.txt", encoder.encode("s"));
    h.kernel.pageFiles.mkdir("made/deep", true);
    expect(
      ["mine", "mounted", "mounted/a.txt", "saved.txt", "made", "made/deep"].map((name) =>
        perm(h, `${h.cwd}/${name}`),
      ),
    ).toEqual([0o700, 0o755, 0o644, 0o644, 0o755, 0o755]);
    // And another page process still starts with 022.
    const other = h.worker(h.kernel.spawnFromPage("node", ["b.js"], {}));
    expect(readUmask(other.init.umask)).toBe(0o022);
    other.sync("fs.writeFile", `${h.cwd}/theirs`, encoder.encode("x"), WRITE, 0o666);
    expect(perm(h, `${h.cwd}/theirs`)).toBe(0o644);
  });

  it("gives a child a copy of its parent's mask at the spawn, or the mask the spawn names", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["parent.js"], {}));
    writeUmask(parent.init.umask, 0o027);
    const child = spawnFrom(h, parent).worker;
    expect(readUmask(child.init.umask)).toBe(0o027);
    child.sync("fs.writeFile", `${h.cwd}/c1`, encoder.encode("x"), WRITE, 0o666);
    expect(perm(h, `${h.cwd}/c1`)).toBe(0o640);
    // A copy: neither changes the other's afterwards.
    writeUmask(child.init.umask, 0);
    writeUmask(parent.init.umask, 0o077);
    child.sync("fs.writeFile", `${h.cwd}/c2`, encoder.encode("x"), WRITE, 0o666);
    parent.sync("fs.writeFile", `${h.cwd}/p2`, encoder.encode("x"), WRITE, 0o666);
    expect([perm(h, `${h.cwd}/c2`), perm(h, `${h.cwd}/p2`)]).toEqual([0o666, 0o600]);
    // What a shell's subshell starts runs under the subshell's mask.
    const named = spawnFrom(h, parent, ["pipe", "pipe", "pipe"], { umask: 0o002 }).worker;
    expect(readUmask(named.init.umask)).toBe(0o002);
    expect(readUmask(parent.init.umask)).toBe(0o077);
    // And a grandchild gets its parent's, not the first process's.
    expect(readUmask(spawnFrom(h, named).worker.init.umask)).toBe(0o002);
  });

  it("gives spawnSync's child its parent's mask too", () => {
    const h = boot();
    const parent = h.worker(h.kernel.spawnFromPage("node", ["parent.js"], {}));
    writeUmask(parent.init.umask, 0o077);
    parent.sync("proc.spawnSync", {
      command: "node",
      args: ["child.js"],
      cwd: h.cwd,
      env: h.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(readUmask(h.last().init.umask)).toBe(0o077);
  });

  it("shares one mask between a process and its threads", () => {
    const h = boot();
    const main = h.worker(h.kernel.spawnFromPage("node", ["main.js"], {}));
    writeUmask(main.init.umask, 0o027);
    const thread = spawnThread(h, main);
    expect(thread.init.thread).not.toBeNull();
    expect(readUmask(thread.init.umask)).toBe(0o027);
    thread.sync("fs.writeFile", `${h.cwd}/t1`, encoder.encode("x"), WRITE, 0o666);
    // A change by the main thread is the thread's at once.
    writeUmask(main.init.umask, 0o077);
    expect(readUmask(thread.init.umask)).toBe(0o077);
    thread.sync("fs.writeFile", `${h.cwd}/t2`, encoder.encode("x"), WRITE, 0o666);
    thread.sync("fs.mkdir", `${h.cwd}/td`, false, 0o777);
    expect(["t1", "t2", "td"].map((name) => perm(h, `${h.cwd}/${name}`))).toEqual([
      0o640, 0o600, 0o700,
    ]);
    // What the thread starts inherits the process's mask.
    expect(readUmask(spawnFrom(h, thread).worker.init.umask)).toBe(0o077);
  });
});
