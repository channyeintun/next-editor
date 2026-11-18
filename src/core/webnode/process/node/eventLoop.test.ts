// @vitest-environment node
// The event loop's scheduler over the fake runtime: the gate the exit check
// asks, the end of a turn, rejections reported together, and the rounds a
// macrotask of the runtime's own has in its task.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import {
  eventLoopHolds,
  gateNextMacrotask,
  holdProcess,
  inMacrotaskOf,
  nextTick,
  runEventListener,
  runBeforeQueuedTasks,
  runMacrotask,
} from "./eventLoop";
import { browserChannels, recordingScheduler, withPlatform } from "./eventLoop.testkit";
import { createProcess } from "./process";
import timers from "./timers";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

/** Lets the event loop turn until `done()` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("gateNextMacrotask", () => {
  it("asks once, as the next macrotask is about to start, and lets it run on yes", () => {
    createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    gateNextMacrotask(() => {
      order.push("asked");
      return true;
    });
    expect(order).toEqual([]);
    runMacrotask(() => order.push("first"));
    runMacrotask(() => order.push("second"));
    expect(order).toEqual(["asked", "first", "second"]);
  });

  it("keeps that macrotask and the later ones back on no, until it is opened", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    const open = gateNextMacrotask(() => false);
    runMacrotask(() => {
      order.push("first");
      void Promise.resolve().then(() => order.push("first>p"));
      process.nextTick(() => order.push("first>t"));
    });
    runMacrotask(() => order.push("second"));
    await sleep(5);
    expect(order).toEqual([]);
    open();
    await until(() => order.length === 4);
    // Each as a macrotask: its ticks and promise jobs come before the next.
    expect(order).toEqual(["first", "first>t", "first>p", "second"]);
    runMacrotask(() => order.push("third"));
    expect(order).toHaveLength(5);
  });

  it("asks after the ticks that were waiting and their promise jobs", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    await Promise.resolve();
    process.nextTick(() => {
      order.push("tick");
      void Promise.resolve().then(() => order.push("tick>p"));
    });
    gateNextMacrotask(() => {
      order.push("asked");
      return true;
    });
    runMacrotask(() => order.push("macrotask"));
    await until(() => order.length === 4);
    expect(order).toEqual(["tick", "tick>p", "asked", "macrotask"]);
  });

  it("is not asked once withdrawn", () => {
    createProcess({ loadBuiltin: () => undefined, ipc: null });
    let asked = 0;
    const withdraw = gateNextMacrotask(() => {
      asked += 1;
      return false;
    });
    withdraw();
    let ran = false;
    runMacrotask(() => (ran = true));
    expect([asked, ran]).toEqual([0, true]);
  });

  it("lets the macrotasks run again when it is opened before it was asked", async () => {
    createProcess({ loadBuiltin: () => undefined, ipc: null });
    const open = gateNextMacrotask(() => false);
    const order: string[] = [];
    runMacrotask(() => order.push("held"));
    expect(order).toEqual([]);
    open();
    await until(() => order.length === 1);
    // Opened: the next one is not asked about, and runs at once.
    runMacrotask(() => order.push("next"));
    expect(order).toEqual(["held", "next"]);
  });
});

describe("eventLoopHolds", () => {
  it("counts the ref a turn's message holds, and nothing once the turn is over", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const base = fake.refCount;
    expect(eventLoopHolds()).toBe(0);
    let ran = false;
    // Node has no scheduler.postTask: the turn is a message, which holds the process.
    await Promise.resolve().then(() => process.nextTick(() => (ran = true)));
    expect([eventLoopHolds(), fake.refCount - base]).toEqual([1, 1]);
    await until(() => ran && fake.refCount === base);
    expect([eventLoopHolds(), fake.refCount - base]).toEqual([0, 0]);
  });
});

describe("nextTick for the runtime's own modules", () => {
  it("is a tick of the process once there is one", () => {
    createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    runMacrotask(() => {
      void Promise.resolve().then(() => order.push("promise"));
      nextTick((value: string) => order.push(value), "tick");
      order.push("sync");
    });
    expect(order).toEqual(["sync", "tick"]);
  });
});

/**
 * Dispatches `event` as a browser does: it stays at its target until every
 * listener has run (Node's EventTarget says NONE from the second on).
 */
function dispatchAsBrowser(target: EventTarget, event: Event): void {
  let dispatching = true;
  Object.defineProperty(event, "eventPhase", {
    get: () => (dispatching ? Event.AT_TARGET : Event.NONE),
  });
  try {
    target.dispatchEvent(event);
  } finally {
    dispatching = false;
  }
}

describe("inMacrotaskOf", () => {
  it("counts an event's listener and the ticks its task queued after it, and nothing later", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const target = new EventTarget();
    const seen: string[] = [];
    let first: Event | null = null;
    target.addEventListener("message", (event) =>
      runEventListener(() => seen.push(`listener ${inMacrotaskOf(event)}`), event),
    );
    // After the macrotask's listener and in the same dispatch: where a
    // browser runs the listener's promise jobs.
    target.addEventListener("message", (event) => {
      if (first === null) {
        first = event;
        process.nextTick(() => seen.push(`its tick ${inMacrotaskOf(event)}`));
      }
    });
    dispatchAsBrowser(target, new Event("message"));
    await until(() => seen.length === 2);
    await sleep(5);
    const event = first!;
    seen.push(`after its turn ${inMacrotaskOf(event)}`);
    setTimeout(() =>
      process.nextTick(() => seen.push(`a later task's tick ${inMacrotaskOf(event)}`)),
    );
    await until(() => seen.length === 4);
    dispatchAsBrowser(target, new Event("message"));
    runMacrotask(() => seen.push(`another macrotask ${inMacrotaskOf(event)}`));
    expect(seen).toEqual([
      "listener true",
      "its tick true",
      "after its turn false",
      "a later task's tick false",
      "listener true",
      "another macrotask false",
    ]);
  });
});

describe("the tick queue", () => {
  it("runs a burst of ticks and the ticks they queue in order", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: number[] = [];
    const BURST = 5000;
    runMacrotask(() => {
      for (let i = 0; i < BURST; i += 1) {
        process.nextTick(() => {
          order.push(i);
          if (i % 1000 === 0) {
            process.nextTick(() => order.push(BURST + i));
          }
        });
      }
    });
    expect(order).toEqual([
      ...Array.from({ length: BURST }, (_, index) => index),
      ...[0, 1000, 2000, 3000, 4000].map((index) => BURST + index),
    ]);
  });

  it("does not keep the ticks of a long chain once they have run", () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const heapUsed = () => globalThis.process.memoryUsage().heapUsed;
    // Kept, two million ticks would hold about 100 MB.
    const LINKS = 2_000_000;
    let run = 0;
    let grown = 0;
    runMacrotask(() => {
      const before = heapUsed();
      const next = () => {
        run += 1;
        if (run < LINKS) {
          process.nextTick(next);
        } else {
          grown = heapUsed() - before;
        }
      };
      process.nextTick(next);
    });
    expect(run).toBe(LINKS);
    expect(grown).toBeLessThan(50 * 1024 * 1024);
  });
});

describe("the event loop's own messages", () => {
  it("keep coming when a program's spy replaces MessagePort.prototype.postMessage", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const prototype = MessagePort.prototype as { postMessage: unknown };
    const original = prototype.postMessage;
    const seen: string[] = [];
    // As a test's spy that does not call through.
    prototype.postMessage = () => {};
    try {
      timers.setImmediate(() => seen.push("immediate"));
      // From a promise job: the tick's turn is a message too.
      await Promise.resolve().then(() => process.nextTick(() => seen.push("tick")));
      await until(() => seen.length === 2);
    } finally {
      prototype.postMessage = original;
    }
    expect(seen.sort()).toEqual(["immediate", "tick"]);
  });
});

describe("the end of a turn", () => {
  it("runs afterTurn's callback although its message came before the turn's task", async () => {
    // A platform whose postTask is not ahead of a message already queued.
    const late: (() => void)[] = [];
    const fresh = await withPlatform({
      reportError: () => {},
      scheduler: {
        postTask(callback: () => void) {
          late.push(callback);
          return Promise.resolve();
        },
      },
    });
    const order: string[] = [];
    await Promise.resolve();
    fresh.process.nextTick(() => order.push("tick"));
    fresh.eventLoop.afterTurn(() => order.push("after"));
    // The after-turn message arrives while the turn is still only posted.
    await sleep(5);
    expect(order).toEqual([]);
    late[0]();
    await until(() => order.length === 2);
    expect(order).toEqual(["tick", "after"]);
  });
});

describe("unhandled rejections with a priority task", () => {
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

  async function withRejections() {
    const global = new EventTarget();
    const { posted, scheduler } = recordingScheduler();
    const fresh = await withPlatform({
      reportError: (error) => {
        throw error;
      },
      scheduler,
      globals: {
        addEventListener: global.addEventListener.bind(global),
        dispatchEvent: global.dispatchEvent.bind(global),
        PromiseRejectionEvent: FakeRejectionEvent,
      },
    });
    const order: string[] = [];
    global.addEventListener("unhandledrejection", (event) => {
      const { reason } = event as FakeRejectionEvent;
      order.push(`unhandled ${String(reason)}`);
      fresh.process.nextTick(() => order.push(`${String(reason)}>t`));
      void Promise.resolve().then(() => order.push(`${String(reason)}>p`));
    });
    const reasons = new Map<Promise<unknown>, string>();
    const rejected = (reason: string) => {
      // Handled here, so that the test runner does not see it.
      const promise = Promise.reject(new Error(reason));
      promise.catch(() => {});
      reasons.set(promise, reason);
      return promise;
    };
    const report = (type: "unhandledrejection" | "rejectionhandled", promise: Promise<unknown>) =>
      global.dispatchEvent(
        new FakeRejectionEvent(type, { promise, reason: reasons.get(promise), cancelable: true }),
      );
    return { ...fresh, posted, order, report, rejected };
  }

  it("reports the rejections of one task together: every listener, then their ticks, then their promise jobs", async () => {
    const { posted, order, report, rejected } = await withRejections();
    // The browser reports both in one task, one event each.
    report("unhandledrejection", rejected("a"));
    report("unhandledrejection", rejected("b"));
    expect(order).toEqual([]);
    expect(posted.map((task) => task.priority)).toEqual(["user-blocking"]);
    posted[0].callback();
    expect(order).toEqual(["unhandled a", "unhandled b", "a>t", "b>t"]);
    await Promise.resolve();
    // The order real Node v26 gives two rejections of one macrotask.
    expect(order).toEqual(["unhandled a", "unhandled b", "a>t", "b>t", "a>p", "b>p"]);
  });

  it("drops one that got a handler before the report", async () => {
    const { posted, order, report, rejected } = await withRejections();
    const kept = rejected("kept");
    const handled = rejected("handled");
    report("unhandledrejection", kept);
    report("unhandledrejection", handled);
    report("rejectionhandled", handled);
    posted[0].callback();
    expect(order).toEqual(["unhandled kept", "kept>t"]);
  });

  it("does not ask the gate for a report: it is part of the macrotask that rejected", async () => {
    const { posted, order, report, rejected, eventLoop } = await withRejections();
    let asked = 0;
    eventLoop.gateNextMacrotask(() => {
      asked += 1;
      return false;
    });
    report("unhandledrejection", rejected("late"));
    posted[0].callback();
    expect(order).toEqual(["unhandled late", "late>t"]);
    expect(asked).toBe(0);
  });

  it("does not ask the gate either for a report that waits behind a later tick", async () => {
    const { process, posted, order, report, rejected, eventLoop } = await withRejections();
    report("unhandledrejection", rejected("held"));
    // Before the report's task runs, a tick waits for its turn and the exit check sets the gate.
    await Promise.resolve();
    process.nextTick(() => order.push("later tick"));
    eventLoop.gateNextMacrotask(() => {
      order.push("gate asked");
      return false;
    });
    expect(posted).toHaveLength(2);
    // The report's task: the tick comes first, and the report waits for the turn.
    posted[0].callback();
    expect(order).toEqual(["later tick"]);
    posted[1].callback();
    expect(order).toEqual(["later tick", "unhandled held", "held>t"]);
    // The gate is still there for the next macrotask, and keeps it back.
    eventLoop.runMacrotask(() => order.push("macrotask"));
    expect(order).toEqual(["later tick", "unhandled held", "held>t", "gate asked"]);
  });
});

describe("unhandled rejections reported while a turn runs", () => {
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

  /** A platform without scheduler.postTask: every turn is a message. */
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
      order.push(`unhandled ${String((event as FakeRejectionEvent).reason)}`);
    });
    const report = (reason: string) => {
      const promise = Promise.reject(new Error(reason));
      promise.catch(() => {});
      global.dispatchEvent(
        new FakeRejectionEvent("unhandledrejection", { promise, reason, cancelable: true }),
      );
    };
    return { ...fresh, order, report };
  }

  it("reports one when that turn is over, although the macrotasks after it keep starting turns", async () => {
    const { process, timers, order, report } = await withRejections();
    // Each immediate's promise job queues a tick whose promise job queues another: a turn of two rounds.
    let immediates = 0;
    let reportedAt = -1;
    const busy = () => {
      immediates += 1;
      if (reportedAt < 0 && order.length > 0) {
        reportedAt = immediates;
      }
      void Promise.resolve().then(() =>
        process.nextTick(() => Promise.resolve().then(() => process.nextTick(() => {}))),
      );
      if (immediates === 3) {
        // The browser reports it between two rounds of this macrotask's turn.
        void Promise.resolve().then(() => process.nextTick(() => report("during a turn")));
      }
      if (immediates < 200) {
        timers.setImmediate(busy);
      }
    };
    timers.setImmediate(busy);
    await until(() => immediates === 200);
    expect(order).toEqual(["unhandled during a turn"]);
    // Within a few macrotasks, not when the process went quiet.
    expect(reportedAt).toBeGreaterThan(0);
    expect(reportedAt).toBeLessThan(20);
  });
});

describe("a macrotask of the runtime's own, on a platform that runs promise jobs after each listener", () => {
  async function inBrowser() {
    const channels = browserChannels();
    const { posted, scheduler } = recordingScheduler();
    const fresh = await channels.listening(() =>
      withPlatform({
        reportError: (error) => {
          throw error;
        },
        scheduler,
        globals: { MessageChannel: channels.MessageChannel },
      }),
    );
    return { ...fresh, posted, listenersRun: channels.listenersRun };
  }

  it("runs a tick its promise jobs queue in the same task, with no task posted for it", async () => {
    const { process, timers, posted } = await inBrowser();
    const order: string[] = [];
    timers.setImmediate(() => {
      order.push("immediate");
      void Promise.resolve().then(() => {
        order.push("promise");
        process.nextTick(() => {
          order.push("promise>tick");
          void Promise.resolve().then(() => order.push("promise>tick>promise"));
        });
      });
    });
    timers.setImmediate(() => order.push("next immediate"));
    await until(() => order.length === 5);
    expect(order).toEqual([
      "immediate",
      "promise",
      "promise>tick",
      "promise>tick>promise",
      "next immediate",
    ]);
    expect(posted).toEqual([]);
  });

  it("goes on in a turn when the rounds of its task are used up, keeping the order", async () => {
    const { process, timers, posted } = await inBrowser();
    const order: number[] = [];
    // More rounds than one task has.
    const LINKS = 150;
    timers.setImmediate(() => {
      let link = 0;
      const next = () => {
        order.push(link);
        link += 1;
        if (link < LINKS) {
          void Promise.resolve().then(() => process.nextTick(next));
        }
      };
      next();
    });
    timers.setImmediate(() => order.push(-1));
    // The turn's first task is the recording scheduler's: run each as it is posted.
    for (let i = 0; i < 500 && order.length < LINKS + 1; i += 1) {
      for (const task of posted.splice(0)) {
        task.callback();
      }
      await sleep(1);
    }
    expect(order).toEqual([...Array.from({ length: LINKS }, (_, index) => index), -1]);
    // The task's rounds were used up, so the turn was posted.
    expect(order).toHaveLength(LINKS + 1);
  });

  it("runs the listener of an event a program dispatched as part of its caller", async () => {
    const { process, eventLoop } = await inBrowser();
    const target = new EventTarget();
    const order: string[] = [];
    eventLoop.addMacrotaskListener(target, "message", () => {
      order.push("listener");
      process.nextTick(() => order.push("listener>tick"));
    });
    await Promise.resolve();
    process.nextTick(() => order.push("waiting tick"));
    // As a port's own dispatchEvent does for a program's call.
    eventLoop.dispatchFromProgram(() => target.dispatchEvent(new Event("message")));
    // Not a macrotask: the waiting tick did not run first, nor the listener's after it.
    expect(order).toEqual(["listener"]);
  });

  it("costs an idle macrotask one listener more than its own", async () => {
    const { timers, listenersRun } = await inBrowser();
    let ran = false;
    timers.setImmediate(() => (ran = true));
    await until(() => ran);
    await sleep(2);
    expect(listenersRun()).toBe(2);
  });

  it("runs a macrotask that found ticks waiting in a later round of its own task", async () => {
    const { process, timers, posted } = await inBrowser();
    const order: string[] = [];
    await Promise.resolve();
    // Queued outside a macrotask: its turn is posted (and recorded, not run).
    process.nextTick(() => {
      order.push("tick");
      void Promise.resolve().then(() => order.push("tick>p"));
    });
    expect(posted).toHaveLength(1);
    timers.setImmediate(() => order.push("immediate"));
    await until(() => order.length === 3);
    expect(order).toEqual(["tick", "tick>p", "immediate"]);
    // The posted task finds nothing left.
    posted[0].callback();
    expect(order).toHaveLength(3);
  });
});

describe("runBeforeQueuedTasks", () => {
  it("posts the job ahead of the queued tasks, after the caller's task, and runs it as a macrotask", async () => {
    const { posted, scheduler } = recordingScheduler();
    const fresh = await withPlatform({
      reportError: (error) => {
        throw error;
      },
      scheduler,
    });
    const order: string[] = [];
    fresh.eventLoop.runBeforeQueuedTasks(() => {
      order.push("job");
      fresh.process.nextTick(() => order.push("job>t"));
      void Promise.resolve().then(() => order.push("job>p"));
    });
    order.push("caller");
    // Nothing ran: the job waits for a task of its own, at the turn's priority.
    expect(order).toEqual(["caller"]);
    expect(posted.map((task) => task.priority)).toEqual(["user-blocking"]);
    posted[0].callback();
    order.push("task over");
    await Promise.resolve();
    expect(order).toEqual(["caller", "job", "job>t", "task over", "job>p"]);
  });

  it("runs the jobs in order, behind the tasks queued so far, where there are no priorities", async () => {
    createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    setTimeout(() => order.push("timer"), 0);
    await sleep(1);
    runBeforeQueuedTasks(() => {
      order.push("first");
      nextTick(() => order.push("first>t"));
    });
    runBeforeQueuedTasks(() => order.push("second"));
    order.push("caller");
    await until(() => order.length === 5);
    expect(order).toEqual(["timer", "caller", "first", "first>t", "second"]);
  });
});

describe("holdProcess", () => {
  it("holds the process once until it is let go, however often that is called", () => {
    const release = holdProcess();
    expect(fake.refCount).toBe(1);
    release();
    release();
    expect(fake.refCount).toBe(0);
  });

  it("holds nothing where there is no runtime", () => {
    setRuntime(null);
    const release = holdProcess();
    expect(() => release()).not.toThrow();
  });
});
