// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { recordingScheduler, withPlatform } from "./eventLoop.testkit";
import { createProcess } from "./process";
import timers, {
  Immediate,
  Timeout,
  active,
  clearImmediate,
  clearInterval,
  clearTimeout,
  enroll,
  setImmediate,
  setInterval,
  setTimeout,
  unenroll,
} from "./timers";
import timersPromises from "./timers_promises";

const sleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

describe("timers module shape", () => {
  it("has Node's exports", () => {
    expect(Object.keys(timers)).toEqual([
      "setTimeout",
      "clearTimeout",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "_unrefActive",
      "active",
      "unenroll",
      "enroll",
      "promises",
    ]);
    expect(timers.promises).toBe(timersPromises);
  });
});

describe("setTimeout", () => {
  it("returns a Timeout and passes extra arguments with the timeout as this", async () => {
    let seen: unknown[] = [];
    let self: unknown;
    const timeout = setTimeout(
      function (this: unknown, ...args: unknown[]) {
        // eslint-disable-next-line typescript/no-this-alias -- the test checks what this is
        self = this;
        seen = args;
      },
      1,
      "a",
      2,
    );
    expect(timeout).toBeInstanceOf(Timeout);
    await sleep(20);
    expect(seen).toEqual(["a", 2]);
    expect(self).toBe(timeout);
  });

  it("coerces bad delays to 1", () => {
    for (const delay of [0, -5, Number.NaN, 2 ** 31, undefined, "abc"]) {
      const timeout = setTimeout(() => {}, delay as number);
      expect(timeout._idleTimeout).toBe(1);
      clearTimeout(timeout);
    }
    const timeout = setTimeout(() => {}, "25" as unknown as number);
    expect(timeout._idleTimeout).toBe(25);
    clearTimeout(timeout);
  });

  it("rejects a non-function callback with ERR_INVALID_ARG_TYPE", () => {
    expect(() => setTimeout("x" as unknown as () => void, 1)).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: `The "callback" argument must be of type function. Received type string ('x')`,
      }),
    );
    expect(() => setInterval(null as unknown as () => void)).toThrow(TypeError);
    expect(() => setImmediate({} as unknown as () => void)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("holds one ref while pending and releases it when it fires", async () => {
    const timeout = setTimeout(() => {}, 5);
    expect(fake.refCount).toBe(1);
    expect(timeout.hasRef()).toBe(true);
    await sleep(30);
    expect(fake.refCount).toBe(0);
  });

  it("releases the ref on clear, unref, and takes it back on ref", () => {
    const a = setTimeout(() => {}, 1000);
    const b = setTimeout(() => {}, 1000);
    expect(fake.refCount).toBe(2);
    a.unref();
    expect(a.hasRef()).toBe(false);
    expect(fake.refCount).toBe(1);
    a.unref();
    expect(fake.refCount).toBe(1);
    a.ref();
    expect(fake.refCount).toBe(2);
    clearTimeout(a);
    clearTimeout(a);
    expect(fake.refCount).toBe(1);
    b.close();
    expect(fake.refCount).toBe(0);
    b.ref();
    expect(fake.refCount).toBe(0);
  });

  it("an unref'd timer still fires", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 1).unref();
    expect(fake.refCount).toBe(0);
    await sleep(20);
    expect(fired).toBe(true);
    expect(fake.refCount).toBe(0);
  });

  it("toPrimitive gives a numeric id clearTimeout accepts (number or string)", async () => {
    let fired = 0;
    const a = setTimeout(() => fired++, 5);
    const b = setTimeout(() => fired++, 5);
    const idA = +a;
    expect(typeof idA).toBe("number");
    expect(`${b}`).toBe(String(+b));
    clearTimeout(idA);
    clearTimeout(String(+b));
    expect(fake.refCount).toBe(0);
    await sleep(25);
    expect(fired).toBe(0);
  });

  it("clearTimeout ignores junk", () => {
    for (const junk of [undefined, null, 0, 12345, "x", {}, () => {}]) {
      expect(() => clearTimeout(junk)).not.toThrow();
    }
  });

  it("refresh re-arms from now and revives a fired timer", async () => {
    let count = 0;
    const timeout = setTimeout(() => count++, 30);
    await sleep(20);
    timeout.refresh();
    await sleep(20);
    expect(count).toBe(0);
    await sleep(30);
    expect(count).toBe(1);
    expect(fake.refCount).toBe(0);
    timeout.refresh();
    expect(fake.refCount).toBe(1);
    await sleep(50);
    expect(count).toBe(2);
    expect(fake.refCount).toBe(0);
  });

  it("refresh does not revive a cleared timer", async () => {
    let count = 0;
    const timeout = setTimeout(() => count++, 1);
    clearTimeout(timeout);
    expect(timeout.refresh()).toBe(timeout);
    await sleep(20);
    expect(count).toBe(0);
    expect(fake.refCount).toBe(0);
  });

  it("Symbol.dispose clears the timer", () => {
    const timeout = setTimeout(() => {}, 1000);
    const dispose =
      (Symbol as unknown as { dispose?: symbol }).dispose ?? Symbol.for("nodejs.dispose");
    (timeout as unknown as Record<symbol, () => void>)[dispose]();
    expect(timeout._destroyed).toBe(true);
    expect(fake.refCount).toBe(0);
  });

  it("works with no runtime installed", async () => {
    setRuntime(null);
    let fired = false;
    const timeout = setTimeout(() => {
      fired = true;
    }, 1);
    timeout.unref().ref();
    await sleep(20);
    expect(fired).toBe(true);
  });
});

describe("setInterval", () => {
  it("repeats until cleared and keeps one ref meanwhile", async () => {
    let count = 0;
    const interval = setInterval(() => {
      count++;
      if (count === 3) {
        clearInterval(interval);
      }
    }, 5);
    expect(interval._repeat).toBe(5);
    expect(fake.refCount).toBe(1);
    await sleep(80);
    expect(count).toBe(3);
    expect(fake.refCount).toBe(0);
  });

  it("clearTimeout clears an interval too", async () => {
    let count = 0;
    const interval = setInterval(() => count++, 5);
    clearTimeout(interval);
    await sleep(20);
    expect(count).toBe(0);
  });
});

describe("setImmediate", () => {
  it("runs immediates in FIFO order, before a later timeout", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timeout"), 15);
    setImmediate(() => order.push("a"));
    setImmediate((x: string) => order.push(x), "b");
    setImmediate(() => order.push("c"));
    await sleep(40);
    expect(order).toEqual(["a", "b", "c", "timeout"]);
  });

  it("runs microtasks queued by one immediate before the next", async () => {
    const order: string[] = [];
    setImmediate(() => {
      order.push("a");
      Promise.resolve().then(() => order.push("a-micro"));
    });
    setImmediate(() => order.push("b"));
    await sleep(20);
    expect(order).toEqual(["a", "a-micro", "b"]);
  });

  it("an immediate scheduled inside an immediate runs after the queued ones", async () => {
    const order: string[] = [];
    setImmediate(() => {
      order.push("a");
      setImmediate(() => order.push("nested"));
    });
    setImmediate(() => order.push("b"));
    await sleep(20);
    expect(order).toEqual(["a", "b", "nested"]);
  });

  it("returns an Immediate with ref accounting and clearImmediate", async () => {
    let ran = false;
    const immediate = setImmediate(() => {
      ran = true;
    });
    expect(immediate).toBeInstanceOf(Immediate);
    expect(fake.refCount).toBe(1);
    immediate.unref();
    expect(immediate.hasRef()).toBe(false);
    expect(fake.refCount).toBe(0);
    immediate.ref();
    expect(fake.refCount).toBe(1);
    clearImmediate(immediate);
    expect(fake.refCount).toBe(0);
    clearImmediate(immediate);
    clearImmediate(undefined);
    clearImmediate(42);
    await sleep(10);
    expect(ran).toBe(false);
  });

  it("releases its ref after running", async () => {
    setImmediate(() => {});
    expect(fake.refCount).toBe(1);
    await sleep(10);
    expect(fake.refCount).toBe(0);
  });
});

describe("ticks and macrotasks", () => {
  function busyWait(ms: number): void {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // A timer comes due meanwhile.
    }
  }

  it("orders ticks, promise jobs, immediates and a timeout inside a timer as Node does", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    const order: string[] = [];
    setTimeout(() => {
      setTimeout(() => order.push("timeout"), 0);
      setImmediate(() => {
        order.push("immediate");
        process.nextTick(() => order.push("immediate>t"));
        void Promise.resolve().then(() => order.push("immediate>p"));
      });
      setImmediate(() => order.push("immediate2"));
      void Promise.resolve().then(() => {
        order.push("p");
        process.nextTick(() => order.push("p>t"));
        setImmediate(() => order.push("p>immediate"));
      });
      process.nextTick(() => {
        order.push("t");
        setImmediate(() => order.push("t>immediate"));
      });
    }, 1);
    await sleep(40);
    // What real Node v26 prints for the same timer.
    expect(order).toEqual([
      "t",
      "p",
      "p>t",
      "immediate",
      "immediate>t",
      "immediate>p",
      "immediate2",
      "t>immediate",
      "p>immediate",
      "timeout",
    ]);
  });

  it("a timer refreshed by ticks that ran before it fires once, from the refresh", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    let fired = 0;
    const timeout = setTimeout(() => (fired += 1), 1);
    busyWait(5);
    await Promise.resolve();
    // Queued outside a macrotask: it runs before the timer, which is already due.
    process.nextTick(() => timeout.refresh());
    await sleep(40);
    expect(fired).toBe(1);
    expect(fake.refCount).toBe(0);
  });

  it("a timer cleared by ticks that ran before it does not fire", async () => {
    const process = createProcess({ loadBuiltin: () => undefined, ipc: null });
    let fired = 0;
    const timeout = setTimeout(() => (fired += 1), 1);
    busyWait(5);
    await Promise.resolve();
    process.nextTick(() => clearTimeout(timeout));
    await sleep(20);
    expect(fired).toBe(0);
    expect(fake.refCount).toBe(0);
  });

  /**
   * A process whose waiting ticks get their turn only when the test runs it:
   * a timer's task that comes meanwhile runs those ticks and waits for the
   * turn itself.
   */
  async function withHeldTurn() {
    const { posted, scheduler } = recordingScheduler();
    const fresh = await withPlatform({ reportError: () => {}, scheduler });
    /** Runs the turn's tasks until none is posted. */
    const runTurn = () => {
      for (let task = posted.shift(); task !== undefined; task = posted.shift()) {
        task.callback();
      }
    };
    return { ...fresh, runTurn };
  }

  it("a timer refreshed by a tick its own task ran, while that task waits, fires once, from the refresh", async () => {
    const { process, runtime, timers: fresh, runTurn } = await withHeldTurn();
    let fired = 0;
    const timeout = fresh.setTimeout(() => (fired += 1), 1);
    await Promise.resolve();
    // Queued outside a macrotask: the timer's task finds it waiting, runs it
    // (the refresh) and waits behind it; the refreshed timer's task comes too.
    process.nextTick(() => timeout.refresh());
    await sleep(20);
    expect(fired).toBe(0);
    runTurn();
    expect(fired).toBe(1);
    await sleep(10);
    runTurn();
    expect(fired).toBe(1);
    expect(runtime.refCount).toBe(0);
  });

  it("a timer cleared by a tick its own task ran, while that task waits, does not fire", async () => {
    const { process, runtime, timers: fresh, runTurn } = await withHeldTurn();
    let fired = 0;
    const timeout = fresh.setTimeout(() => (fired += 1), 1);
    await Promise.resolve();
    process.nextTick(() => fresh.clearTimeout(timeout));
    await sleep(20);
    runTurn();
    expect(fired).toBe(0);
    expect(runtime.refCount).toBe(0);
  });
});

describe("legacy item API", () => {
  it("enroll/active/unenroll schedule item._onTimeout", async () => {
    let count = 0;
    const item = { _onTimeout: () => count++ } as object;
    enroll(item, 5);
    active(item);
    expect(fake.refCount).toBe(1);
    await sleep(30);
    expect(count).toBe(1);
    expect(fake.refCount).toBe(0);
    active(item);
    unenroll(item);
    expect(fake.refCount).toBe(0);
    await sleep(20);
    expect(count).toBe(1);
  });
});
