// For the tests of the event loop: the scheduler evaluated afresh with the
// globals a browser worker has and Node (the test runner) lacks.
import { vi } from "vitest";
import { createFakeRuntime } from "../testing/fakeRuntime";

export interface Platform {
  reportError: (error: unknown) => void;
  scheduler?: unknown;
  /** More globals the modules see as they load (a browser worker's own). */
  globals?: Record<string, unknown>;
}

/**
 * eventLoop.ts, process.ts and timers.ts evaluated afresh with `platform`'s
 * globals, over a fake runtime of their own, with a process created.
 */
export async function withPlatform(platform: Platform) {
  const global = globalThis as Record<string, unknown>;
  const names = ["reportError", "scheduler", ...Object.keys(platform.globals ?? {})];
  const previous = new Map(names.map((name) => [name, global[name]]));
  Object.assign(global, {
    reportError: platform.reportError,
    scheduler: platform.scheduler,
    ...platform.globals,
  });
  vi.resetModules();
  try {
    const runtimeModule = await import("../runtime");
    const eventLoop = await import("./eventLoop");
    const processModule = await import("./process");
    const timersModule = await import("./timers");
    const runtime = createFakeRuntime();
    runtimeModule.setRuntime(runtime);
    const process = processModule.createProcess({ loadBuiltin: () => undefined, ipc: null });
    return { process, runtime, eventLoop, timers: timersModule.default };
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete global[name];
      } else {
        global[name] = value;
      }
    }
  }
}

/** A `scheduler.postTask` that only records its tasks: the test runs each when it chooses. */
export function recordingScheduler(): {
  posted: { callback: () => void; priority: string }[];
  scheduler: { postTask(callback: () => void, options: { priority: string }): Promise<void> };
} {
  const posted: { callback: () => void; priority: string }[] = [];
  return {
    posted,
    scheduler: {
      postTask(callback, options) {
        posted.push({ callback, priority: options.priority });
        return Promise.resolve();
      },
    },
  };
}

type MessageListener = (event: Event) => void;

/**
 * A MessageChannel that delivers as a browser does: each message in a task of
 * its own, and the promise jobs run after each listener (Node runs them only
 * after the last). Modules loaded inside `listening` capture prototype
 * methods that know these ports: its listeners are the ones added through
 * that `EventTarget.prototype.addEventListener`, a listener stops a message
 * through that `Event.prototype.stopImmediatePropagation`, and a message is
 * posted through that `MessagePort.prototype.postMessage`.
 */
export function browserChannels(): {
  MessageChannel: new () => { port1: EventTarget; port2: EventTarget };
  /** Runs `load` with the prototype methods above in place. */
  listening<T>(load: () => Promise<T>): Promise<T>;
  /** How many listeners the last message delivered ran. */
  listenersRun(): number;
} {
  const listeners = new WeakMap<object, MessageListener[]>();
  const stopped = new WeakSet<object>();
  let lastRun = 0;
  /** The delivery before the next one: a task is over before another begins. */
  let delivered: Promise<void> = Promise.resolve();

  class Port extends EventTarget {
    peer!: Port;
  }

  function post(port: Port, data: unknown): void {
    const target = port.peer;
    const posted = new Promise((resolve) => setTimeout(resolve, 0));
    delivered = Promise.all([delivered, posted]).then(() => deliver(target, data));
  }

  async function deliver(port: Port, data: unknown): Promise<void> {
    const event = new MessageEvent("message", { data });
    lastRun = 0;
    for (const listener of listeners.get(port) ?? []) {
      listener(event);
      lastRun += 1;
      if (stopped.has(event)) {
        break;
      }
      // Every promise job queued so far, and the ones those queue.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }

  return {
    MessageChannel: Channel,
    async listening(load) {
      const target = EventTarget.prototype as {
        addEventListener: typeof EventTarget.prototype.addEventListener;
      };
      const event = Event.prototype as {
        stopImmediatePropagation: typeof Event.prototype.stopImmediatePropagation;
      };
      const port = MessagePort.prototype as {
        postMessage: (this: unknown, message: unknown) => void;
        start: (this: unknown) => void;
      };
      const nativeAdd = target.addEventListener;
      const nativeStop = event.stopImmediatePropagation;
      const nativePost = port.postMessage;
      const nativeStart = port.start;
      port.postMessage = function (this: unknown, message: unknown) {
        if (this instanceof Port) {
          post(this, message);
        } else {
          nativePost.call(this, message);
        }
      };
      port.start = function (this: unknown) {
        if (!(this instanceof Port)) {
          nativeStart.call(this);
        }
      };
      target.addEventListener = function (this: EventTarget, type, listener, options) {
        if (this instanceof Port && type === "message") {
          const list = listeners.get(this) ?? [];
          listeners.set(this, list);
          list.push(listener as unknown as MessageListener);
          return;
        }
        nativeAdd.call(this, type, listener, options);
      };
      event.stopImmediatePropagation = function (this: Event) {
        stopped.add(this);
        nativeStop.call(this);
      };
      try {
        return await load();
      } finally {
        target.addEventListener = nativeAdd;
        event.stopImmediatePropagation = nativeStop;
        port.postMessage = nativePost;
        port.start = nativeStart;
      }
    },
    listenersRun: () => lastRun,
  };
}
