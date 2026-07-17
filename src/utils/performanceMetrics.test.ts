import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushPerformanceMetrics,
  installPerformanceMetricsReporter,
  recordPerformanceMetric,
  resetPerformanceMetricsForTests,
  startPerformanceSpan,
} from "./performanceMetrics";

afterEach(() => {
  resetPerformanceMetricsForTests();
  vi.useRealTimers();
});

describe("performance metrics", () => {
  it("aggregates bounded, content-free summaries with percentiles", () => {
    for (let value = 1; value <= 100; value += 1) {
      recordPerformanceMetric("collaboration.ack", value, "ms", {
        transport: "websocket",
      });
    }

    expect(flushPerformanceMetrics()).toEqual([
      {
        name: "collaboration.ack",
        unit: "ms",
        dimensions: { transport: "websocket" },
        count: 100,
        sum: 5_050,
        min: 1,
        max: 100,
        p50: 50,
        p95: 95,
        p99: 99,
      },
    ]);
    expect(flushPerformanceMetrics()).toEqual([]);
  });

  it("rejects invalid values and dimension names", () => {
    recordPerformanceMetric("Invalid name", 1, "ms");
    recordPerformanceMetric("valid.metric", Number.NaN, "ms");
    recordPerformanceMetric("valid.metric", 2, "ms", {
      valid_dimension: "ok",
      "unsafe dimension": "secret",
      ignored: undefined,
    });

    expect(flushPerformanceMetrics()).toMatchObject([
      {
        name: "valid.metric",
        dimensions: { valid_dimension: "ok" },
        count: 1,
      },
    ]);
  });

  it("ends a span only once", () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(25);
    const end = startPerformanceSpan("preview.snapshot", { source: "runtime" });

    expect(end({ outcome: "success" })).toBe(15);
    expect(end({ outcome: "ignored" })).toBe(0);
    expect(flushPerformanceMetrics()).toMatchObject([
      {
        name: "preview.snapshot",
        dimensions: { outcome: "success", source: "runtime" },
        count: 1,
        sum: 15,
      },
    ]);
    now.mockRestore();
  });

  it("flushes on the interval and during cleanup", () => {
    vi.useFakeTimers();
    const reporter = vi.fn<(summaries: readonly unknown[]) => void>();
    const cleanup = installPerformanceMetricsReporter(reporter, { flushIntervalMs: 1_000 });

    recordPerformanceMetric("workspace.update", 4, "ms");
    vi.advanceTimersByTime(1_000);
    expect(reporter).toHaveBeenCalledTimes(1);

    recordPerformanceMetric("workspace.update", 6, "ms");
    cleanup();
    expect(reporter).toHaveBeenCalledTimes(2);
  });
});
