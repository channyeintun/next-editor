// @vitest-environment node
// Behaviour tests for the `events` builtin, with error messages compared
// against Node's own `events` where they can be.
import nodeEvents from "node:events";
import { describe, expect, it, vi } from "vitest";
import EventEmitter, {
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  getEventListeners,
  getMaxListeners,
  on,
  once,
  type Listener,
} from "./events";

function thrown(run: () => unknown): { code?: string; name?: string; message?: string } {
  try {
    run();
  } catch (error) {
    const e = error as { code?: string; name?: string; message?: string };
    return { code: e.code, name: e.name, message: e.message };
  }
  throw new Error("expected a throw");
}

describe("EventEmitter construction", () => {
  it("is a constructor function that also works with call() and inherits", () => {
    expect(typeof EventEmitter).toBe("function");
    expect(EventEmitter.EventEmitter).toBe(EventEmitter);
    expect(Function.prototype.toString.call(EventEmitter).startsWith("class")).toBe(false);

    function Legacy(this: EventEmitter & { name: string }) {
      EventEmitter.call(this);
      this.name = "legacy";
    }
    Object.setPrototypeOf(Legacy.prototype, EventEmitter.prototype);
    Object.setPrototypeOf(Legacy, EventEmitter);
    const legacy = new (Legacy as unknown as new () => EventEmitter & { name: string })();
    const seen: unknown[] = [];
    legacy.on("x", (value: unknown) => seen.push(value));
    expect(legacy.emit("x", 1)).toBe(true);
    expect(seen).toEqual([1]);
    expect(legacy).toBeInstanceOf(EventEmitter);
  });

  it("works as an ES class base", () => {
    class Child extends EventEmitter {
      fire() {
        return this.emit("fire", "hot");
      }
    }
    const child = new Child();
    const listener = vi.fn<(...args: unknown[]) => void>();
    child.on("fire", listener);
    expect(child.fire()).toBe(true);
    expect(listener).toHaveBeenCalledWith("hot");
    expect(child).toBeInstanceOf(EventEmitter);
  });

  it("keeps _events set up by a subclass before init (shape mode)", () => {
    function Shaped(this: EventEmitter & { _events: object }) {
      this._events = { a: undefined };
      EventEmitter.call(this);
    }
    Object.setPrototypeOf(Shaped.prototype, EventEmitter.prototype);
    const shaped = new (Shaped as unknown as new () => EventEmitter)();
    const listener = () => {};
    shaped.on("a", listener);
    expect(shaped.eventNames()).toEqual(["a"]);
    shaped.off("a", listener);
    expect(shaped.eventNames()).toEqual([]);
    expect(shaped.listenerCount("a")).toBe(0);
  });

  it("validates captureRejections", () => {
    expect(thrown(() => new EventEmitter({ captureRejections: 1 as never }))).toEqual(
      thrown(() => new nodeEvents.EventEmitter({ captureRejections: 1 as never })),
    );
  });
});

describe("listeners", () => {
  it("adds, prepends, lists and counts", () => {
    const ee = new EventEmitter();
    const a = () => {};
    const b = () => {};
    const c = () => {};
    ee.on("e", a);
    ee.addListener("e", b);
    ee.prependListener("e", c);
    expect(ee.listeners("e")).toEqual([c, a, b]);
    expect(ee.listenerCount("e")).toBe(3);
    expect(ee.listenerCount("e", a)).toBe(1);
    expect(ee.listenerCount("e", () => {})).toBe(0);
    expect(ee.listenerCount("none")).toBe(0);
    expect(EventEmitter.listenerCount(ee, "e")).toBe(3);
    expect(ee.eventNames()).toEqual(["e"]);
    const sym = Symbol("s");
    ee.on(sym, a);
    expect(ee.eventNames()).toEqual(["e", sym]);
  });

  it("calls once listeners once and exposes raw wrappers", () => {
    const ee = new EventEmitter();
    const listener = vi.fn<(...args: unknown[]) => void>();
    ee.once("e", listener);
    const first = vi.fn<(...args: unknown[]) => void>();
    ee.prependOnceListener("e", first);
    const raw = ee.rawListeners("e") as (Listener & { listener?: Listener })[];
    expect(raw).toHaveLength(2);
    expect(raw[0].listener).toBe(first);
    expect(raw[1].listener).toBe(listener);
    expect(ee.listeners("e")).toEqual([first, listener]);
    expect(ee.listenerCount("e", listener)).toBe(1);
    ee.emit("e", 1, 2);
    ee.emit("e", 3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1, 2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(ee.listenerCount("e")).toBe(0);
  });

  it("removes a once listener by its original function", () => {
    const ee = new EventEmitter();
    const listener = vi.fn<(...args: unknown[]) => void>();
    ee.once("e", listener);
    ee.removeListener("e", listener);
    ee.emit("e");
    expect(listener).not.toHaveBeenCalled();
  });

  it("removes the last matching listener and supports off", () => {
    const ee = new EventEmitter();
    const order: string[] = [];
    const a = () => order.push("a");
    const b = () => order.push("b");
    ee.on("e", a).on("e", b).on("e", a);
    ee.off("e", a);
    ee.emit("e");
    expect(order).toEqual(["a", "b"]);
    ee.removeListener("missing", a);
    ee.removeListener("e", () => {});
    expect(ee.listenerCount("e")).toBe(2);
  });

  it("emits newListener before adding and removeListener after removing", () => {
    const ee = new EventEmitter();
    const events: unknown[] = [];
    const listener = () => {};
    ee.on("newListener", (name: string, fn: Listener) => {
      events.push(["new", name, fn === listener, ee.listenerCount(name)]);
    });
    ee.on("removeListener", (name: string, fn: Listener) => {
      events.push(["remove", name, fn === listener, ee.listenerCount(name)]);
    });
    ee.once("x", listener);
    ee.removeListener("x", listener);
    expect(events).toEqual([
      ["new", "removeListener", false, 0],
      ["new", "x", true, 0],
      ["remove", "x", true, 0],
    ]);
  });

  it("removeAllListeners for one event or all, emitting removeListener LIFO", () => {
    const run = (Ctor: new () => EventEmitter) => {
      const ee = new Ctor();
      const removed: string[] = [];
      const a = () => {};
      const b = () => {};
      ee.on("x", a).on("x", b).on("y", a);
      ee.on("removeListener", (name: string, fn: Listener) => {
        removed.push(`${name}:${fn === a ? "a" : fn === b ? "b" : "other"}`);
      });
      ee.removeAllListeners("x");
      const afterOne = [...removed];
      ee.removeAllListeners();
      return { afterOne, removed, names: ee.eventNames() };
    };
    const ours = run(EventEmitter);
    expect(ours.afterOne).toEqual(["x:b", "x:a"]);
    expect(ours).toEqual(run(nodeEvents as unknown as new () => EventEmitter));

    const quiet = new EventEmitter();
    quiet.on("x", () => {}).on("y", () => {});
    quiet.removeAllListeners("x");
    expect(quiet.eventNames()).toEqual(["y"]);
    quiet.removeAllListeners();
    expect(quiet.eventNames()).toEqual([]);
  });

  it("keeps the listener set of an emit fixed while listeners change it", () => {
    const run = (Ctor: new () => EventEmitter) => {
      const ee = new Ctor();
      const calls: string[][] = [];
      let current: string[] = [];
      const b = () => current.push("b");
      const c = () => current.push("c");
      const a = () => {
        current.push("a");
        ee.removeListener("e", b);
        ee.on("e", c);
      };
      const d = () => {
        current.push("d");
        ee.removeListener("e", d);
        ee.prependListener("e", c);
      };
      ee.on("e", a).on("e", b).on("e", d);
      for (let i = 0; i < 3; i++) {
        current = [];
        ee.emit("e");
        calls.push(current);
      }
      return calls;
    };
    const ours = run(EventEmitter);
    expect(ours[0]).toEqual(["a", "b", "d"]);
    expect(ours).toEqual(run(nodeEvents as unknown as new () => EventEmitter));
  });

  it("calls listeners with the emitter as this and returns whether any listened", () => {
    const ee = new EventEmitter();
    const receivers: unknown[] = [];
    ee.on("e", function (this: unknown) {
      receivers.push(this);
    });
    expect(ee.emit("e")).toBe(true);
    expect(receivers).toEqual([ee]);
    expect(ee.emit("other")).toBe(false);
  });

  it("validates listeners with Node's error", () => {
    const ee = new EventEmitter();
    const theirs = new nodeEvents.EventEmitter();
    for (const bad of [undefined, null, 1, "x", {}]) {
      expect(thrown(() => ee.on("e", bad as never))).toEqual(
        thrown(() => theirs.on("e", bad as never)),
      );
      expect(thrown(() => ee.once("e", bad as never))).toEqual(
        thrown(() => theirs.once("e", bad as never)),
      );
      expect(thrown(() => ee.removeListener("e", bad as never))).toEqual(
        thrown(() => theirs.removeListener("e", bad as never)),
      );
    }
    expect(thrown(() => ee.on("e", 1 as never)).code).toBe("ERR_INVALID_ARG_TYPE");
  });
});

describe("error events", () => {
  it("throws an Error argument when nobody listens", () => {
    const ee = new EventEmitter();
    const error = new Error("boom");
    expect(() => ee.emit("error", error)).toThrow(error);
  });

  it("wraps a non-Error in ERR_UNHANDLED_ERROR with Node's message", () => {
    for (const value of ["boom", 42, undefined, { a: 1 }, null]) {
      const ours = thrown(() => new EventEmitter().emit("error", value));
      const theirs = thrown(() => new nodeEvents.EventEmitter().emit("error", value));
      expect(ours).toEqual(theirs);
    }
    let context: unknown;
    try {
      new EventEmitter().emit("error", "ctx");
    } catch (error) {
      context = (error as { context?: unknown }).context;
    }
    expect(context).toBe("ctx");
  });

  it("runs errorMonitor first and still throws without an error listener", () => {
    const ee = new EventEmitter();
    const monitor = vi.fn<(...args: unknown[]) => void>();
    ee.on(errorMonitor, monitor);
    expect(EventEmitter.errorMonitor).toBe(errorMonitor);
    const error = new Error("x");
    expect(() => ee.emit("error", error)).toThrow(error);
    expect(monitor).toHaveBeenCalledWith(error);
    const handler = vi.fn<(...args: unknown[]) => void>();
    ee.on("error", handler);
    expect(ee.emit("error", error)).toBe(true);
    expect(monitor).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(error);
  });
});

describe("max listeners", () => {
  it("warns once per emitter and event through process.emitWarning", () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const ee = new EventEmitter();
      ee.setMaxListeners(2);
      expect(ee.getMaxListeners()).toBe(2);
      for (let i = 0; i < 5; i++) {
        ee.on("leak", () => {});
      }
      expect(spy).toHaveBeenCalledTimes(1);
      const warning = spy.mock.calls[0][0] as Error & {
        emitter: unknown;
        type: unknown;
        count: number;
      };
      expect(warning.name).toBe("MaxListenersExceededWarning");
      expect(warning.message).toBe(
        "Possible EventEmitter memory leak detected. 3 leak listeners added to [EventEmitter]. MaxListeners is 2. Use emitter.setMaxListeners() to increase limit",
      );
      expect(warning.emitter).toBe(ee);
      expect(warning.type).toBe("leak");
      expect(warning.count).toBe(3);
      ee.setMaxListeners(0);
      for (let i = 0; i < 5; i++) {
        ee.on("other", () => {});
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("validates and applies defaultMaxListeners and setMaxListeners", () => {
    expect(EventEmitter.defaultMaxListeners).toBe(10);
    expect(
      thrown(() => {
        EventEmitter.defaultMaxListeners = -1;
      }),
    ).toEqual(
      thrown(() => {
        nodeEvents.defaultMaxListeners = -1;
      }),
    );
    expect(
      thrown(() => {
        EventEmitter.defaultMaxListeners = "1" as never;
      }),
    ).toEqual(
      thrown(() => {
        nodeEvents.defaultMaxListeners = "1" as never;
      }),
    );
    expect(thrown(() => new EventEmitter().setMaxListeners(-1))).toEqual(
      thrown(() => new nodeEvents.EventEmitter().setMaxListeners(-1)),
    );
    expect(thrown(() => new EventEmitter().setMaxListeners(NaN))).toEqual(
      thrown(() => new nodeEvents.EventEmitter().setMaxListeners(NaN)),
    );
    EventEmitter.defaultMaxListeners = 20;
    try {
      expect(new EventEmitter().getMaxListeners()).toBe(20);
      EventEmitter.setMaxListeners(15);
      expect(EventEmitter.defaultMaxListeners).toBe(15);
    } finally {
      EventEmitter.defaultMaxListeners = 10;
    }
    const a = new EventEmitter();
    const target = new EventTarget();
    EventEmitter.setMaxListeners(3, a, target);
    expect(a.getMaxListeners()).toBe(3);
    expect(getMaxListeners(a)).toBe(3);
    expect(getMaxListeners(target)).toBe(3);
    expect(getMaxListeners(new EventTarget())).toBe(10);
    expect(thrown(() => EventEmitter.setMaxListeners(1, {}))).toEqual(
      thrown(() => nodeEvents.setMaxListeners(1, {} as never)),
    );
    expect(thrown(() => getMaxListeners({}))).toEqual(
      thrown(() => nodeEvents.getMaxListeners({} as never)),
    );
  });
});

describe("captureRejections", () => {
  it("routes a rejected listener promise to 'error'", async () => {
    const ee = new EventEmitter({ captureRejections: true });
    const error = new Error("rejected");
    const seen = new Promise((resolve) => ee.on("error", resolve));
    ee.on("e", async () => {
      throw error;
    });
    ee.emit("e");
    await expect(seen).resolves.toBe(error);
  });

  it("prefers a Symbol.for('nodejs.rejection') method", async () => {
    const ee = new EventEmitter({ captureRejections: true }) as EventEmitter &
      Record<symbol, unknown>;
    expect(EventEmitter.captureRejectionSymbol).toBe(Symbol.for("nodejs.rejection"));
    expect(captureRejectionSymbol).toBe(Symbol.for("nodejs.rejection"));
    const seen = new Promise<unknown[]>((resolve) => {
      ee[captureRejectionSymbol] = (...args: unknown[]) => resolve(args);
    });
    const error = new Error("x");
    ee.on("e", () => Promise.reject(error));
    ee.emit("e", 1, 2);
    await expect(seen).resolves.toEqual([error, "e", 1, 2]);
  });

  it("is off by default and toggles globally with validation", () => {
    expect(EventEmitter.captureRejections).toBe(false);
    expect(
      thrown(() => {
        EventEmitter.captureRejections = "yes" as never;
      }),
    ).toEqual(
      thrown(() => {
        nodeEvents.captureRejections = "yes" as never;
      }),
    );
    EventEmitter.captureRejections = true;
    try {
      expect(EventEmitter.captureRejections).toBe(true);
    } finally {
      EventEmitter.captureRejections = false;
    }
  });
});

describe("events.once", () => {
  it("resolves with the event's arguments", async () => {
    const ee = new EventEmitter();
    const pending = once(ee, "ready");
    ee.emit("ready", 1, 2);
    await expect(pending).resolves.toEqual([1, 2]);
    expect(ee.listenerCount("error")).toBe(0);
    expect(EventEmitter.once).toBe(once);
  });

  it("rejects on 'error'", async () => {
    const ee = new EventEmitter();
    const pending = once(ee, "ready");
    const error = new Error("bad");
    ee.emit("error", error);
    await expect(pending).rejects.toBe(error);
    expect(ee.listenerCount("ready")).toBe(0);
  });

  it("works on an EventTarget", async () => {
    const target = new EventTarget();
    const pending = once(target, "ping");
    const event = new Event("ping");
    target.dispatchEvent(event);
    await expect(pending).resolves.toEqual([event]);
  });

  it("rejects with AbortError on abort, before and after the call", async () => {
    const controller = new AbortController();
    const ee = new EventEmitter();
    const pending = once(ee, "never", { signal: controller.signal });
    controller.abort("why");
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
      cause: "why",
    });
    expect(ee.listenerCount("never")).toBe(0);
    expect(ee.listenerCount("error")).toBe(0);
    await expect(once(ee, "x", { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORT_ERR",
      message: "The operation was aborted",
    });
  });

  it("validates its options as Node does", async () => {
    const ee = new EventEmitter();
    const theirs = new nodeEvents.EventEmitter();
    for (const bad of [null, 1, "x"]) {
      const ourError = await once(ee, "x", bad as never).catch((e: unknown) => e);
      const theirError = await nodeEvents.once(theirs, "x", bad as never).catch((e: unknown) => e);
      expect(ourError).toMatchObject({
        code: (theirError as { code: string }).code,
        message: (theirError as { message: string }).message,
      });
    }
    const badSignal = await once(ee, "x", { signal: {} as never }).catch((e: unknown) => e);
    const theirBadSignal = await nodeEvents
      .once(theirs, "x", { signal: {} as never })
      .catch((e: unknown) => e);
    expect((badSignal as Error).message).toBe((theirBadSignal as Error).message);
  });
});

describe("events.on", () => {
  it("iterates events in order, buffering early ones", async () => {
    const ee = new EventEmitter();
    const iterator = on(ee, "data");
    ee.emit("data", 1);
    ee.emit("data", 2, "b");
    const values: unknown[] = [];
    for await (const value of iterator) {
      values.push(value);
      if (values.length === 2) {
        setTimeout(() => ee.emit("data", 3), 0);
      }
      if (values.length === 3) {
        break;
      }
    }
    expect(values).toEqual([[1], [2, "b"], [3]]);
    expect(ee.listenerCount("data")).toBe(0);
    expect(ee.listenerCount("error")).toBe(0);
    expect(EventEmitter.on).toBe(on);
  });

  it("ends on a close event", async () => {
    const ee = new EventEmitter();
    const iterator = on(ee, "data", { close: ["end"] });
    const pendingNext = iterator.next();
    ee.emit("end");
    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("rejects the next call on 'error'", async () => {
    const ee = new EventEmitter();
    const iterator = on(ee, "data");
    const error = new Error("fail");
    ee.emit("error", error);
    await expect(iterator.next()).rejects.toBe(error);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("throws AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const ee = new EventEmitter();
    const iterator = on(ee, "data", { signal: controller.signal });
    const pendingNext = iterator.next();
    controller.abort();
    await expect(pendingNext).rejects.toMatchObject({ name: "AbortError" });
    expect(ee.listenerCount("data")).toBe(0);
    expect(() => on(ee, "data", { signal: controller.signal })).toThrow(
      expect.objectContaining({ code: "ABORT_ERR" }),
    );
  });

  it("pauses and resumes the emitter around the watermarks", async () => {
    const ee = new EventEmitter() as EventEmitter & { pause(): void; resume(): void };
    ee.pause = vi.fn<(...args: unknown[]) => void>();
    ee.resume = vi.fn<(...args: unknown[]) => void>();
    const iterator = on(ee, "data", { highWaterMark: 2, lowWaterMark: 1 });
    ee.emit("data", 1);
    ee.emit("data", 2);
    expect(ee.pause).not.toHaveBeenCalled();
    ee.emit("data", 3);
    expect(ee.pause).toHaveBeenCalledTimes(1);
    await iterator.next();
    await iterator.next();
    expect(ee.resume).not.toHaveBeenCalled();
    await iterator.next();
    expect(ee.resume).toHaveBeenCalledTimes(1);
    await iterator.return?.();
  });

  it("validates throw() and the watermarks as Node does", () => {
    const ee = new EventEmitter();
    const theirs = new nodeEvents.EventEmitter();
    expect(thrown(() => on(ee, "x").throw?.("not an error"))).toEqual(
      thrown(() => nodeEvents.on(theirs, "x").throw?.("not an error")),
    );
    expect(thrown(() => on(ee, "x", { highWaterMark: 0 }))).toEqual(
      thrown(() => nodeEvents.on(theirs, "x", { highWaterMark: 0 })),
    );
  });
});

describe("statics", () => {
  it("getEventListeners copies an emitter's listeners", () => {
    const ee = new EventEmitter();
    const a = () => {};
    ee.on("x", a);
    expect(getEventListeners(ee, "x")).toEqual([a]);
    expect(EventEmitter.getEventListeners).toBe(getEventListeners);
    expect(() => getEventListeners(new EventTarget(), "x")).toThrow(/getEventListeners/);
    expect(thrown(() => getEventListeners({}, "x"))).toEqual(
      thrown(() => nodeEvents.getEventListeners({} as never, "x")),
    );
  });

  it("addAbortListener listens once and can be disposed", async () => {
    const controller = new AbortController();
    const listener = vi.fn<(...args: unknown[]) => void>();
    const disposable = addAbortListener(controller.signal, listener);
    const dispose = Symbol.for("nodejs.dispose");
    const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose ?? dispose;
    expect(typeof disposable[disposeKey]).toBe("function");
    controller.abort();
    expect(listener).toHaveBeenCalledTimes(1);

    const second = new AbortController();
    const removed = vi.fn<(...args: unknown[]) => void>();
    addAbortListener(second.signal, removed)[disposeKey]();
    second.abort();
    expect(removed).not.toHaveBeenCalled();

    const late = vi.fn<(...args: unknown[]) => void>();
    addAbortListener(controller.signal, late);
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);

    expect(thrown(() => addAbortListener(undefined as never, () => {}))).toEqual(
      thrown(() => nodeEvents.addAbortListener(undefined as never, () => {})),
    );
    expect(thrown(() => addAbortListener(controller.signal, 1 as never))).toEqual(
      thrown(() => nodeEvents.addAbortListener(controller.signal, 1 as never)),
    );
  });

  it("EventEmitterAsyncResource emits and names its unsupported members", () => {
    const Resource = EventEmitter.EventEmitterAsyncResource;
    expect(thrown(() => new Resource())).toEqual(
      thrown(() => new nodeEvents.EventEmitterAsyncResource()),
    );
    const resource = new Resource({ name: "r" });
    const listener = vi.fn<(...args: unknown[]) => void>();
    resource.on("x", listener);
    resource.emit("x", 1);
    expect(listener).toHaveBeenCalledWith(1);
    expect(resource).toBeInstanceOf(EventEmitter);
    expect(() => resource.asyncResource).toThrow(/asyncResource/);
    expect(() => resource.emitDestroy()).toThrow(/emitDestroy/);
    class Sub extends Resource {}
    expect(() => new Sub()).not.toThrow();
  });

  it("exposes Node's static surface", () => {
    expect(EventEmitter.usingDomains).toBe(false);
    expect(typeof EventEmitter.init).toBe("function");
    expect(typeof EventEmitter.kMaxEventTargetListeners).toBe("symbol");
    const ours = Object.keys(EventEmitter).sort();
    const theirs = Object.keys(nodeEvents)
      .filter((key) => key !== "listenerCount" || "listenerCount" in EventEmitter)
      .sort();
    expect(ours).toEqual(theirs);
    for (const name of [
      "once",
      "on",
      "getEventListeners",
      "getMaxListeners",
      "setMaxListeners",
      "listenerCount",
      "addAbortListener",
      "EventEmitterAsyncResource",
      "errorMonitor",
      "captureRejectionSymbol",
      "defaultMaxListeners",
      "captureRejections",
    ]) {
      expect(name in EventEmitter).toBe(true);
    }
    expect(Object.getOwnPropertyNames(EventEmitter.prototype).sort()).toEqual(
      Object.getOwnPropertyNames(nodeEvents.prototype).sort(),
    );
  });
});
