// Callback-duration measurements for the Phase 2 feasibility gate and the
// plan §17.1 capture budgets. Durations are microseconds.
export type MetricsSummary = {
  count: number;
  meanUs: number;
  p95Us: number;
  maxUs: number;
};

const MAX_SAMPLES = 50_000;

export class CaptureMetrics {
  private readonly samples = new Map<string, number[]>();

  record(name: string, durationUs: number): void {
    let bucket = this.samples.get(name);
    if (!bucket) {
      bucket = [];
      this.samples.set(name, bucket);
    }
    if (bucket.length < MAX_SAMPLES) {
      bucket.push(durationUs);
    }
  }

  summary(): Record<string, MetricsSummary> {
    const out: Record<string, MetricsSummary> = {};
    for (const [name, bucket] of this.samples) {
      if (bucket.length === 0) {
        continue;
      }
      const sorted = [...bucket].sort((a, b) => a - b);
      const total = sorted.reduce((sum, v) => sum + v, 0);
      out[name] = {
        count: sorted.length,
        meanUs: Math.round(total / sorted.length),
        p95Us: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
        maxUs: sorted[sorted.length - 1] ?? 0,
      };
    }
    return out;
  }
}
