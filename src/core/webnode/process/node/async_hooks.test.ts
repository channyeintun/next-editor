// @vitest-environment node
import { describe, expect, it } from "vitest";
import asyncHooks, {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  bindToCurrentContext,
  captureAsyncContext,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
} from "./async_hooks";
import { setImmediate, setInterval, clearInterval, setTimeout } from "./timers";

const tick = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 5));

describe("async_hooks shape", () => {
  it("has Node's exports", () => {
    expect(Object.keys(asyncHooks).sort()).toEqual(
      [
        "AsyncLocalStorage",
        "createHook",
        "executionAsyncId",
        "triggerAsyncId",
        "executionAsyncResource",
        "asyncWrapProviders",
        "AsyncResource",
      ].sort(),
    );
    expect(Object.isFrozen(asyncWrapProviders)).toBe(true);
    expect(Object.getPrototypeOf(asyncWrapProviders)).toBe(null);
    expect(asyncWrapProviders.NONE).toBe(0);
    expect(asyncWrapProviders.PROMISE).toBeTypeOf("number");
  });
});

describe("AsyncLocalStorage", () => {
  it("run/exit nest synchronously and restore", () => {
    const als = new AsyncLocalStorage<number>();
    expect(als.getStore()).toBeUndefined();
    const result = als.run(
      1,
      (a: number, b: number) => {
        expect(als.getStore()).toBe(1);
        als.run(2, () => expect(als.getStore()).toBe(2));
        expect(als.getStore()).toBe(1);
        als.exit(() => expect(als.getStore()).toBeUndefined());
        expect(als.getStore()).toBe(1);
        return a + b;
      },
      2,
      3,
    );
    expect(result).toBe(5);
    expect(als.getStore()).toBeUndefined();
  });

  it("restores the store when the callback throws", () => {
    const als = new AsyncLocalStorage<string>();
    expect(() =>
      als.run("x", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(als.getStore()).toBeUndefined();
  });

  it("keeps independent storages apart", () => {
    const a = new AsyncLocalStorage<string>();
    const b = new AsyncLocalStorage<string>();
    a.run("a", () => {
      b.run("b", () => {
        expect(a.getStore()).toBe("a");
        expect(b.getStore()).toBe("b");
        a.exit(() => {
          expect(a.getStore()).toBeUndefined();
          expect(b.getStore()).toBe("b");
        });
      });
      expect(b.getStore()).toBeUndefined();
    });
  });

  it("propagates through then, catch, finally and queueMicrotask", async () => {
    const als = new AsyncLocalStorage<string>();
    const seen: unknown[] = [];
    await als.run("ctx", () => {
      queueMicrotask(() => seen.push(["microtask", als.getStore()]));
      return Promise.resolve()
        .then(() => {
          seen.push(["then", als.getStore()]);
          throw new Error("x");
        })
        .catch(() => seen.push(["catch", als.getStore()]))
        .finally(() => seen.push(["finally", als.getStore()]));
    });
    expect(seen).toEqual([
      ["microtask", "ctx"],
      ["then", "ctx"],
      ["catch", "ctx"],
      ["finally", "ctx"],
    ]);
    expect(als.getStore()).toBeUndefined();
  });

  it("propagates through webnode timers and immediates", async () => {
    const als = new AsyncLocalStorage<number>();
    const seen: unknown[] = [];
    als.run(7, () => {
      setTimeout(() => seen.push(["timeout", als.getStore()]), 1);
      setImmediate(() => seen.push(["immediate", als.getStore()]));
      const interval = setInterval(() => {
        seen.push(["interval", als.getStore()]);
        clearInterval(interval);
      }, 1);
    });
    als.run(8, () => {
      setTimeout(() => seen.push(["other", als.getStore()]), 1);
    });
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 30));
    expect(seen).toContainEqual(["timeout", 7]);
    expect(seen).toContainEqual(["immediate", 7]);
    expect(seen).toContainEqual(["interval", 7]);
    expect(seen).toContainEqual(["other", 8]);
  });

  it("enterWith sets the store for the rest of the execution", async () => {
    const als = new AsyncLocalStorage<string>();
    let later: string | undefined;
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        als.enterWith("entered");
        expect(als.getStore()).toBe("entered");
        setTimeout(() => {
          later = als.getStore();
          resolve();
        }, 1);
      });
    });
    expect(later).toBe("entered");
  });

  it("disable clears the store until the next run", () => {
    const als = new AsyncLocalStorage<number>();
    als.run(1, () => {
      als.disable();
      expect(als.getStore()).toBeUndefined();
      als.run(2, () => expect(als.getStore()).toBe(2));
    });
  });

  it("bind and snapshot capture the context", () => {
    const als = new AsyncLocalStorage<string>();
    const bound = als.run("bound", () => AsyncLocalStorage.bind(() => als.getStore()));
    const snapshot = als.run("snap", () => AsyncLocalStorage.snapshot());
    expect(bound()).toBe("bound");
    expect(snapshot(() => als.getStore())).toBe("snap");
    expect(snapshot((a: number, b: number) => a * b, 3, 4)).toBe(12);
    als.run("outer", () => expect(bound()).toBe("bound"));
  });

  it("bindToCurrentContext and captureAsyncContext wrap callbacks for the lead", () => {
    const als = new AsyncLocalStorage<string>();
    const wrapped = als.run("lead", () => bindToCurrentContext(() => als.getStore()));
    const capture = als.run("captured", () => captureAsyncContext());
    expect(wrapped()).toBe("lead");
    expect(capture(() => als.getStore())()).toBe("captured");
  });

  it("validates options and has a name", () => {
    expect(new AsyncLocalStorage({ name: "n" }).name).toBe("n");
    expect(() => new AsyncLocalStorage(5 as unknown as object)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});

describe("AsyncResource", () => {
  it("runs callbacks in the context it was created in", () => {
    const als = new AsyncLocalStorage<string>();
    const resource = als.run("res", () => new AsyncResource("TEST"));
    const thisArg = {};
    expect(
      resource.runInAsyncScope(
        function (this: unknown, a: number) {
          expect(this).toBe(thisArg);
          return [als.getStore(), a, executionAsyncId(), executionAsyncResource()];
        },
        thisArg,
        9,
      ),
    ).toEqual(["res", 9, resource.asyncId(), resource]);
    expect(triggerAsyncId()).toBe(0);
    expect(executionAsyncId()).toBe(1);
  });

  it("bind gives a bound function carrying asyncResource", () => {
    const als = new AsyncLocalStorage<string>();
    const resource = als.run("b", () => new AsyncResource("TEST", { triggerAsyncId: 1 }));
    const fn = resource.bind((x: number, y: number) => [als.getStore(), x + y]);
    expect(fn(1, 2)).toEqual(["b", 3]);
    expect(fn.length).toBe(2);
    expect((fn as unknown as { asyncResource: unknown }).asyncResource).toBe(resource);
    expect(resource.triggerAsyncId()).toBe(1);
    expect(resource.emitDestroy()).toBe(resource);
    const staticBound = als.run("s", () => AsyncResource.bind(() => als.getStore()));
    expect(staticBound()).toBe("s");
  });

  it("validates type", () => {
    expect(() => new AsyncResource(1 as unknown as string)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});

describe("createHook", () => {
  it("returns a hook whose enable/disable chain", () => {
    const hook = createHook({ init() {} });
    expect(hook.enable()).toBe(hook);
    expect(hook.disable()).toBe(hook);
    expect(() => createHook({ init: 1 as unknown as () => void })).toThrow(
      expect.objectContaining({ code: "ERR_ASYNC_CALLBACK" }),
    );
  });
});

describe("known gap", () => {
  it("a store survives an await on a thenable resolved through then", async () => {
    const als = new AsyncLocalStorage<string>();
    const value = await als.run("kept", async () => {
      await tick();
      return "done";
    });
    expect(value).toBe("done");
  });
});
