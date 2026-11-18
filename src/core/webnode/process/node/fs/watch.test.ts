// @vitest-environment node
// fs.watch / fs.watchFile / fs.promises.watch over the fake runtime's real
// Vfs: the Linux (inotify) event names, recursion, close and AbortSignal, and
// the process reference a persistent watcher holds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeRuntime, type FakeRuntime } from "../../testing/fakeRuntime";
import { setRuntime } from "../../runtime";
import type * as nodeFs from "node:fs";
import webnodeFs from "../fs";
import fsPromises from "../fs_promises";
import { runMacrotask } from "../eventLoop";
import { createProcess } from "../process";

const fs = webnodeFs as unknown as typeof nodeFs;

let runtime: FakeRuntime;

beforeEach(() => {
  runtime = createFakeRuntime({ cwd: "/work" });
  runtime.vfs.mkdir("/work", false, 0o755);
  setRuntime(runtime);
});

afterEach(() => {
  setRuntime(null);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("fs.watch", () => {
  it("reports create, modify, delete and rename in a directory", async () => {
    fs.mkdirSync("/work/w");
    const events: [string, unknown][] = [];
    const watcher = fs.watch("/work/w", (eventType, filename) =>
      events.push([eventType, filename]),
    );
    fs.writeFileSync("/work/w/a", "1");
    fs.appendFileSync("/work/w/a", "2");
    fs.renameSync("/work/w/a", "/work/w/b");
    fs.unlinkSync("/work/w/b");
    expect(events).toEqual([]);
    await tick();
    expect(events).toEqual([
      ["rename", "a"],
      ["change", "a"],
      ["change", "a"],
      ["rename", "a"],
      ["rename", "b"],
      ["rename", "b"],
    ]);
    watcher.close();
  });

  it("watches a file by its own name, ignores nested entries unless recursive, and encodes names", async () => {
    fs.mkdirSync("/work/r/deep", { recursive: true });
    fs.writeFileSync("/work/r/file", "");
    const fileEvents: unknown[] = [];
    const flat: unknown[] = [];
    const deep: unknown[] = [];
    const file = fs.watch("/work/r/file", (type, name) => fileEvents.push([type, name]));
    const top = fs.watch("/work/r", { encoding: "buffer" }, (type, name) =>
      flat.push([type, (name as unknown) instanceof Uint8Array ? `buffer:${String(name)}` : name]),
    );
    const recursive = fs.watch("/work/r", { recursive: true }, (type, name) =>
      deep.push([type, name]),
    );
    fs.writeFileSync("/work/r/file", "x");
    fs.writeFileSync("/work/r/deep/inner", "y");
    await tick();
    // Writing the empty file reports its O_TRUNC and then the write, as on Linux.
    expect(fileEvents).toEqual([
      ["change", "file"],
      ["change", "file"],
    ]);
    expect(flat).toEqual([
      ["change", "buffer:file"],
      ["change", "buffer:file"],
    ]);
    expect(deep).toEqual([
      ["change", "file"],
      ["change", "file"],
      ["rename", "deep/inner"],
      ["change", "deep/inner"],
    ]);
    for (const watcher of [file, top, recursive]) {
      watcher.close();
    }
  });

  it("holds a process reference until closed or unref'd, and emits close once", async () => {
    const watcher = fs.watch("/work");
    expect(runtime.refCount).toBe(1);
    watcher.unref();
    expect(runtime.refCount).toBe(0);
    watcher.ref();
    expect(runtime.refCount).toBe(1);
    let closes = 0;
    watcher.on("close", () => closes++);
    watcher.close();
    watcher.close();
    expect(runtime.refCount).toBe(0);
    await tick();
    expect(closes).toBe(1);
    const quiet = fs.watch("/work", { persistent: false });
    expect(runtime.refCount).toBe(0);
    quiet.close();
  });

  it("drops events queued before close", async () => {
    const events: unknown[] = [];
    const watcher = fs.watch("/work", () => events.push(1));
    fs.writeFileSync("/work/late", "");
    watcher.close();
    await tick();
    expect(events).toEqual([]);
  });

  it("reports a change whatever the program made of queueMicrotask", async () => {
    const events: unknown[] = [];
    const watcher = fs.watch("/work", (eventType, filename) => events.push([eventType, filename]));
    const real = globalThis.queueMicrotask;
    // What a test's fake timers leave: jobs that wait for a clock nobody advances.
    const faked: unknown[] = [];
    globalThis.queueMicrotask = (job) => void faked.push(job);
    try {
      fs.writeFileSync("/work/made", "");
      expect(events).toEqual([]);
      await tick();
    } finally {
      globalThis.queueMicrotask = real;
    }
    expect(events).toEqual([["rename", "made"]]);
    expect(faked).toEqual([]);
    watcher.close();
  });

  it("closes on an AbortSignal", async () => {
    const controller = new AbortController();
    const watcher = fs.watch("/work", { signal: controller.signal });
    let closed = false;
    watcher.on("close", () => {
      closed = true;
    });
    controller.abort();
    await tick();
    expect(closed).toBe(true);
    expect(runtime.refCount).toBe(0);
  });

  it("throws Node's error for a missing path", () => {
    expect(() => fs.watch("missing")).toThrow(
      expect.objectContaining({
        code: "ENOENT",
        syscall: "watch",
        path: "missing",
        filename: "missing",
        message: "ENOENT: no such file or directory, watch 'missing'",
      }),
    );
  });
});

describe("fs.promises.watch", () => {
  it("yields events and ends with an AbortError on abort", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const iterate = (async () => {
      for await (const event of fsPromises.watch("/work", { signal: controller.signal })) {
        seen.push(event);
        if (seen.length === 2) {
          controller.abort();
        }
      }
    })();
    await tick();
    expect(runtime.refCount).toBe(1);
    fs.writeFileSync("/work/p", "");
    fs.unlinkSync("/work/p");
    await expect(iterate).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(seen).toEqual([
      { eventType: "rename", filename: "p" },
      { eventType: "rename", filename: "p" },
    ]);
    expect(runtime.refCount).toBe(0);
  });

  it("validates before watching", async () => {
    const iterator = fsPromises.watch("/work", { recursive: "yes" as unknown as boolean });
    await expect(iterator.next()).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  });
});

describe("fs.watchFile", () => {
  it("polls with stat and reports changes, creation and deletion", async () => {
    const changes: [number, number][] = [];
    const listener = (current: nodeFs.Stats, previous: nodeFs.Stats) =>
      changes.push([current.size, previous.size]);
    fs.writeFileSync("/work/poll", "a");
    const watcher = fs.watchFile("/work/poll", { interval: 5 }, listener);
    expect(runtime.refCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync("/work/poll", "abc");
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.unlinkSync("/work/poll");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toEqual([
      [3, 1],
      [0, 3],
    ]);
    let stopped = false;
    watcher.on("stop", () => {
      stopped = true;
    });
    fs.unwatchFile("/work/poll", listener);
    expect(runtime.refCount).toBe(0);
    await tick();
    expect(stopped).toBe(true);
  });

  it("reports a missing file once with zeroed stats, then its creation", async () => {
    const changes: [number, number][] = [];
    fs.watchFile("/work/later", { interval: 5, persistent: false }, (current, previous) =>
      changes.push([current.mtimeMs, previous.mtimeMs]),
    );
    expect(runtime.refCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toEqual([[0, 0]]);
    fs.writeFileSync("/work/later", "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes.length).toBe(2);
    expect(changes[1][1]).toBe(0);
    fs.unwatchFile("/work/later");
  });

  it("shares one watcher per path and stops it when the last listener goes", () => {
    const a = () => {};
    const b = () => {};
    const first = fs.watchFile("/work", { interval: 1000 }, a);
    const second = fs.watchFile("/work", b);
    expect(second).toBe(first);
    fs.unwatchFile("/work", a);
    expect(first.listenerCount("change")).toBe(1);
    fs.unwatchFile("/work");
    expect(first.listenerCount("change")).toBe(0);
    expect(runtime.refCount).toBe(0);
  });
});

// Each order below is what real Node v26 prints for the same program: a
// listener logs itself, then queues a tick (">t") and a promise job (">p").
describe("when watchers emit, as Node's", () => {
  const order: string[] = [];
  let proc: ReturnType<typeof createProcess>;

  beforeEach(() => {
    proc = createProcess({ loadBuiltin: () => undefined, ipc: null });
    order.length = 0;
  });

  function mark(tag: string): void {
    order.push(tag);
    proc.nextTick(() => order.push(`${tag}>t`));
    void Promise.resolve().then(() => order.push(`${tag}>p`));
  }

  function callerQueues(): void {
    proc.nextTick(() => order.push("caller>t"));
    void Promise.resolve().then(() => order.push("caller>p"));
  }

  async function until(count: number): Promise<void> {
    for (let i = 0; i < 200 && order.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it("runs a 'change' listener as a macrotask: its ticks before its promise jobs", async () => {
    const watcher = fs.watch("/work", () => {
      if (order.length === 0) {
        mark("change");
      }
    });
    runMacrotask(() => fs.writeFileSync("/work/changed", "x"));
    await until(3);
    watcher.close();
    expect(order).toEqual(["change", "change>t", "change>p"]);
  });

  it("emits 'close' from a tick", async () => {
    const watcher = fs.watch("/work");
    watcher.on("close", () => mark("close"));
    runMacrotask(() => {
      watcher.close();
      callerQueues();
    });
    await until(5);
    expect(order).toEqual(["close", "caller>t", "close>t", "caller>p", "close>p"]);
  });

  it("closes for a signal already aborted from a tick, then emits 'close' from another", async () => {
    runMacrotask(() => {
      const controller = new AbortController();
      controller.abort();
      fs.watch("/work", { signal: controller.signal }).on("close", () => mark("close"));
      callerQueues();
    });
    await until(5);
    expect(order).toEqual(["caller>t", "close", "close>t", "caller>p", "close>p"]);
  });

  it("emits 'stop' from a tick", async () => {
    const listener = () => {};
    fs.watchFile("/work", { interval: 1000 }, listener).on("stop", () => mark("stop"));
    runMacrotask(() => {
      fs.unwatchFile("/work", listener);
      callerQueues();
    });
    await until(5);
    expect(order).toEqual(["stop", "caller>t", "stop>t", "caller>p", "stop>p"]);
  });

  it("polls in a macrotask: a 'change' listener's ticks run before its promise jobs", async () => {
    fs.writeFileSync("/work/polled", "a");
    fs.watchFile("/work/polled", { interval: 5 }, () => {
      mark("change");
      fs.unwatchFile("/work/polled");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync("/work/polled", "bb");
    await until(3);
    expect(order).toEqual(["change", "change>t", "change>p"]);
  });
});
