// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import timersPromises, {
  scheduler,
  setImmediate,
  setInterval,
  setTimeout,
} from "./timers_promises";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime();
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

describe("timers/promises", () => {
  it("has Node's exports", () => {
    expect(Object.keys(timersPromises)).toEqual([
      "setTimeout",
      "setImmediate",
      "setInterval",
      "scheduler",
    ]);
  });

  it("setTimeout resolves with the value and holds a ref meanwhile", async () => {
    const promise = setTimeout(5, "done");
    expect(fake.refCount).toBe(1);
    await expect(promise).resolves.toBe("done");
    expect(fake.refCount).toBe(0);
  });

  it("{ ref: false } does not keep the process alive", async () => {
    const promise = setTimeout(5, 1, { ref: false });
    expect(fake.refCount).toBe(0);
    await expect(promise).resolves.toBe(1);
  });

  it("setImmediate resolves with the value", async () => {
    await expect(setImmediate("v")).resolves.toBe("v");
    expect(fake.refCount).toBe(0);
  });

  it("rejects bad options", async () => {
    await expect(setTimeout(1, undefined, "x" as unknown as object)).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    await expect(setTimeout(1, undefined, { ref: 1 as unknown as boolean })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    await expect(
      setImmediate(undefined, { signal: {} as unknown as AbortSignal }),
    ).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
  });

  it("aborts with AbortError (ABORT_ERR) carrying the reason as cause", async () => {
    const controller = new AbortController();
    const promise = setTimeout(1000, "x", { signal: controller.signal });
    expect(fake.refCount).toBe(1);
    controller.abort("why");
    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
      message: "The operation was aborted",
      cause: "why",
    });
    expect(fake.refCount).toBe(0);
    await expect(setImmediate(1, { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORT_ERR",
    });
  });

  it("setInterval yields once per tick and clears on return", async () => {
    const seen: number[] = [];
    for await (const value of setInterval(5, 7)) {
      seen.push(value);
      if (seen.length === 3) {
        break;
      }
    }
    expect(seen).toEqual([7, 7, 7]);
    expect(fake.refCount).toBe(0);
  });

  it("setInterval throws AbortError when aborted", async () => {
    const controller = new AbortController();
    const iterator = setInterval(5, "v", { signal: controller.signal });
    await expect(iterator.next()).resolves.toEqual({ value: "v", done: false });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(fake.refCount).toBe(0);
  });

  it("scheduler.wait and scheduler.yield", async () => {
    await expect(scheduler.wait(2)).resolves.toBeUndefined();
    await expect(scheduler.yield()).resolves.toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    await expect(scheduler.wait(2, { signal: controller.signal })).rejects.toMatchObject({
      code: "ABORT_ERR",
    });
  });
});
