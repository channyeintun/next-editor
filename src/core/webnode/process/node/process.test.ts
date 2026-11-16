// @vitest-environment node
// The process object over the fake runtime: nextTick ordering against promise
// jobs, the IPC channel's ref()/unref(), and a broken pipe on stdout.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { createProcess, runNextTicks } from "./process";
import timers from "./timers";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

function fakeIpc(): MessagePort {
  return {
    onmessage: null,
    postMessage() {},
    close() {},
  } as unknown as MessagePort;
}

describe("nextTick", () => {
  it("runs before promise jobs queued earlier in the same timer callback", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      timers.setTimeout(() => {
        void Promise.resolve().then(() => order.push("promise"));
        process.nextTick(() => order.push("tick"));
        void Promise.resolve().then(resolve);
      }, 1);
    });
    expect(order).toEqual(["tick", "promise"]);
  });

  it("runs before promise jobs queued earlier in an immediate", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      timers.setImmediate(() => {
        void Promise.resolve().then(() => order.push("promise"));
        process.nextTick(() => order.push("tick"));
        void Promise.resolve().then(resolve);
      });
    });
    expect(order).toEqual(["tick", "promise"]);
  });

  it("still runs ticks queued from a promise job, in order", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: number[] = [];
    await Promise.resolve().then(() => {
      process.nextTick(() => {
        order.push(1);
        process.nextTick(() => order.push(3));
      });
      process.nextTick(() => order.push(2));
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([1, 2, 3]);
    // Nothing left to run.
    runNextTicks();
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps running the rest after a tick throws", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: number[] = [];
    process.nextTick(() => {
      throw new Error("boom");
    });
    process.nextTick(() => order.push(2));
    expect(() => runNextTicks()).toThrow("boom");
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([2]);
  });
});

describe("process.channel", () => {
  it("unref() stops a 'message' listener from keeping the process alive", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: fakeIpc() });
    const base = fake.refCount;
    const listener = () => {};
    process.on("message", listener);
    expect(fake.refCount).toBe(base + 1);
    const channel = process.channel as { ref(): void; unref(): void };
    expect(process.channel).toBe(channel);
    channel.unref();
    expect(fake.refCount).toBe(base);
    process.on("message", () => {});
    expect(fake.refCount).toBe(base);
    channel.ref();
    expect(fake.refCount).toBe(base + 1);
    process.removeAllListeners("message");
    expect(fake.refCount).toBe(base);
  });

  it("disconnect() releases the ref", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: fakeIpc() });
    const base = fake.refCount;
    process.on("message", () => {});
    expect(fake.refCount).toBe(base + 1);
    (process as unknown as { disconnect(): void }).disconnect();
    expect(fake.refCount).toBe(base);
    expect(process.channel).toBeUndefined();
  });
});

describe("stdout on a pipe", () => {
  it("emits EPIPE when the reader is gone", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    fake.fdStream.write = (_fd, _chunk, done) => {
      queueMicrotask(() =>
        done?.(Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" })),
      );
    };
    const errors: { code?: string }[] = [];
    process.stdout.on("error", (error: { code?: string }) => errors.push(error));
    process.stdout.write("x");
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.map((error) => error.code)).toEqual(["EPIPE"]);
  });
});
