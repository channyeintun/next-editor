// @vitest-environment node
import { AsyncLocalStorage } from "node:async_hooks";
import * as nodeDc from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import * as ours from "./diagnostics_channel";

type Dc = typeof nodeDc;
const impls: [string, Dc][] = [
  ["node", nodeDc],
  ["webnode", ours as unknown as Dc],
];

let counter = 0;
const unique = (label: string) => `webnode-test:${label}:${counter++}`;

/** Runs `scenario` against real Node and webnode: `[nodeLog, webnodeLog]`. */
async function both(scenario: (dc: Dc, log: unknown[]) => unknown): Promise<unknown[][]> {
  const logs: unknown[][] = [];
  for (const [, dc] of impls) {
    const log: unknown[] = [];
    await scenario(dc, log);
    logs.push(log);
  }
  return logs;
}

describe("diagnostics_channel", () => {
  it("publishes to subscribers and tracks hasSubscribers", async () => {
    const [nodeLog, log] = await both((dc, log) => {
      const name = unique("pub");
      const ch = dc.channel(name);
      log.push(ch.hasSubscribers, dc.hasSubscribers(name), ch instanceof dc.Channel);
      ch.publish("nobody");
      const fn = (message: unknown, from: string | symbol) => log.push(message, from === name);
      dc.subscribe(name, fn);
      log.push(ch.hasSubscribers, dc.hasSubscribers(name), dc.channel(name) === ch);
      ch.publish({ a: 1 });
      log.push(dc.unsubscribe(name, fn), dc.unsubscribe(name, fn), ch.hasSubscribers);
      log.push(ch instanceof dc.Channel);
    });
    expect(log).toEqual(nodeLog);
    expect(log).toContain(true);
  });

  it("lets a subscriber unsubscribe during publish", async () => {
    const [expected, actual] = await both((dc, log) => {
      const ch = dc.channel(unique("unsub"));
      const a = () => {
        log.push("a");
        ch.unsubscribe(a);
      };
      const b = () => log.push("b");
      ch.subscribe(a);
      ch.subscribe(b);
      ch.publish(1);
      ch.publish(2);
    });
    expect(actual).toEqual(expected);
  });

  it("validates names and subscribers", () => {
    for (const [, dc] of impls) {
      expect(() => dc.channel(1 as never)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
      expect(() => dc.channel(unique("v")).subscribe(1 as never)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
      expect(() => dc.tracingChannel(1 as never)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    }
  });

  it("accepts symbol names", async () => {
    const [expected, actual] = await both((dc, log) => {
      const name = Symbol("sym");
      dc.subscribe(name, (m) => log.push(m));
      dc.channel(name).publish("s");
    });
    expect(actual).toEqual(expected);
  });

  it("runs stores with transforms", async () => {
    const [expected, actual] = await both((dc, log) => {
      const ch = dc.channel(unique("stores"));
      const store = new AsyncLocalStorage<unknown>();
      log.push(ch.runStores(1, (x: number) => x + 1, undefined, 1));
      ch.bindStore(store, (data) => ({ wrapped: data }));
      log.push(ch.hasSubscribers);
      ch.subscribe(() => log.push("sub", store.getStore()));
      const result = ch.runStores(
        "d",
        function (this: unknown, a: number) {
          log.push("inside", store.getStore(), this, a);
          return "r";
        },
        "this",
        5,
      );
      log.push(result, store.getStore());
      log.push(ch.unbindStore(store), ch.unbindStore(store));
    });
    expect(actual).toEqual(expected);
  });

  it("traces sync calls, including throws", async () => {
    const [expected, actual] = await both((dc, log) => {
      const tc = dc.tracingChannel(unique("sync"));
      log.push(
        tc.hasSubscribers,
        tc.traceSync(() => 1),
      );
      const handlers = {
        start: (m: unknown) => log.push("start", { ...(m as object) }),
        end: (m: unknown) => log.push("end", { ...(m as object) }),
        asyncStart: (m: unknown) => log.push("asyncStart", m),
        asyncEnd: (m: unknown) => log.push("asyncEnd", m),
        error: (m: unknown) => log.push("error", (m as { error: Error }).error.message),
      };
      tc.subscribe(handlers);
      log.push(tc.traceSync((a: number) => a * 2, { id: 1 }, undefined, 4));
      try {
        tc.traceSync(() => {
          throw new Error("boom");
        });
      } catch (error) {
        log.push("caught", (error as Error).message);
      }
      log.push(tc.unsubscribe(handlers), tc.hasSubscribers);
    });
    expect(actual).toEqual(expected);
  });

  it("traces promises", async () => {
    const [expected, actual] = await both(async (dc, log) => {
      const tc = dc.tracingChannel(unique("promise"));
      tc.subscribe({
        start: () => log.push("start"),
        end: () => log.push("end"),
        asyncStart: (m: unknown) => log.push("asyncStart", (m as { result?: unknown }).result),
        asyncEnd: () => log.push("asyncEnd"),
        error: (m: unknown) => log.push("error", (m as { error: Error }).error.message),
      });
      log.push(await tc.tracePromise(async () => "ok"));
      await tc
        .tracePromise(async () => Promise.reject(new Error("no")))
        .catch((error) => {
          log.push("rejected", (error as Error).message);
        });
    });
    expect(actual).toEqual(expected);
  });

  it("turns a traced thenable into a native promise, as Node 22 does", async () => {
    const tc = ours.tracingChannel(unique("thenable"));
    const log: string[] = [];
    tc.subscribe({ end: () => log.push("end"), asyncStart: () => log.push("asyncStart") });
    // eslint-disable-next-line unicorn/no-thenable -- the test needs a thenable that is not a Promise
    const thenable = { then: (r: (v: number) => void) => r(3) };
    const result = tc.tracePromise(() => thenable as never);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(3);
    expect(log).toEqual(["end", "asyncStart"]);
  });

  it("traces callbacks", async () => {
    const [expected, actual] = await both(async (dc, log) => {
      const tc = dc.tracingChannel(unique("cb"));
      tc.subscribe({
        start: () => log.push("start"),
        end: () => log.push("end"),
        asyncStart: (m: unknown) => log.push("asyncStart", (m as { result?: unknown }).result),
        asyncEnd: () => log.push("asyncEnd"),
        error: () => log.push("error"),
      });
      await new Promise<void>((resolve) => {
        tc.traceCallback(
          (value: number, cb: (err: unknown, res?: number) => void) => {
            queueMicrotask(() => cb(null, value + 1));
          },
          -1,
          {},
          undefined,
          41,
          (err: unknown, res?: number) => {
            log.push("callback", err, res);
            resolve();
          },
        );
      });
      try {
        (tc.traceCallback as (...args: unknown[]) => unknown)(() => {}, -1, {}, undefined, "x");
      } catch (error) {
        log.push((error as { code: string }).code);
      }
    });
    expect(actual).toEqual(expected);
  });

  it("builds a TracingChannel from channel objects", async () => {
    const [expected, actual] = await both((dc, log) => {
      const base = unique("objs");
      const channels = {
        start: dc.channel(`${base}:start`),
        end: dc.channel(`${base}:end`),
        asyncStart: dc.channel(`${base}:asyncStart`),
        asyncEnd: dc.channel(`${base}:asyncEnd`),
        error: dc.channel(`${base}:error`),
      };
      const tc = dc.tracingChannel(channels);
      log.push(tc.start === channels.start);
      channels.start.subscribe(() => log.push("started"));
      tc.traceSync(() => {});
    });
    expect(actual).toEqual(expected);
  });

  it("reports a throwing subscriber later and keeps publishing", async () => {
    const ch = ours.channel(unique("throw"));
    const log: string[] = [];
    ch.subscribe(() => {
      throw new Error("sub failed");
    });
    ch.subscribe(() => log.push("second"));
    const caught = new Promise<Error>((resolve) => {
      process.once("uncaughtException", resolve);
    });
    ch.publish(1);
    expect(log).toEqual(["second"]);
    expect((await caught).message).toBe("sub failed");
  });
});
