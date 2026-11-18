// @vitest-environment node
// How a thread-pool job's callback is delivered: from the event loop, in the
// async context of the call, with the process held open meanwhile.
import { afterEach, describe, expect, it } from "vitest";
import { setRuntime } from "../../runtime";
import { createFakeRuntime } from "../../testing/fakeRuntime";
import { AsyncLocalStorage } from "../async_hooks";
import { runJob, settleJob } from "./threadPoolJob";

afterEach(() => {
  setRuntime(null);
});

/** Lets the promise jobs of the current task run: far more hops than any job here takes. */
async function promiseJobs(): Promise<void> {
  for (let hop = 0; hop < 200; hop += 1) {
    await Promise.resolve();
  }
}

describe("runJob", () => {
  it("runs the work and calls back in a later task, not in the caller's", async () => {
    const order: string[] = [];
    const result = new Promise<unknown>((resolve) => {
      runJob(
        () => {
          order.push("work");
          return 7;
        },
        (error, value) => {
          order.push("callback");
          resolve([error, value]);
        },
      );
    });
    order.push("returned");
    await promiseJobs();
    expect(order).toEqual(["returned"]);
    expect(await result).toEqual([null, 7]);
    expect(order).toEqual(["returned", "work", "callback"]);
  });

  it("gives the callback what the work threw", async () => {
    const failure = new Error("no key");
    const args = await new Promise<unknown[]>((resolve) => {
      runJob(
        (): number => {
          throw failure;
        },
        (...given) => resolve(given),
      );
    });
    expect(args).toEqual([failure]);
  });

  it("does not catch what the callback throws", async () => {
    const thrown = new Error("from the callback");
    const caught = new Promise<unknown>((resolve) => process.once("uncaughtException", resolve));
    let calls = 0;
    runJob(
      () => 1,
      () => {
        calls += 1;
        throw thrown;
      },
    );
    expect(await caught).toBe(thrown);
    expect(calls).toBe(1);
  });

  it("calls back in the async context of the call", async () => {
    const storage = new AsyncLocalStorage<string>();
    const seen = await new Promise<unknown>((resolve) => {
      storage.run("caller", () =>
        runJob(
          () => 1,
          () => resolve(storage.getStore()),
        ),
      );
    });
    expect(seen).toBe("caller");
  });

  it("holds the process until the callback has run", async () => {
    const fake = createFakeRuntime();
    setRuntime(fake);
    const done = new Promise<number>((resolve) =>
      runJob(
        () => 1,
        () => resolve(fake.refCount),
      ),
    );
    expect(fake.refCount).toBe(1);
    await done;
    await promiseJobs();
    expect(fake.refCount).toBe(0);
  });
});

describe("settleJob", () => {
  it("calls back in a task after the work settled, with its value or its reason", async () => {
    let settle!: (value: string) => void;
    const order: string[] = [];
    const result = new Promise<unknown>((resolve) => {
      settleJob(
        new Promise<string>((resolve_) => {
          settle = resolve_;
        }),
        (error, value) => {
          order.push("callback");
          resolve([error, value]);
        },
      );
    });
    settle("key");
    order.push("settled");
    await promiseJobs();
    expect(order).toEqual(["settled"]);
    expect(await result).toEqual([null, "key"]);

    const reason = new Error("refused");
    const args = await new Promise<unknown[]>((resolve) => {
      settleJob(Promise.reject<number>(reason), (...given) => resolve(given));
    });
    expect(args).toEqual([reason]);
  });

  it("calls back in the async context of the call", async () => {
    const storage = new AsyncLocalStorage<string>();
    const seen = await new Promise<unknown>((resolve) => {
      storage.run("caller", () => settleJob(Promise.resolve(1), () => resolve(storage.getStore())));
    });
    expect(seen).toBe("caller");
  });

  it("holds the process from the call until the callback has run", async () => {
    const fake = createFakeRuntime();
    setRuntime(fake);
    let settle!: () => void;
    const held: number[] = [];
    const done = new Promise<void>((resolve) => {
      settleJob(
        new Promise<void>((resolve_) => {
          settle = resolve_;
        }),
        () => {
          held.push(fake.refCount);
          resolve();
        },
      );
    });
    // While the work runs, and while its callback waits for its task.
    held.push(fake.refCount);
    settle();
    await promiseJobs();
    held.push(fake.refCount);
    await done;
    await promiseJobs();
    held.push(fake.refCount);
    expect(held.map((count) => count > 0)).toEqual([true, true, true, false]);
  });
});
