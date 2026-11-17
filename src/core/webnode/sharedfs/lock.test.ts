// @vitest-environment node
// The mutex (lock.ts) with real worker threads under heavy contention: only one
// holder at a time, and no waiter left asleep while the lock is free. A lost
// wake-up shows as workers that never finish, which the watchdog fails.
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

/** Word 0: the lock. Word 1: the counter it guards. Word 2: holders right now. */
const LOCK = 0;
const COUNTER = 1;
const INSIDE = 2;

/**
 * Each worker takes the lock `rounds` times. Inside, it checks it is alone,
 * increments the counter with a plain read and write (which a second holder
 * would make lose updates), and on some rounds holds on long enough that the
 * others must sleep rather than spin.
 */
const WORKER_SOURCE = `
const { registerHooks } = require("node:module");
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return next(specifier + ".ts", context);
    }
  },
});
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url).then(({ acquireLock, releaseLock }) => {
  const { words, rounds, index } = workerData;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let overlaps = 0;
  for (let i = 0; i < rounds; i++) {
    acquireLock(words, ${LOCK});
    if (Atomics.add(words, ${INSIDE}, 1) !== 0) overlaps++;
    const value = words[${COUNTER}];
    if ((i + index) % 997 === 0) Atomics.wait(pause, 0, 0, 1);
    words[${COUNTER}] = value + 1;
    Atomics.sub(words, ${INSIDE}, 1);
    releaseLock(words, ${LOCK});
  }
  parentPort.postMessage({ overlaps });
}).catch((error) => parentPort.postMessage({ error: String(error?.stack ?? error) }));
`;

function run(words: Int32Array, workers: number, rounds: number): Promise<{ overlaps: number }[]> {
  const started = Array.from({ length: workers }, (_, index) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url: new URL("./lock.ts", import.meta.url).href, words, rounds, index },
    });
    const done = new Promise<{ overlaps: number }>((resolve, reject) => {
      worker.once("message", (value: { overlaps: number; error?: string }) =>
        value.error === undefined ? resolve(value) : reject(new Error(value.error)),
      );
      worker.once("error", reject);
    });
    return { worker, done };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadlock: a waiter was never woken")), 30_000);
  });
  return Promise.race([Promise.all(started.map(({ done }) => done)), watchdog]).finally(() => {
    clearTimeout(timer);
    void Promise.all(started.map(({ worker }) => worker.terminate()));
  });
}

describe("lock", () => {
  it("admits one holder at a time and wakes every waiter, across eight workers", async () => {
    const words = new Int32Array(new SharedArrayBuffer(12));
    const rounds = 40_000;
    const results = await run(words, 8, rounds);
    expect(results.map((result) => result.overlaps)).toEqual(Array.from({ length: 8 }, () => 0));
    expect(words[COUNTER]).toBe(8 * rounds);
    expect(Atomics.load(words, LOCK)).toBe(0);
  }, 90_000);
});
