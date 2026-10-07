import { describe, expect, it } from "vite-plus/test";
import {
  POINTER_AIM_MAX_MS,
  POINTER_AIM_MIN_MS,
  easePointerAim,
  easePointerDrag,
  pointerAimDurationMs,
} from "./pointerMotion";

// Numerical speed of an easing at normalized time t (fraction of the distance
// per fraction of the time).
const speed = (ease: (t: number) => number, t: number) => (ease(t + 1e-4) - ease(t - 1e-4)) / 2e-4;

const peakTime = (ease: (t: number) => number) => {
  let best = 0;
  for (let t = 0.01; t < 1; t += 0.01) {
    if (speed(ease, t) > speed(ease, best)) best = t;
  }
  return best;
};

describe.each([
  ["easePointerAim", easePointerAim],
  ["easePointerDrag", easePointerDrag],
])("%s", (_, ease) => {
  it("clamps, hits its endpoints and only moves forward", () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(2)).toBe(1);
    for (let t = 0.01; t <= 1; t += 0.01) {
      expect(ease(t)).toBeGreaterThanOrEqual(ease(t - 0.01));
    }
  });

  it("leaves and lands at rest — no jolt at either end", () => {
    expect(speed(ease, 0.001)).toBeLessThan(0.05);
    expect(speed(ease, 0.999)).toBeLessThan(0.05);
  });
});

describe("easePointerAim", () => {
  it("peaks a little before halfway, as recorded hands do (≈0.4–0.47)", () => {
    expect(peakTime(easePointerAim)).toBeCloseTo(0.4, 1);
  });
});

describe("easePointerDrag", () => {
  it("accelerates off the press, peaks early, then lands carefully", () => {
    expect(peakTime(easePointerDrag)).toBeCloseTo(1 / 3, 1);
    // Recorded drags reach .35 / .71 / .91 of the distance at 25 / 50 / 75%.
    expect(easePointerDrag(0.25)).toBeCloseTo(0.26, 2);
    expect(easePointerDrag(0.5)).toBeCloseTo(0.69, 2);
    expect(easePointerDrag(0.75)).toBeCloseTo(0.95, 2);
  });
});

describe("pointerAimDurationMs", () => {
  it("grows slowly with distance, as the recorded approaches do", () => {
    // The fit to the recorded approaches, ≈ 98·D^0.3ms.
    expect(pointerAimDurationMs(100)).toBeCloseTo(390, -1);
    expect(pointerAimDurationMs(300)).toBeCloseTo(540, -1);
    expect(pointerAimDurationMs(600)).toBeCloseTo(670, -1);
    expect(pointerAimDurationMs(1000)).toBeCloseTo(780, -1);
  });

  it("is zero for no distance and clamped for tiny and huge ones", () => {
    expect(pointerAimDurationMs(0)).toBe(0);
    expect(pointerAimDurationMs(Number.NaN)).toBe(0);
    expect(pointerAimDurationMs(2)).toBe(POINTER_AIM_MIN_MS);
    expect(pointerAimDurationMs(10_000)).toBe(POINTER_AIM_MAX_MS);
  });
});
