export type PerformanceMetricUnit = "ms" | "bytes" | "count";

export type PerformanceMetricDimensions = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface PerformanceMetricSummary {
  name: string;
  unit: PerformanceMetricUnit;
  dimensions: Readonly<Record<string, string | number | boolean>>;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

type PerformanceMetricsReporter = (summaries: readonly PerformanceMetricSummary[]) => void;

interface PerformanceMetricAggregate {
  name: string;
  unit: PerformanceMetricUnit;
  dimensions: Readonly<Record<string, string | number | boolean>>;
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[];
}

const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;
const DIMENSION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_AGGREGATES = 64;
const MAX_DIMENSIONS = 8;
const MAX_SAMPLES_PER_AGGREGATE = 128;
const MAX_DIMENSION_STRING_LENGTH = 80;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

const aggregates = new Map<string, PerformanceMetricAggregate>();
let reporterCleanup: (() => void) | null = null;

function sanitizeDimensions(
  dimensions: PerformanceMetricDimensions | undefined,
): Readonly<Record<string, string | number | boolean>> {
  if (!dimensions) return {};

  const sanitized: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(dimensions).sort()) {
    if (Object.keys(sanitized).length >= MAX_DIMENSIONS || !DIMENSION_NAME_PATTERN.test(key)) {
      continue;
    }

    const value = dimensions[key];
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, MAX_DIMENSION_STRING_LENGTH);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function aggregateKey(
  name: string,
  unit: PerformanceMetricUnit,
  dimensions: Readonly<Record<string, string | number | boolean>>,
): string {
  return JSON.stringify([name, unit, dimensions]);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * Records a bounded, content-free performance sample. Metric names and dimensions
 * must describe system behavior only: never pass room IDs, paths, source text, URLs,
 * user IDs, update IDs, or other user-controlled values.
 */
export function recordPerformanceMetric(
  name: string,
  value: number,
  unit: PerformanceMetricUnit,
  dimensions?: PerformanceMetricDimensions,
): void {
  if (!METRIC_NAME_PATTERN.test(name) || !Number.isFinite(value) || value < 0) return;

  const safeDimensions = sanitizeDimensions(dimensions);
  const key = aggregateKey(name, unit, safeDimensions);
  let aggregate = aggregates.get(key);

  if (!aggregate) {
    if (aggregates.size >= MAX_AGGREGATES) return;
    aggregate = {
      name,
      unit,
      dimensions: safeDimensions,
      count: 0,
      sum: 0,
      min: value,
      max: value,
      samples: [],
    };
    aggregates.set(key, aggregate);
  }

  aggregate.count += 1;
  aggregate.sum += value;
  aggregate.min = Math.min(aggregate.min, value);
  aggregate.max = Math.max(aggregate.max, value);

  if (aggregate.samples.length < MAX_SAMPLES_PER_AGGREGATE) {
    aggregate.samples.push(value);
  } else {
    // A fixed-size ring keeps recent samples representative without retaining a
    // value per keystroke for the lifetime of the page.
    aggregate.samples[(aggregate.count - 1) % MAX_SAMPLES_PER_AGGREGATE] = value;
  }
}

export function incrementPerformanceCounter(
  name: string,
  value = 1,
  dimensions?: PerformanceMetricDimensions,
): void {
  recordPerformanceMetric(name, value, "count", dimensions);
}

export function startPerformanceSpan(
  name: string,
  dimensions?: PerformanceMetricDimensions,
): (extraDimensions?: PerformanceMetricDimensions) => number {
  const startedAt = monotonicNow();
  let ended = false;

  return (extraDimensions) => {
    if (ended) return 0;
    ended = true;
    const duration = Math.max(0, monotonicNow() - startedAt);
    recordPerformanceMetric(name, duration, "ms", { ...dimensions, ...extraDimensions });
    return duration;
  };
}

export function flushPerformanceMetrics(): PerformanceMetricSummary[] {
  const summaries = Array.from(aggregates.values(), (aggregate) => {
    const sorted = [...aggregate.samples].sort((left, right) => left - right);
    return {
      name: aggregate.name,
      unit: aggregate.unit,
      dimensions: aggregate.dimensions,
      count: aggregate.count,
      sum: aggregate.sum,
      min: aggregate.min,
      max: aggregate.max,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    } satisfies PerformanceMetricSummary;
  });
  aggregates.clear();
  return summaries;
}

export function installPerformanceMetricsReporter(
  reporter: PerformanceMetricsReporter,
  options: { flushIntervalMs?: number } = {},
): () => void {
  reporterCleanup?.();

  const flush = () => {
    const summaries = flushPerformanceMetrics();
    if (summaries.length > 0) {
      try {
        reporter(summaries);
      } catch {
        // Observability must never affect the editor's runtime behavior.
      }
    }
  };
  const interval = globalThis.setInterval(
    flush,
    Math.max(1_000, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS),
  );
  const handleVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  const cleanup = () => {
    globalThis.clearInterval(interval);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    flush();
    if (reporterCleanup === cleanup) reporterCleanup = null;
  };
  reporterCleanup = cleanup;
  return cleanup;
}

/** Test-only reset for module-level bounded aggregates/reporters. */
export function resetPerformanceMetricsForTests(): void {
  reporterCleanup?.();
  reporterCleanup = null;
  aggregates.clear();
}
