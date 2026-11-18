// @vitest-environment node
import * as nodePerf from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import perfHooks, { createHistogram, monitorEventLoopDelay, performance } from "./perf_hooks";

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state;
  };
}

function snapshot(h: {
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  exceeds: number;
  percentiles: Map<number, number>;
  percentile(p: number): number;
}) {
  return {
    count: h.count,
    min: h.min,
    max: h.max,
    mean: h.mean,
    stddev: h.stddev,
    exceeds: h.exceeds,
    percentiles: [...h.percentiles],
    p50: h.percentile(50),
    p99: h.percentile(99),
    p100: h.percentile(100),
  };
}

describe("perf_hooks histograms", () => {
  it("matches Node on an empty histogram", () => {
    expect(snapshot(createHistogram())).toEqual(snapshot(nodePerf.createHistogram()));
  });

  it.each([
    ["small values", 1, 200, 1],
    ["wide values", 2, 5000, 1_000_000_000],
    ["huge values", 3, 300, 2 ** 50],
  ])("matches Node's maths for %s", (_label, seed, n, scale) => {
    const ours = createHistogram();
    const theirs = nodePerf.createHistogram();
    const next = lcg(seed);
    for (let i = 0; i < n; i++) {
      const value = 1 + Math.floor((next() / 2 ** 31) * scale);
      ours.record(value);
      theirs.record(value);
    }
    expect(snapshot(ours)).toEqual(snapshot(theirs));
  });

  it("matches Node with custom bounds and figures, counting exceeds", () => {
    const ours = createHistogram({ lowest: 10, highest: 100_000, figures: 2 });
    const theirs = nodePerf.createHistogram({ lowest: 10, highest: 100_000, figures: 2 });
    for (const value of [10, 15, 99, 1234, 99_999, 1_000_000, 7]) {
      ours.record(value);
      theirs.record(value);
    }
    expect(snapshot(ours)).toEqual(snapshot(theirs));
  });

  it("adds, resets and records bigints", () => {
    const a = createHistogram();
    const b = createHistogram();
    a.record(5);
    b.record(10n);
    b.record(20);
    a.add(b);
    expect(a.count).toBe(3);
    expect(a.max).toBe(20);
    expect(a.minBigInt).toBe(5n);
    a.reset();
    expect(a.count).toBe(0);
    expect(a.minBigInt).toBe(9223372036854775807n);
  });

  it("validates like Node", () => {
    const h = createHistogram();
    expect(() => h.record(0)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => h.percentile(0)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => createHistogram({ figures: 6 })).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
    expect(() => h.add({} as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("records deltas in nanoseconds", async () => {
    const h = createHistogram();
    h.recordDelta();
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.recordDelta();
    expect(h.count).toBe(1);
    expect(h.min).toBeGreaterThan(1_000_000);
  });

  it("samples the event loop delay while enabled, and only then", async () => {
    const h = monitorEventLoopDelay({ resolution: 2 });
    expect(h.enable()).toBe(true);
    expect(h.enable()).toBe(false);
    // Until it has samples, however long the event loop takes to give them:
    // a busy machine may run no interval callback for longer than any fixed wait.
    while (h.count < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(h.disable()).toBe(true);
    expect(h.disable()).toBe(false);
    const sampled = h.count;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.count).toBe(sampled);
    expect(() => monitorEventLoopDelay({ resolution: 0 })).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });

  describe("on a clock the test drives", () => {
    // The sampler's interval and clock are the ones the module finds when it
    // is evaluated, so a copy evaluated under the fake clock samples exactly
    // when the test says. What a real interval's gaps are is the scheduler's
    // business: a late callback is followed by one on time, far under the
    // resolution apart.
    let fresh: typeof import("./perf_hooks");

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      vi.resetModules();
      fresh = await import("./perf_hooks");
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.resetModules();
    });

    it("records the gap between two samples in nanoseconds", () => {
      const h = fresh.monitorEventLoopDelay({ resolution: 2 });
      h.enable();
      // The first callback has nothing to measure from.
      vi.advanceTimersByTime(2);
      expect(h.count).toBe(0);
      vi.advanceTimersByTime(10);
      expect(h.count).toBe(5);
      // 2 ms, in the histogram's bucket for it (three significant figures).
      const twoMs = createHistogram();
      twoMs.record(2_000_000);
      expect(h.min).toBe(twoMs.min);
      expect(h.max).toBe(twoMs.max);
      expect(h.min).toBeGreaterThan(1_990_000);
      expect(h.max).toBeLessThan(2_010_000);
    });

    it("stops at disable() and measures afresh after enable()", () => {
      const h = fresh.monitorEventLoopDelay({ resolution: 5 });
      h.enable();
      vi.advanceTimersByTime(15);
      expect(h.count).toBe(2);
      h.disable();
      vi.advanceTimersByTime(1000);
      expect(h.count).toBe(2);
      // The time it spent disabled is no sample: the first callback after
      // enable() only marks the time.
      h.enable();
      vi.advanceTimersByTime(10);
      expect(h.count).toBe(3);
      expect(h.max).toBeLessThan(5_010_000);
      h.disable();
    });
  });
});

describe("perf_hooks.performance", () => {
  it("is the global performance with Node's extras", () => {
    expect(performance.now()).toBeGreaterThan(0);
    expect(performance.timeOrigin).toBe(globalThis.performance.timeOrigin);
    expect(performance.eventLoopUtilization()).toEqual({ idle: 0, active: 0, utilization: 0 });
    performance.mark("webnode-test");
    expect(performance.getEntriesByName("webnode-test").length).toBe(1);
  });

  it("timerifies functions and records into a histogram", async () => {
    const histogram = createHistogram();
    const add = (a: number, b: number) => a + b;
    const timed = performance.timerify(add, { histogram });
    expect(timed.name).toBe("timerified add");
    expect(timed(1, 2)).toBe(3);
    expect(performance.timerify(add)).toBe(timed);
    expect(histogram.count).toBe(1);
    const later = performance.timerify(async () => 7, { histogram });
    await expect(later()).resolves.toBe(7);
    expect(histogram.count).toBe(2);
  });

  it("exports Node 22's names", () => {
    expect(Object.keys(perfHooks).sort()).toEqual(
      [
        "Performance",
        "PerformanceEntry",
        "PerformanceMark",
        "PerformanceMeasure",
        "PerformanceObserver",
        "PerformanceObserverEntryList",
        "PerformanceResourceTiming",
        "constants",
        "createHistogram",
        "monitorEventLoopDelay",
        "performance",
      ].sort(),
    );
    expect(perfHooks.PerformanceObserver).toBe(globalThis.PerformanceObserver);
  });
});
