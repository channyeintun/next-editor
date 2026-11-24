import { describe, expect, it } from "vite-plus/test";
import {
  advisoryWarningLines,
  advisoryWarningsOf,
  checkFailsRender,
  computeTimingStats,
  renderOutcomeOf,
  timingGateCheck,
  type ActionReceipt,
  type StudioCheckResult,
} from "./report";

describe("renderOutcomeOf", () => {
  const passed: StudioCheckResult = { id: "a", ok: true, detail: "fine" };
  const failed: StudioCheckResult = { id: "b", ok: false, detail: "broken" };
  const warned: StudioCheckResult = { id: "c", ok: false, detail: "odd", advisory: true };

  it("fails a render on a failed check that is not advisory", () => {
    expect(renderOutcomeOf([passed, failed])).toBe("failed");
    expect(renderOutcomeOf([passed, warned, failed])).toBe("failed");
    expect(checkFailsRender(failed)).toBe(true);
  });

  it("passes a render whose only failures are advisory", () => {
    expect(renderOutcomeOf([passed, warned])).toBe("passed");
    expect(renderOutcomeOf([])).toBe("passed");
    expect(checkFailsRender(warned)).toBe(false);
    // An advisory check that passed is no warning.
    expect(advisoryWarningsOf([passed, { ...passed, advisory: true }, warned, failed])).toEqual([
      warned,
    ]);
  });

  it("prints each advisory failure as a warning line", () => {
    expect(advisoryWarningLines([passed, warned, failed])).toEqual(["warning: c — odd"]);
  });
});

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

  it("measures an afterAction dependent's drift from its predecessor's ack, not its planned time (STUDIO-03)", () => {
    // `open` is chained after `wait`, whose readiness landed 5s after `open`'s
    // placeholder planned time. Against the planned time that is 5s of drift;
    // against the predecessor's ack `open` started promptly (0ms).
    const receipts = [
      receipt({
        actionId: "wait",
        actionType: "runtime.waitForReady",
        plannedAtMs: 100,
        startedAtMs: 100,
        endedAtMs: 5_100,
      }),
      receipt({
        actionId: "open",
        actionType: "preview.open",
        plannedAtMs: 100,
        startedAtMs: 5_100,
        endedAtMs: 5_140,
      }),
    ];
    // Without the dependency map: open drifts 5000ms from its placeholder.
    expect(computeTimingStats(receipts)?.maxMs).toBe(5_000);
    // With it: open started the instant readiness landed.
    const withDeps = computeTimingStats(receipts, { open: "wait" });
    expect(withDeps?.maxMs).toBe(0);
  });

  it("falls back to the planned time when the predecessor never acknowledged", () => {
    const receipts = [
      receipt({
        actionId: "wait",
        actionType: "runtime.waitForReady",
        status: "failed",
        plannedAtMs: 100,
        startedAtMs: 100,
        endedAtMs: null,
      }),
      receipt({
        actionId: "open",
        actionType: "preview.open",
        plannedAtMs: 100,
        startedAtMs: 300,
        endedAtMs: 340,
      }),
    ];
    // `wait` is excluded (failed); `open`'s predecessor has no ack, so drift is
    // measured from its planned time (200ms).
    expect(computeTimingStats(receipts, { open: "wait" })?.maxMs).toBe(200);
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
    expect(timingGateCheck(null, 300, "virtual").ok).toBe(false);
  });

  it("still gates a virtual render, and says where drift on it comes from", () => {
    const timing = { samples: 5, p50Ms: 0, p95Ms: 0, maxMs: 0 };
    const real = timingGateCheck(timing, 300);
    const virtual = timingGateCheck(timing, 300, "virtual");
    expect(virtual.ok).toBe(true);
    expect(virtual.detail).toContain(real.detail);
    expect(virtual.detail).toMatch(
      /virtual clock: an action waits for nothing real, so any drift comes from the actions before it overrunning their plan/,
    );
    expect(real.detail).not.toMatch(/virtual/);
  });

  it("does not call a late start on a virtual clock exact", () => {
    // An action that ran past its gap (a retried run) delays the next start even on a
    // virtual clock; the detail beside a non-zero p95 must not claim the starts are exact.
    const late = timingGateCheck({ samples: 5, p50Ms: 0, p95Ms: 900, maxMs: 900 }, 300, "virtual");
    expect(late.ok).toBe(false);
    expect(late.detail).toMatch(/p95 \|actual − planned\| = 900ms/);
    expect(late.detail).not.toMatch(/exact/);
  });
});
