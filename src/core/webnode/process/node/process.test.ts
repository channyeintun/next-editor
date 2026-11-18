// @vitest-environment node
// The process object over the fake runtime: nextTick ordering against promise
// jobs, the IPC channel's ref()/unref(), and a broken pipe on stdout.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, FakeExit, type FakeRuntime } from "../testing/fakeRuntime";
import { createConsole } from "./console";
import { runMacrotask, runNextTicks } from "./eventLoop";
import { withPlatform } from "./eventLoop.testkit";
import { createProcess, emitExitForUncaughtError } from "./process";
import { kernelSignalName, nodeSignalNumber } from "./signalNames";
import timers from "./timers";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

/** The IPC channels a test opened: the process's end is `port1`, its parent's `port2`. */
const channels: MessageChannel[] = [];

afterEach(() => {
  setRuntime(null);
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

function ipcChannel(): MessageChannel {
  const channel = new MessageChannel();
  channels.push(channel);
  return channel;
}

function fakeIpc(): MessagePort {
  return ipcChannel().port1;
}

/** Lets the event loop turn until `done()` holds: a waiting tick runs in a task of its own. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("nextTick", () => {
  it("queued from a promise job, runs after the promise jobs queued after it", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    timers.setTimeout(() => {
      void Promise.resolve().then(() => {
        process.nextTick(() => order.push("tick"));
        void Promise.resolve().then(() => order.push("p"));
      });
    }, 1);
    await until(() => order.length === 2);
    expect(order).toEqual(["p", "tick"]);
  });

  it("runs ticks, then promise jobs, until both are empty, as Node does", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    timers.setTimeout(() => {
      process.nextTick(() => order.push("t1"));
      void Promise.resolve().then(() => {
        order.push("p1");
        process.nextTick(() => order.push("p1>t"));
        void Promise.resolve().then(() => order.push("p1>p"));
      });
      queueMicrotask(() => {
        order.push("q1");
        process.nextTick(() => order.push("q1>t"));
      });
      process.nextTick(() => {
        order.push("t2");
        void Promise.resolve().then(() => order.push("t2>p"));
        process.nextTick(() => order.push("t2>t"));
      });
      order.push("sync");
    }, 1);
    await until(() => order.length === 10);
    // The order real Node v26 prints for the same callback.
    expect(order).toEqual(["sync", "t1", "t2", "t2>t", "p1", "q1", "t2>p", "p1>p", "p1>t", "q1>t"]);
  });

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
    await until(() => order.length === 3);
    expect(order).toEqual([1, 2, 3]);
    // Nothing left to run.
    runNextTicks();
    expect(order).toEqual([1, 2, 3]);
  });

  // Node has no scheduler.postTask: this is the MessageChannel turn, which has no priority.
  it("holds the process open while a tick waits for a turn without priority", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const base = fake.refCount;
    let ran = false;
    await Promise.resolve().then(() => process.nextTick(() => (ran = true)));
    expect(fake.refCount).toBe(base + 1);
    await until(() => ran);
    expect(fake.refCount).toBe(base);
  });

  it("lets a macrotask that arrives while ticks wait run after them and their promise jobs", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    await Promise.resolve();
    // Queued outside any macrotask: Node would run it, and its promise job,
    // before the next macrotask.
    process.nextTick(() => {
      order.push("tick");
      void Promise.resolve().then(() => order.push("tick>p"));
    });
    runMacrotask(() => order.push("first macrotask"));
    runMacrotask(() => order.push("second macrotask"));
    expect(order).toEqual(["tick"]);
    await until(() => order.length === 4);
    expect(order).toEqual(["tick", "tick>p", "first macrotask", "second macrotask"]);
  });

  it("runs a nested macrotask as part of the outer one", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    runMacrotask(() => {
      process.nextTick(() => order.push("tick"));
      runMacrotask(() => order.push("inner"));
      order.push("outer");
    });
    expect(order).toEqual(["inner", "outer", "tick"]);
  });

  it("keeps running the rest after a tick throws", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: number[] = [];
    process.nextTick(() => {
      throw new Error("boom");
    });
    process.nextTick(() => order.push(2));
    // Without the platform's reportError the error propagates; the rest wait for a turn.
    expect(() => runNextTicks()).toThrow("boom");
    await until(() => order.length === 1);
    expect(order).toEqual([2]);
  });
});

describe("nextTick with the browser's reportError and scheduler", () => {
  const withReportError = (reportError: (error: unknown) => void) => withPlatform({ reportError });

  it("posts a waiting tick's turn at user-blocking priority, holding nothing", async () => {
    const posted: { callback: () => void; priority: string }[] = [];
    const fresh = await withPlatform({
      reportError: () => {},
      scheduler: {
        postTask(callback: () => void, options: { priority: string }) {
          posted.push({ callback, priority: options.priority });
          return Promise.resolve();
        },
      },
    });
    const base = fresh.runtime.refCount;
    const order: string[] = [];
    await Promise.resolve();
    fresh.process.nextTick(() => order.push("t1"));
    fresh.process.nextTick(() => {
      order.push("t2");
      void Promise.resolve().then(() =>
        fresh.process.nextTick(() => {
          order.push("t2>p>t");
          void Promise.resolve().then(() => order.push("t2>p>t>p"));
        }),
      );
    });
    expect(posted.map((task) => task.priority)).toEqual(["user-blocking"]);
    // It runs ahead of every other task, the exit check included: no hold needed.
    expect(fresh.runtime.refCount).toBe(base);
    posted[0].callback();
    expect(order).toEqual(["t1", "t2"]);
    expect(fresh.runtime.refCount).toBe(base);
    // A tick its promise jobs queue continues the turn in a message, not in
    // another task at priority; the message holds the process until it comes.
    await Promise.resolve();
    expect(fresh.runtime.refCount).toBe(base + 1);
    await until(() => order.length === 4 && fresh.runtime.refCount === base);
    expect(order).toEqual(["t1", "t2", "t2>p>t", "t2>p>t>p"]);
    expect(fresh.runtime.refCount).toBe(base);
    expect(posted).toHaveLength(1);
  });

  it("reports a timer callback's error first, then runs its ticks before promise jobs", async () => {
    const order: string[] = [];
    const fresh = await withReportError((error) =>
      order.push(`reported:${(error as Error).message}`),
    );
    fresh.timers.setTimeout(() => {
      void Promise.resolve().then(() => order.push("promise"));
      fresh.process.nextTick(() => order.push("tick"));
      throw new Error("timer");
    }, 1);
    await until(() => order.length === 3);
    expect(order).toEqual(["reported:timer", "tick", "promise"]);
  });

  it("reports a tick's error and goes on with the next tick before promise jobs", async () => {
    const order: string[] = [];
    const fresh = await withReportError((error) =>
      order.push(`reported:${(error as Error).message}`),
    );
    fresh.eventLoop.runMacrotask(() => {
      void Promise.resolve().then(() => order.push("promise"));
      fresh.process.nextTick(() => {
        throw new Error("tick");
      });
      fresh.process.nextTick(() => order.push("t2"));
    });
    expect(order).toEqual(["reported:tick", "t2"]);
    await Promise.resolve();
    expect(order).toEqual(["reported:tick", "t2", "promise"]);
  });

  it("keeps running ticks after the program replaced MessageChannel", async () => {
    const fresh = await withReportError((error) => {
      throw error;
    });
    const saved = globalThis.MessageChannel;
    (globalThis as { MessageChannel?: unknown }).MessageChannel = undefined;
    const order: string[] = [];
    try {
      await Promise.resolve();
      // Two rounds: the second continues the turn in a message.
      fresh.process.nextTick(() =>
        Promise.resolve().then(() => fresh.process.nextTick(() => order.push("second tick"))),
      );
      await until(() => order.length === 1);
    } finally {
      globalThis.MessageChannel = saved;
    }
    expect(order).toEqual(["second tick"]);
  });

  it("runs afterTurn's callback once every round of the turn is done", async () => {
    const fresh = await withReportError(() => {});
    const order: string[] = [];
    await Promise.resolve();
    fresh.process.nextTick(() => {
      order.push("t");
      void Promise.resolve().then(() =>
        fresh.process.nextTick(() => {
          order.push("t>p>t");
          void Promise.resolve().then(() => order.push("t>p>t>p"));
        }),
      );
    });
    fresh.eventLoop.afterTurn(() => order.push("after"));
    await until(() => order.includes("after"));
    expect(order).toEqual(["t", "t>p>t", "t>p>t>p", "after"]);
  });

  describe("unhandled rejections", () => {
    /** What the browser gives listeners of 'unhandledrejection' and 'rejectionhandled'. */
    class FakeRejectionEvent extends Event {
      readonly promise: Promise<unknown>;
      readonly reason: unknown;
      constructor(
        type: string,
        init: { promise: Promise<unknown>; reason: unknown; cancelable?: boolean },
      ) {
        super(type, { cancelable: init.cancelable });
        this.promise = init.promise;
        this.reason = init.reason;
      }
    }

    /** A worker's global with process.ts loaded, and a listener as the `node` program's. */
    async function withRejections() {
      const global = new EventTarget();
      const fresh = await withPlatform({
        reportError: (error) => {
          throw error;
        },
        globals: {
          addEventListener: global.addEventListener.bind(global),
          dispatchEvent: global.dispatchEvent.bind(global),
          PromiseRejectionEvent: FakeRejectionEvent,
        },
      });
      const order: string[] = [];
      global.addEventListener("unhandledrejection", (event) => {
        event.preventDefault();
        const { reason } = event as FakeRejectionEvent;
        order.push(`unhandled ${String(reason)}`);
        fresh.process.nextTick(() => order.push(`${String(reason)}>t`));
        void Promise.resolve().then(() => order.push(`${String(reason)}>p`));
      });
      global.addEventListener("rejectionhandled", (event) =>
        order.push(`handled ${String((event as FakeRejectionEvent).reason)}`),
      );
      /** The browser reports `reason`'s promise as unhandled, or as handled after that. */
      const report = (type: "unhandledrejection" | "rejectionhandled", promise: Promise<unknown>) =>
        global.dispatchEvent(
          new FakeRejectionEvent(type, {
            promise,
            reason: promises.get(promise),
            cancelable: true,
          }),
        );
      const promises = new Map<Promise<unknown>, string>();
      const rejected = (reason: string) => {
        // Handled here, so that the test runner does not see it.
        const promise = Promise.reject(new Error(reason));
        promise.catch(() => {});
        promises.set(promise, reason);
        return promise;
      };
      return { ...fresh, order, report, rejected };
    }

    it("reports one as a macrotask: the ticks of its listeners run before their promise jobs", async () => {
      const { order, report, rejected } = await withRejections();
      report("unhandledrejection", rejected("a"));
      expect(order).toEqual(["unhandled a", "a>t"]);
      await Promise.resolve();
      expect(order).toEqual(["unhandled a", "a>t", "a>p"]);
    });

    it("holds one reported while a turn runs, and drops it if handled before the turn is over", async () => {
      const { process, runtime, order, report, rejected } = await withRejections();
      const base = runtime.refCount;
      const early = rejected("early");
      const handled = rejected("handled");
      await Promise.resolve();
      process.nextTick(() =>
        Promise.resolve().then(() => process.nextTick(() => order.push("second round"))),
      );
      // The browser reports both between two rounds of the turn.
      report("unhandledrejection", early);
      report("unhandledrejection", handled);
      expect(order).toEqual([]);
      // Nothing may exit before they are reported.
      expect(runtime.refCount).toBeGreaterThan(base);
      // A later round handles one: the browser says so in a task of its own.
      report("rejectionhandled", handled);
      await until(() => order.length > 1 && runtime.refCount === base);
      expect(order).toEqual(["second round", "unhandled early", "early>t", "early>p"]);
    });

    it("reports a rejection handled after it was reported as a macrotask too", async () => {
      const { order, report, rejected } = await withRejections();
      const late = rejected("late");
      report("unhandledrejection", late);
      await Promise.resolve();
      report("rejectionhandled", late);
      expect(order).toEqual(["unhandled late", "late>t", "late>p", "handled late"]);
    });
  });
});

describe("process.emitWarning", () => {
  const HINT = "(Use `node --trace-warnings ...` to show where the warning was created)\n";

  // Real Node v26 prints, for process.emitWarning("first"), then
  // emitWarning("old", { type: "DeprecationWarning", code: "DEP0", detail: "more" }):
  //   (node:N) Warning: first
  //   (Use `node --trace-warnings ...` to show where the warning was created)
  //   (node:N) [DEP0] DeprecationWarning: old
  //   more
  it("prints Node's text: the hint after the first warning only, and a warning's detail", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const warn = process.emitWarning as (warning: string, options?: object) => void;
    runMacrotask(() => warn("first"));
    runMacrotask(() => warn("old", { type: "DeprecationWarning", code: "DEP0", detail: "more" }));
    expect(fake.stderr()).toBe(
      `(node:${fake.pid}) Warning: first\n${HINT}(node:${fake.pid}) [DEP0] DeprecationWarning: old\nmore\n`,
    );
  });

  it("names the deprecation flag when the first warning is a deprecation", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    runMacrotask(() => process.emitWarning("old", "DeprecationWarning"));
    expect(fake.stderr()).toBe(
      `(node:${fake.pid}) DeprecationWarning: old\n` +
        "(Use `node --trace-deprecation ...` to show where the warning was created)\n",
    );
  });

  it("prints from the process's own 'warning' listener, the first one: before a program's", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const seen: string[] = [];
    process.on("warning", (warning: Error) =>
      seen.push(`${warning.name}, with ${JSON.stringify(fake.stderr())} printed`),
    );
    // In a macrotask: the tick emitWarning defers with runs as it returns.
    runMacrotask(() => process.emitWarning("careful", "CustomWarning", "W001"));
    // The first warning also says how to find where it came from.
    const line = `(node:${fake.pid}) [W001] CustomWarning: careful\n${HINT}`;
    expect(seen).toEqual([`CustomWarning, with ${JSON.stringify(line)} printed`]);
    // A program that removes every listener silences warnings, as in Node.
    process.removeAllListeners("warning");
    runMacrotask(() => process.emitWarning("quiet"));
    expect(fake.stderr()).toBe(line);
  });

  // Real Node v26: `(node w.js; echo $?) 2>&1 >/dev/null | true` with a
  // warning emitted after the reader has gone exits 0 (warn.js in the
  // conformance case process-broken-stderr.cjs).
  it("keeps a warning it cannot print to itself, as Node's console-backed writer does", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    fake.closeReader(2);
    const errors: string[] = [];
    const stderr = process.stderr as unknown as {
      emit(name: string, ...args: unknown[]): boolean;
      listenerCount(name: string): number;
    };
    const emit = stderr.emit;
    stderr.emit = function (name, ...args) {
      if (name === "error") {
        errors.push(`error (${this.listenerCount("error")} listening)`);
        if (this.listenerCount("error") === 0) {
          // It would be uncaught, and end the process.
          return false;
        }
      }
      return emit.call(this, name, ...args);
    };
    const seen: string[] = [];
    process.on("warning", (warning: Error) => seen.push(warning.message));
    runMacrotask(() => process.emitWarning("late"));
    await until(() => errors.length > 0);
    await until(() => false);
    expect(seen).toEqual(["late"]);
    expect(errors).toEqual(["error (1 listening)"]);
    expect(stderr.listenerCount("error")).toBe(0);
  });

  it("prints a warning's text as it is, whatever it holds", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    runMacrotask(() => process.emitWarning("100%s sure %d%%"));
    expect(fake.stderr()).toBe(`(node:${fake.pid}) Warning: 100%s sure %d%%\n${HINT}`);
  });

  it("prints nothing under --no-warnings, and still emits 'warning'", () => {
    fake.execArgv = ["--no-warnings"];
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect(process.listenerCount("warning")).toBe(0);
    const seen: string[] = [];
    process.on("warning", (warning: Error) => seen.push(warning.message));
    runMacrotask(() => process.emitWarning("careful"));
    expect(seen).toEqual(["careful"]);
    expect(fake.stderr()).toBe("");
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

  it("disconnect() releases the ref", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: fakeIpc() });
    const base = fake.refCount;
    process.on("message", () => {});
    expect(fake.refCount).toBe(base + 1);
    let disconnected = false;
    process.on("disconnect", () => (disconnected = true));
    (process as unknown as { disconnect(): void }).disconnect();
    // As in Node: the channel is null once disconnected, and `connected` false.
    expect([process.channel, process.connected]).toEqual([null, false]);
    // 'disconnect' is emitted from a tick, whose turn holds the process until it ends.
    await until(() => fake.refCount === base);
    expect(fake.refCount).toBe(base);
    expect(disconnected).toBe(true);
  });
});

describe("a process without an IPC channel", () => {
  // Real Node: `node -e "console.log(typeof process.send, process.connected,
  // typeof process.disconnect, process.channel)"` prints four times undefined.
  // Programs tell by `if (process.send)` whether they have a parent to report to.
  it("has no send, disconnect, connected or channel, as in Node", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect(
      ["send", "disconnect", "connected", "channel"].map((name) => [
        name,
        typeof process[name],
        name in process,
      ]),
    ).toEqual([
      ["send", "undefined", false],
      ["disconnect", "undefined", false],
      ["connected", "undefined", false],
      ["channel", "undefined", false],
    ]);
    // A 'message' listener holds nothing open.
    const base = fake.refCount;
    process.on("message", () => {});
    expect(fake.refCount).toBe(base);
  });
});

describe("process.send and process.disconnect on a closed channel", () => {
  it("report as Node's do: send answers false and fails later, a second disconnect is an 'error'", async () => {
    const posted: unknown[] = [];
    const { port1: ipc, port2: parent } = ipcChannel();
    parent.onmessage = (event) => posted.push(event.data);
    const process = createProcess({ loadBuiltin: () => undefined, ipc });
    const send = process.send as (message: unknown, callback?: (error: unknown) => void) => boolean;
    const disconnect = process.disconnect as () => void;
    expect([typeof send, typeof disconnect, process.connected, typeof process.channel]).toEqual([
      "function",
      "function",
      true,
      "object",
    ]);
    const seen: string[] = [];
    process.on("error", (error: { code?: string }) => seen.push(`error ${error.code}`));
    runMacrotask(() => {
      expect(send.call(process, "one")).toBe(true);
      disconnect.call(process);
      expect(send.call(process, "late")).toBe(false);
      seen.push("send returned");
      expect(
        send.call(process, "late", (error) =>
          seen.push(`callback ${(error as { code?: string }).code}`),
        ),
      ).toBe(false);
      // Node emits this one at once.
      disconnect.call(process);
      seen.push("disconnect returned");
    });
    await until(() => seen.length >= 5 && posted.length >= 2);
    expect(seen).toEqual([
      "send returned",
      "error ERR_IPC_DISCONNECTED",
      "disconnect returned",
      "error ERR_IPC_CHANNEL_CLOSED",
      "callback ERR_IPC_CHANNEL_CLOSED",
    ]);
    expect(posted).toEqual([{ type: "message", message: "one" }, { type: "disconnect" }]);
  });
});

describe("signal names", () => {
  // Node takes any name os.constants.signals has (aliases too) and any of
  // their numbers; the kernel is given the signal's own name.
  const name = (signal: string | number) => {
    try {
      return kernelSignalName(signal);
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };

  it("knows every Linux signal Node knows, by name and by number", () => {
    expect([name("SIGTERM"), name("SIGXCPU"), name("SIGSTKFLT"), name("SIGPWR")]).toEqual([
      "SIGTERM",
      "SIGXCPU",
      "SIGSTKFLT",
      "SIGPWR",
    ]);
    expect([name(24), name(9), name(31), name(0), name(undefined as never)]).toEqual([
      "SIGXCPU",
      "SIGKILL",
      "SIGSYS",
      "0",
      "SIGTERM",
    ]);
    expect([name("SIGIOT"), name("SIGPOLL")]).toEqual(["SIGABRT", "SIGIO"]);
    expect([
      nodeSignalNumber("SIGXCPU"),
      nodeSignalNumber("SIGIOT"),
      nodeSignalNumber("nope"),
    ]).toEqual([24, 6, 0]);
  });

  it("refuses what is no signal, even a name every object has", () => {
    expect([name("SIGFOO"), name("constructor"), name("toString"), name(64)]).toEqual([
      "ERR_UNKNOWN_SIGNAL",
      "ERR_UNKNOWN_SIGNAL",
      "ERR_UNKNOWN_SIGNAL",
      "ERR_UNKNOWN_SIGNAL",
    ]);
    expect(nodeSignalNumber("constructor")).toBe(0);
  });
});

describe("signal listeners", () => {
  /** A process whose handled signals, as it publishes them to the kernel, are recorded. */
  function listening(): { process: ReturnType<typeof createProcess>; handled: () => string[] } {
    let published: string[] = [];
    fake.processes.setHandledSignals = (signals) => {
      published = [...signals].sort();
    };
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    return { process, handled: () => published };
  }

  // Real Node v26: `process.on('SIGIOT', h); process.kill(process.pid, 'SIGIOT')`
  // prints "handler for SIGIOT got SIGIOT 6" and the process lives.
  it("run under any name Node has for the signal: SIGIOT is SIGABRT, SIGPOLL is SIGIO", () => {
    const { process, handled } = listening();
    const seen: string[] = [];
    const note = (signal: string, number: number) => seen.push(`${signal} ${number}`);
    process.on("SIGIOT", note);
    process.on("SIGPOLL", note);
    // The kernel knows each signal by one name, and is told it is handled.
    expect(handled()).toEqual(["SIGABRT", "SIGIO", "SIGPIPE"]);
    (process.kill as (pid: number, signal: string) => boolean)(fake.pid, "SIGIOT");
    fake.signal("SIGIO");
    expect(seen).toEqual(["SIGIOT 6", "SIGPOLL 29"]);
    expect(fake.exitCode).toBeNull();
  });

  it("each name with listeners gets the signal, and the last listener of them all hands it back", () => {
    const { process, handled } = listening();
    const seen: string[] = [];
    const abrt = (signal: string) => seen.push(`as SIGABRT: ${signal}`);
    const iot = (signal: string) => seen.push(`as SIGIOT: ${signal}`);
    process.on("SIGABRT", abrt);
    process.on("SIGIOT", iot);
    fake.signal("SIGABRT");
    expect(seen).toEqual(["as SIGABRT: SIGABRT", "as SIGIOT: SIGIOT"]);
    process.removeListener("SIGABRT", abrt);
    // Still handled: the other name has a listener.
    expect(handled()).toEqual(["SIGABRT", "SIGPIPE"]);
    fake.signal("SIGABRT");
    expect(seen.slice(2)).toEqual(["as SIGIOT: SIGIOT"]);
    process.removeListener("SIGIOT", iot);
    expect(handled()).toEqual(["SIGPIPE"]);
    // With no listener left the signal has its default action.
    fake.signal("SIGABRT");
    expect(fake.exitCode).toBe(134);
  });
});

describe("process.kill", () => {
  const attempt = (process: ReturnType<typeof createProcess>, pid: unknown, signal?: unknown) => {
    try {
      return (process.kill as (pid: unknown, signal?: unknown) => boolean)(pid, signal);
    } catch (error) {
      const { name, message, code, errno, syscall } = error as NodeJS.ErrnoException;
      return { name, message, code, errno, syscall };
    }
  };

  // Real Node v26: `kill ESRCH`, code ESRCH, errno -3, syscall kill.
  it("fails as Node's does for a process that is not there, a signal it does not know, a pid that is no number", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect(attempt(process, 99999)).toEqual({
      name: "Error",
      message: "kill ESRCH",
      code: "ESRCH",
      errno: -3,
      syscall: "kill",
    });
    expect(attempt(process, fake.pid, "SIGNOPE")).toMatchObject({
      name: "TypeError",
      message: "Unknown signal: SIGNOPE",
      code: "ERR_UNKNOWN_SIGNAL",
    });
    expect(attempt(process, "x")).toMatchObject({
      name: "TypeError",
      code: "ERR_INVALID_ARG_TYPE",
      message: "The \"pid\" argument must be of type number. Received type string ('x')",
    });
    expect(attempt(process, 1.5)).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect(attempt(process, fake.pid, 0)).toBe(true);
  });

  it("passes a negative pid on as the process group it names", () => {
    const asked: [number, string][] = [];
    fake.processes.kill = (pid, signal) => void asked.push([pid, signal]);
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect([
      attempt(process, -42, "SIGTERM"),
      attempt(process, 0),
      attempt(process, "7", 9),
    ]).toEqual([true, true, true]);
    expect(asked).toEqual([
      [-42, "SIGTERM"],
      [0, "SIGTERM"],
      [7, "SIGKILL"],
    ]);
  });
});

describe("process.chdir", () => {
  // Real Node v26: "EACCES: permission denied, chdir '<cwd>' -> 'nx'", with
  // syscall 'chdir', path the working directory and dest as given.
  function attempt(process: ReturnType<typeof createProcess>, directory: unknown): unknown {
    try {
      (process.chdir as (directory: unknown) => void)(directory);
      return { cwd: (process.cwd as () => string)(), PWD: process.env.PWD };
    } catch (error) {
      const { code, syscall, path, dest, message } = error as NodeJS.ErrnoException & {
        dest?: string;
      };
      return { code, syscall, path, dest, message };
    }
  }

  it("needs search permission on the directory and on the way to it, as chdir(2) does", () => {
    fake = createFakeRuntime({ cwd: "/work" });
    setRuntime(fake);
    fake.vfs.mkdir("/work/nx/inner", true, 0o755);
    fake.vfs.mkdir("/work/ok", true, 0o755);
    fake.vfs.chmod("/work/nx", 0o600, true);
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect(attempt(process, "nx")).toEqual({
      code: "EACCES",
      syscall: "chdir",
      path: "/work",
      dest: "nx",
      message: "EACCES: permission denied, chdir '/work' -> 'nx'",
    });
    expect(attempt(process, "nx/inner")).toMatchObject({
      code: "EACCES",
      message: "EACCES: permission denied, chdir '/work' -> 'nx/inner'",
    });
    expect(attempt(process, "missing")).toMatchObject({
      code: "ENOENT",
      message: "ENOENT: no such file or directory, chdir '/work' -> 'missing'",
    });
    expect((process.cwd as () => string)()).toBe("/work");
    expect(attempt(process, "ok")).toEqual({ cwd: "/work/ok", PWD: undefined });
  });

  // Real Node v26: process.chdir('') throws "ENOENT: no such file or
  // directory, chdir '<cwd>' -> ''"; after chdir through a link process.cwd()
  // is the directory the link leads to, and process.env.PWD is what it was.
  it("refuses an empty path, and leaves the process in the directory itself and env.PWD alone", () => {
    fake = createFakeRuntime({ cwd: "/work", env: { PWD: "/work" } });
    setRuntime(fake);
    fake.vfs.mkdir("/work/d/sub", true, 0o755);
    fake.vfs.symlink("d/sub", "/work/link");
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect(attempt(process, "")).toEqual({
      code: "ENOENT",
      syscall: "chdir",
      path: "/work",
      dest: "",
      message: "ENOENT: no such file or directory, chdir '/work' -> ''",
    });
    expect(attempt(process, "link")).toEqual({ cwd: "/work/d/sub", PWD: "/work" });
    expect(fake.cwd).toBe("/work/d/sub");
    expect(attempt(process, "..")).toEqual({ cwd: "/work/d", PWD: "/work" });
    expect(attempt(process, 5)).toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
      message: 'The "directory" argument must be of type string. Received type number (5)',
    });
  });

  // Real Node v26, in a Worker: "process.chdir() is not supported in workers".
  it("is refused in a worker thread: the directory is the whole process's", () => {
    fake = createFakeRuntime({ cwd: "/work" });
    fake.vfs.mkdir("/work/wd", true, 0o755);
    const thread = Object.create(fake, {
      threads: { value: { ...fake.threads, isMainThread: false } },
    }) as FakeRuntime;
    setRuntime(thread);
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    expect(attempt(process, "wd")).toMatchObject({
      code: "ERR_WORKER_UNSUPPORTED_OPERATION",
      message: "process.chdir() is not supported in workers",
    });
    expect(fake.cwd).toBe("/work");
  });
});

describe("process.umask", () => {
  type Umask = (mask?: unknown) => number;
  const perm = (path: string) => fake.vfs.stat(path, false).mode & 0o7777;

  function attempt(umask: Umask, mask: unknown): unknown {
    try {
      return umask(mask);
    } catch (error) {
      const { code, name, message } = error as NodeJS.ErrnoException;
      return { code, name, message };
    }
  }

  // Real Node v26 and v22: process.umask() is 0o22 at first; process.umask(0o077)
  // returns 0o22, after which process.umask() is 0o77 and a file made with
  // mode 0o666 is 0600, a directory 0700.
  it("reads the mask with no argument, sets it and returns the one before with one", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const umask = process.umask as Umask;
    expect(umask()).toBe(0o022);
    expect(umask(0o077)).toBe(0o022);
    expect(umask()).toBe(0o077);
    expect(umask(undefined)).toBe(0o077);
    expect(fake.umask).toBe(0o077);
    fake.fs.writeFile("/f", new Uint8Array(0), 0o1101, 0o666);
    fake.fs.mkdir("/d", false, 0o777);
    expect([perm("/f"), perm("/d")]).toEqual([0o600, 0o700]);
    // An octal string, as fs takes a mode.
    expect(umask("027")).toBe(0o077);
    expect(umask()).toBe(0o027);
    expect(umask(0)).toBe(0o027);
    expect(umask()).toBe(0);
    // As Linux's umask(2), only the permission bits are kept.
    expect(umask(0o7022)).toBe(0);
    expect(umask()).toBe(0o022);
  });

  // The messages are real Node v26's, word for word.
  it("refuses what is no mask as Node does, and leaves the mask as it was", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const umask = process.umask as Umask;
    const octal =
      "The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received ";
    expect(attempt(umask, "0o27")).toEqual({
      code: "ERR_INVALID_ARG_VALUE",
      name: "TypeError",
      message: `${octal}'0o27'`,
    });
    expect(attempt(umask, "89")).toMatchObject({ message: `${octal}'89'` });
    expect(attempt(umask, "")).toMatchObject({ message: `${octal}''` });
    expect(attempt(umask, -1)).toEqual({
      code: "ERR_OUT_OF_RANGE",
      name: "RangeError",
      message: 'The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received -1',
    });
    expect(attempt(umask, 1.5)).toMatchObject({
      code: "ERR_OUT_OF_RANGE",
      message: 'The value of "mask" is out of range. It must be an integer. Received 1.5',
    });
    expect(attempt(umask, 2 ** 32)).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
    expect(attempt(umask, null)).toEqual({
      code: "ERR_INVALID_ARG_TYPE",
      name: "TypeError",
      message: 'The "mask" argument must be of type number. Received undefined',
    });
    expect(attempt(umask, true)).toMatchObject({
      message: 'The "mask" argument must be of type number. Received type boolean (true)',
    });
    expect(attempt(umask, {})).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect(umask()).toBe(0o022);
    expect([umask.length, umask.name]).toEqual([1, "wrappedUmask"]);
  });

  // Real Node v26, in a Worker: process.umask() reads the process's mask;
  // process.umask(0o077) and process.umask('zz') throw "Setting process.umask()
  // is not supported in workers"; process.umask(undefined) reads.
  it("only reads in a worker thread: the mask is the whole process's", () => {
    fake.umask = 0o027;
    const thread = Object.create(fake, {
      threads: { value: { ...fake.threads, isMainThread: false } },
    }) as FakeRuntime;
    setRuntime(thread);
    const umask = createProcess({ loadBuiltin: () => undefined, ipc: null }).umask as Umask;
    expect(umask()).toBe(0o027);
    expect(umask(undefined)).toBe(0o027);
    const refused = {
      code: "ERR_WORKER_UNSUPPORTED_OPERATION",
      name: "TypeError",
      message: "Setting process.umask() is not supported in workers",
    };
    expect(attempt(umask, 0o077)).toEqual(refused);
    // Before the argument is looked at.
    expect(attempt(umask, "zz")).toEqual(refused);
    expect(fake.umask).toBe(0o027);
    // What the main thread sets is the thread's mask at once.
    fake.umask = 0o002;
    expect(umask()).toBe(0o002);
  });
});

describe("stdout on a terminal", () => {
  // Real Node v26 at a terminal: end() emits 'finish' and no 'close'; the
  // first write after it fails as a write after end, and destroys and revives
  // the stream ('close'); the terminal is shut down, so later writes fail
  // with EPIPE.
  it("fails the first write after end() as a write after end, later ones with EPIPE", async () => {
    fake = createFakeRuntime({ tty: true });
    setRuntime(fake);
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const seen: string[] = [];
    process.stdout.on("finish", () => seen.push("finish"));
    process.stdout.on("close", () => seen.push("close"));
    process.stdout.on("error", (error: NodeJS.ErrnoException) => seen.push(`error ${error.code}`));
    process.stdout.end("ended\n", () => seen.push("end callback"));
    await until(() => seen.length === 2);
    await until(() => false);
    expect(seen).toEqual(["end callback", "finish"]);
    expect([process.stdout.writable, process.stdout.writableEnded]).toEqual([false, true]);
    expect([process.stdout.writableFinished, process.stdout.destroyed]).toEqual([true, false]);
    seen.length = 0;
    expect(
      process.stdout.write("x\n", (error?: Error | null) =>
        seen.push(`callback ${(error as NodeJS.ErrnoException).code}`),
      ),
    ).toBe(false);
    await until(() => seen.length === 3);
    expect(seen).toEqual([
      "callback ERR_STREAM_WRITE_AFTER_END",
      "error ERR_STREAM_WRITE_AFTER_END",
      "close",
    ]);
    seen.length = 0;
    process.stdout.write("y\n", (error?: Error | null) =>
      seen.push(`callback ${(error as NodeJS.ErrnoException).code}`),
    );
    await until(() => seen.length === 3);
    expect(seen).toEqual(["callback EPIPE", "error EPIPE", "close"]);
    expect(fake.stdout()).toBe("ended\n");
  });
});

describe("stdout on a pipe", () => {
  it("emits EPIPE when the reader is gone", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    // A write with no callback: the stream reports what the blocking write threw.
    fake.closeReader(1);
    const errors: { code?: string }[] = [];
    process.stdout.on("error", (error: { code?: string }) => errors.push(error));
    process.stdout.write("x");
    // The stream emits 'error' from a tick, queued here outside any macrotask.
    await until(() => errors.length > 0);
    expect(errors.map((error) => error.code)).toEqual(["EPIPE"]);
  });

  // Real Node v26 for `node w.js | true`: the callback gets `write EPIPE`
  // (errno -32, syscall write), the stream is writable again afterwards, and
  // each later write fails with its own EPIPE and its own 'error' event.
  it("stays writable after a failed write: a later write fails with its own `write EPIPE`", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    fake.closeReader(1);
    const seen: string[] = [];
    const describe = (error: unknown) => {
      const { message, code, errno, syscall } = error as NodeJS.ErrnoException;
      return `${message} (${code} ${errno} ${syscall})`;
    };
    process.stdout.on("error", (error: unknown) => seen.push(`error: ${describe(error)}`));
    process.stdout.write("one\n", (error?: Error | null) =>
      seen.push(`callback 1: ${describe(error)}`),
    );
    await until(() => seen.length === 2);
    expect([process.stdout.destroyed, process.stdout.writable]).toEqual([false, true]);
    process.stdout.write("two\n", (error?: Error | null) =>
      seen.push(`callback 2: ${describe(error)}`),
    );
    await until(() => seen.length === 4);
    expect(seen).toEqual([
      "callback 1: write EPIPE (EPIPE -32 write)",
      "error: write EPIPE (EPIPE -32 write)",
      "callback 2: write EPIPE (EPIPE -32 write)",
      "error: write EPIPE (EPIPE -32 write)",
    ]);
    expect([process.stdout.destroyed, process.stdout.writable]).toEqual([false, true]);
  });

  // Real Node v26 for `node w.js | cat`: end() shuts the pipe down ('finish'
  // and 'close' come at once), a later write fails with EPIPE, nothing of it
  // reaches the reader, and the reader sees no end of file at end().
  it("fails a write after end() with EPIPE, and writes nothing more", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const seen: string[] = [];
    process.stdout.on("finish", () => seen.push("finish"));
    process.stdout.on("close", () => seen.push("close"));
    process.stdout.on("error", (error: NodeJS.ErrnoException) =>
      seen.push(`error ${error.message} (${error.code} ${error.errno} ${error.syscall})`),
    );
    process.stdout.end("ended\n", () => seen.push("end callback"));
    await until(() => seen.length === 3);
    expect(seen).toEqual(["end callback", "finish", "close"]);
    // Revived by its 'close', as Node's stdout is: writable again, and shut down.
    expect([process.stdout.writable, process.stdout.writableEnded]).toEqual([true, false]);
    seen.length = 0;
    const returned = process.stdout.write("after end\n", (error?: Error | null) =>
      seen.push(`callback ${(error as NodeJS.ErrnoException).code}`),
    );
    expect(returned).toBe(false);
    await until(() => seen.length === 3);
    expect(seen).toEqual(["callback EPIPE", "error write EPIPE (EPIPE -32 write)", "close"]);
    seen.length = 0;
    process.stdout.write("again\n", (error?: Error | null) =>
      seen.push(`callback ${(error as NodeJS.ErrnoException).code}`),
    );
    await until(() => seen.length === 3);
    expect(seen).toEqual(["callback EPIPE", "error write EPIPE (EPIPE -32 write)", "close"]);
    expect(fake.stdout()).toBe("ended\n");
  });

  it("is still the program's to write after it destroyed it, as in Node", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const seen: string[] = [];
    process.stderr.on("close", () => seen.push("close"));
    process.stderr.destroy();
    await until(() => seen.length === 1);
    expect([process.stderr.destroyed, process.stderr.writable]).toEqual([false, true]);
    process.stderr.write("after destroy\n");
    expect(fake.stderr()).toBe("after destroy\n");
  });

  it("hands the error to the write's callback first, as Node's stream does", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    fake.closeReader(1);
    const heard: string[] = [];
    // What Node's console does: a callback, and a listener only for that write.
    process.stdout.once("error", (error: { code?: string }) => heard.push(`error ${error.code}`));
    process.stdout.write("x", (error?: Error | null) => {
      heard.push(`callback ${(error as { code?: string } | null | undefined)?.code}`);
    });
    await until(() => heard.length === 2);
    expect(heard).toEqual(["callback EPIPE", "error EPIPE"]);
  });

  it("reports a failed write after what the kernel sent first: a SIGINT handler runs before the EPIPE", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    process.on("SIGINT", () => order.push("SIGINT"));
    process.stdout.on("error", (error: { code?: string }) => order.push(`error ${error.code}`));
    // The kernel's SIGINT is on its way (a task) when the write fails.
    setTimeout(() => runMacrotask(() => fake.signal("SIGINT")), 0);
    fake.closeReader(1);
    runMacrotask(() => process.stdout.write("x"));
    await until(() => order.length === 2);
    expect(order).toEqual(["SIGINT", "error EPIPE"]);
  });

  it("keeps console.log quiet when the reader is gone, as Node's console does", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    fake.closeReader(1);
    const console = createConsole(
      () => process.stdout,
      () => process.stderr,
    );
    const errors: string[] = [];
    const stdout = process.stdout as unknown as {
      emit(name: string, ...args: unknown[]): boolean;
      listenerCount(name: string): number;
    };
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
    await until(() => errors.length > 0);
    await until(() => false);
    expect(errors).toEqual(["error (1 listening)"]);
    expect(stdout.listenerCount("error")).toBe(0);
    expect(fake.stderr()).toBe("alive\n");
  });
});

describe("emitExitForUncaughtError", () => {
  const newProcess = () => createProcess({ loadBuiltin: () => undefined, ipc: null });

  it("runs the 'exit' listeners once with code 1, as a thread does before an uncaught error ends it", () => {
    const process = newProcess();
    process.exitCode = 4;
    const seen: string[] = [];
    process.on("exit", (code) => seen.push(`listener ${code} ${process.exitCode}`));
    emitExitForUncaughtError(process);
    expect(seen).toEqual(["listener 1 1"]);
    expect((process as { _exiting?: boolean })._exiting).toBe(true);
    // Emitted once: neither a second error nor process.exit runs them again.
    emitExitForUncaughtError(process);
    expect(() => process.exit(3)).toThrow(FakeExit);
    expect(seen).toEqual(["listener 1 1"]);
    expect(fake.exitCode).toBe(3);
  });

  it("drops a listener's throw, which stops the listeners after it", () => {
    const process = newProcess();
    const seen: string[] = [];
    process.on("exit", () => {
      seen.push("first");
      throw new Error("from the listener");
    });
    process.on("exit", () => seen.push("second"));
    expect(() => emitExitForUncaughtError(process)).not.toThrow();
    expect(seen).toEqual(["first"]);
    expect(process.exitCode).toBe(1);
  });

  it("runs none when 'exit' was emitted already", () => {
    const process = newProcess();
    const seen: number[] = [];
    process.on("exit", (code) => seen.push(code as number));
    expect(() => process.exit(0)).toThrow(FakeExit);
    emitExitForUncaughtError(process);
    expect(seen).toEqual([0]);
    expect(process.exitCode).toBe(0);
  });
});
