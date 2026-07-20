import { describe, expect, it } from "vite-plus/test";
import { computeTimingStats, timingGateCheck, type ActionReceipt } from "./report";

function receipt(overrides: Partial<ActionReceipt>): ActionReceipt {
  return {
    actionId: "a",
    actionType: "workspace.openFile",
    status: "ok",
    plannedAtMs: 1_000,
    startedAtMs: 1_050,
    endedAtMs: 1_100,
    ...overrides,
  };
}

describe("computeTimingStats", () => {
  it("measures |actual − planned| over ok, non-expect receipts", () => {
    const stats = computeTimingStats([
      receipt({ actionId: "a", plannedAtMs: 100, startedAtMs: 110 }),
      receipt({ actionId: "b", plannedAtMs: 200, startedAtMs: 450 }),
      // Gates and failures are excluded from the distribution.
      receipt({
        actionId: "gate",
        actionType: "expect.output",
        plannedAtMs: 0,
        startedAtMs: 5_000,
      }),
      receipt({ actionId: "dead", status: "failed", plannedAtMs: 0, startedAtMs: 9_000 }),
    ]);
    expect(stats).toEqual({ samples: 2, p50Ms: 10, p95Ms: 250, maxMs: 250 });
  });

  it("returns null with no measurable receipts", () => {
    expect(computeTimingStats([receipt({ status: "skipped", startedAtMs: null })])).toBeNull();
  });
});

describe("timingGateCheck", () => {
  it("passes a build inside the gate and fails one outside it", () => {
    const inside = timingGateCheck({ samples: 5, p50Ms: 10, p95Ms: 120, maxMs: 150 }, 300);
    expect(inside.ok).toBe(true);

    const mistimed = timingGateCheck({ samples: 5, p50Ms: 200, p95Ms: 800, maxMs: 900 }, 300);
    expect(mistimed.ok).toBe(false);
    expect(mistimed.detail).toMatch(/800ms/);
  });

  it("fails when nothing measurable was performed", () => {
    expect(timingGateCheck(null, 300).ok).toBe(false);
  });
});
