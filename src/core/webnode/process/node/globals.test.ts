// @vitest-environment node
// Liveness for the browser's own streaming work: iterating or piping a
// ReadableStream and an open WebSocket hold a ref until they finish. A
// WebSocket's events are macrotasks.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import {
  createRefedWebSocket,
  installAbortSignalTimeout,
  hideWorkerOnlyGlobals,
  installOwnGlobals,
  keepAliveWhileStreaming,
  processConsole,
} from "./globals";
import { createProcess } from "./process";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

/** A ReadableStream class of its own, so the patch does not touch the global one. */
class TestStream<T> extends ReadableStream<T> {}
keepAliveWhileStreaming(TestStream.prototype as ReadableStream);

function controlled(): {
  stream: TestStream<string>;
  controller: ReadableStreamDefaultController<string>;
} {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new TestStream<string>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("ReadableStream", () => {
  it("holds a ref while for-await waits for the next chunk", async () => {
    const { stream, controller } = controlled();
    const seen: string[] = [];
    const done = (async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
      }
    })();
    await turn();
    expect(fake.refCount).toBe(1);
    controller.enqueue("a");
    await turn();
    expect(seen).toEqual(["a"]);
    expect(fake.refCount).toBe(1);
    controller.close();
    await done;
    expect(fake.refCount).toBe(0);
  });

  it("holds a ref until pipeTo finishes", async () => {
    const { stream, controller } = controlled();
    const written: string[] = [];
    const piped = stream.pipeTo(new WritableStream({ write: (chunk) => void written.push(chunk) }));
    await turn();
    expect(fake.refCount).toBe(1);
    controller.enqueue("x");
    controller.close();
    await piped;
    expect(written).toEqual(["x"]);
    expect(fake.refCount).toBe(0);
  });

  it("holds a ref until pipeThrough's source is drained", async () => {
    const { stream, controller } = controlled();
    const upper = stream.pipeThrough(
      new TransformStream<string, string>({
        transform: (chunk, c) => c.enqueue(chunk.toUpperCase()),
      }),
    );
    await turn();
    expect(fake.refCount).toBe(1);
    controller.enqueue("y");
    controller.close();
    const reader = upper.getReader();
    expect((await reader.read()).value).toBe("Y");
    expect((await reader.read()).done).toBe(true);
    await turn();
    expect(fake.refCount).toBe(0);
  });

  it("throws as the spec says when pipeThrough's source is locked", () => {
    const { stream } = controlled();
    stream.getReader();
    expect(() => stream.pipeThrough(new TransformStream())).toThrow(TypeError);
    expect(fake.refCount).toBe(0);
  });
});

describe("WebSocket", () => {
  class FakeSocket extends EventTarget {
    readonly url: string;
    /** As the platform's: 1 once open, 2 after close(), 3 once closed. */
    readyState = 1;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
    }
    close(): void {
      this.readyState = 2;
    }
  }
  const RefedSocket = createRefedWebSocket(FakeSocket as unknown as typeof WebSocket);

  it("keeps the process alive from construction until close", () => {
    // A remote host: a local one is served inside the runtime (http/localWebSocket.ts).
    const socket = new RefedSocket("ws://example.com/");
    expect(socket).toBeInstanceOf(FakeSocket);
    expect(fake.refCount).toBe(1);
    socket.dispatchEvent(new Event("open"));
    expect(fake.refCount).toBe(1);
    socket.dispatchEvent(new Event("error"));
    socket.dispatchEvent(new Event("close"));
    socket.dispatchEvent(new Event("close"));
    expect(fake.refCount).toBe(0);
  });

  /** A socket with the platform's `on<event>` handler properties. */
  class HandlerSocket extends FakeSocket {}
  const handlers = new WeakMap<object, Map<string, EventListener | null>>();
  for (const type of ["open", "message", "error", "close"]) {
    Object.defineProperty(HandlerSocket.prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get(this: EventTarget) {
        return handlers.get(this)?.get(type) ?? null;
      },
      set(this: EventTarget, value: EventListener | null) {
        let own = handlers.get(this);
        if (own === undefined) {
          own = new Map();
          handlers.set(this, own);
        }
        const previous = own.get(type);
        if (previous) {
          EventTarget.prototype.removeEventListener.call(this, type, previous);
        }
        own.set(type, value);
        if (value) {
          EventTarget.prototype.addEventListener.call(this, type, value);
        }
      },
    });
  }
  const RefedHandlerSocket = createRefedWebSocket(HandlerSocket as unknown as typeof WebSocket);

  /** Delivers `event` as the platform does: not through the socket's own dispatchEvent. */
  const deliver = (socket: EventTarget, event: Event) =>
    EventTarget.prototype.dispatchEvent.call(socket, event);

  it("runs the ticks its listeners queue before their promise jobs", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const socket = new RefedHandlerSocket("ws://example.com/");
    const order: string[] = [];
    const listener = (event: Event) => {
      void Promise.resolve().then(() => order.push(`${event.type}>promise`));
      process.nextTick(() => order.push(`${event.type}>tick`));
      order.push(event.type);
    };
    socket.addEventListener("message", listener);
    socket.onopen = listener;
    expect(socket.onopen).toBe(listener);
    deliver(socket, new Event("open"));
    deliver(socket, new MessageEvent("message", { data: "x" }));
    expect(order).toEqual(["open", "open>tick", "message", "message>tick"]);
    await Promise.resolve();
    expect(order).toEqual([
      "open",
      "open>tick",
      "message",
      "message>tick",
      "open>promise",
      "message>promise",
    ]);
    socket.removeEventListener("message", listener);
    deliver(socket, new MessageEvent("message", { data: "y" }));
    expect(order).toHaveLength(6);
    deliver(socket, new Event("close"));
  });

  it("gives an event that waited behind ticks to no listener they removed, nor a message after close()", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const socket = new RefedHandlerSocket("ws://example.com/");
    const seen: string[] = [];
    const onError = () => seen.push("error");
    socket.addEventListener("error", onError);
    socket.onopen = () => seen.push("open");
    socket.onmessage = (event) => seen.push(`message ${String(event.data)}`);
    await Promise.resolve();
    // Queued from a promise job: it waits for the turn, and so do the events below.
    process.nextTick(() => {
      socket.removeEventListener("error", onError);
      socket.onopen = null;
      socket.close();
    });
    deliver(socket, new Event("error"));
    deliver(socket, new Event("open"));
    deliver(socket, new MessageEvent("message", { data: "x" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([]);
    deliver(socket, new Event("close"));
  });

  it("gives the messages that waited behind ticks to a socket its peer closed meanwhile, before 'close'", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const socket = new RefedHandlerSocket("ws://example.com/") as WebSocket & {
      readyState: number;
    };
    const seen: string[] = [];
    socket.onmessage = (event) => seen.push(`message ${String(event.data)}`);
    socket.addEventListener("close", () => seen.push("close"));
    await Promise.resolve();
    // Queued from a promise job: it waits for the turn, and so do the events below.
    process.nextTick(() => seen.push("tick"));
    // The server sent its last messages and its Close frame together: the
    // platform runs all three tasks before the turn.
    deliver(socket, new MessageEvent("message", { data: "m2" }));
    deliver(socket, new MessageEvent("message", { data: "m3" }));
    socket.readyState = 3;
    deliver(socket, new Event("close"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(["tick", "message m2", "message m3", "close"]);
  });

  it("runs the listeners of a program's own dispatchEvent at once, even while ticks wait", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const socket = new RefedSocket("ws://example.com/");
    const order: string[] = [];
    socket.addEventListener("message", () => order.push("listener"));
    await Promise.resolve();
    process.nextTick(() => order.push("tick"));
    socket.dispatchEvent(new Event("message"));
    order.push("after dispatch");
    expect(order).toEqual(["listener", "after dispatch"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["listener", "after dispatch", "tick"]);
    socket.dispatchEvent(new Event("close"));
  });
});

describe("the globals Node owns", () => {
  it("defines queueMicrotask, structuredClone and performance on the global object itself", async () => {
    const global: Record<string, unknown> = {};
    installOwnGlobals(global);
    // The descriptors real Node v26 has for the three.
    expect(Object.getOwnPropertyDescriptor(global, "queueMicrotask")).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(global, "structuredClone")).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const performance = Object.getOwnPropertyDescriptor(global, "performance")!;
    expect([typeof performance.get, typeof performance.set]).toEqual(["function", "function"]);
    expect(performance).toMatchObject({ enumerable: true, configurable: true });
    expect(global.performance).toBe(globalThis.performance);

    const queue = global.queueMicrotask as (callback: unknown) => void;
    expect([queue.name, queue.length]).toEqual(["queueMicrotask", 1]);
    expect(() => queue(1)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    const order: string[] = [];
    queue(() => order.push("microtask"));
    order.push("sync");
    await Promise.resolve();
    expect(order).toEqual(["sync", "microtask"]);

    const clone = global.structuredClone as (value: unknown) => unknown;
    const value = { list: [1, new Date(5)] };
    expect(clone(value)).toEqual(value);
    expect(clone(value)).not.toBe(value);

    // Assigning to `performance` replaces it, as in Node.
    const replacement = { now: () => 0 };
    global.performance = replacement;
    expect(global.performance).toBe(replacement);
    expect(Object.getOwnPropertyDescriptor(global, "performance")).toMatchObject({
      value: replacement,
      writable: true,
    });
  });
});

describe("AbortSignal.timeout", () => {
  it("aborts from one of Node's timers, which does not hold the process, as Node's does", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const saved = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    installAbortSignalTimeout();
    try {
      expect(() => AbortSignal.timeout(1.5)).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
      );
      const signal = AbortSignal.timeout(1);
      expect(fake.refCount).toBe(0);
      const order: string[] = [];
      signal.addEventListener("abort", () => {
        order.push(`abort ${(signal.reason as DOMException).name}`);
        process.nextTick(() => order.push("tick"));
        void Promise.resolve().then(() => order.push("promise"));
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(["abort TimeoutError", "tick", "promise"]);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", saved);
    }
  });
});

describe("the global console", () => {
  it("binds process.stdout on its first write, and keeps a closed pipe's EPIPE quiet as Node's does", async () => {
    // Real Node v26: `node -e "…3× console.log…; stderr.write('alive')" | true` prints only 'alive', status 0.
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const console = processConsole(process);
    fake.closeReader(1);
    const stdout = process.stdout as unknown as {
      emit(name: string, ...args: unknown[]): boolean;
      listenerCount(name: string): number;
    };
    const errors: string[] = [];
    const emit = stdout.emit;
    stdout.emit = function (name, ...args) {
      if (name === "error") {
        const listening = this.listenerCount("error");
        errors.push(`error (${listening} listening)`);
        if (listening === 0) {
          // It would be uncaught.
          return false;
        }
      }
      return emit.call(this, name, ...args);
    };
    for (let line = 0; line < 3; line++) {
      console.log(`line ${line}`);
    }
    process.stderr.write("alive\n");
    // The error comes from the event loop, in a timer's task.
    for (let i = 0; i < 500 && errors.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(errors).toEqual(["error (1 listening)"]);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(fake.stderr()).toBe("alive\n");
  });

  it("does not make process.stdout before it writes", () => {
    let made = 0;
    const process = {
      get stdout() {
        made++;
        return null;
      },
      get stderr() {
        made++;
        return null;
      },
    };
    processConsole(process as never);
    expect(made).toBe(0);
  });
});

describe("the globals a browser worker has on its scope's prototypes", () => {
  /** A worker's global object: what the browser defines lives on its prototype. */
  function workerScope(own: Record<string, unknown>): Record<string, unknown> {
    const scopePrototype = Object.create(EventTarget.prototype) as Record<string, unknown>;
    Object.assign(scopePrototype, own);
    return Object.create(scopePrototype) as Record<string, unknown>;
  }

  it("takes the worker's own globals off the scope altogether", () => {
    const scope = workerScope({ requestAnimationFrame: () => 1, importScripts: () => {} });
    Object.defineProperty(scope, "self", { value: scope, configurable: true });
    hideWorkerOnlyGlobals(scope);
    expect(["requestAnimationFrame", "importScripts", "self"].map((name) => name in scope)).toEqual(
      [false, false, false],
    );
  });

  it("reads a worker global the scope keeps as undefined", () => {
    const scope = workerScope({});
    Object.defineProperty(Object.getPrototypeOf(scope), "cancelAnimationFrame", {
      value: () => {},
      configurable: false,
    });
    hideWorkerOnlyGlobals(scope);
    expect(scope.cancelAnimationFrame).toBeUndefined();
  });

  it("leaves nothing behind when a program deletes structuredClone or crypto, as in Node", () => {
    const scope = workerScope({ structuredClone: () => "platform's", crypto: { platform: true } });
    installOwnGlobals(scope);
    const crypto = Object.getOwnPropertyDescriptor(scope, "crypto")!;
    // The descriptor real Node v26 has: an accessor with no setter.
    expect([typeof crypto.get, typeof crypto.set]).toEqual(["function", "undefined"]);
    expect(crypto).toMatchObject({ enumerable: true, configurable: true });
    expect(scope.crypto).toBe(globalThis.crypto);
    delete scope.structuredClone;
    delete scope.crypto;
    expect(["structuredClone" in scope, "crypto" in scope]).toEqual([false, false]);
  });
});
