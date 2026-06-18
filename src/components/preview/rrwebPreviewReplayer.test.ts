import { describe, expect, it } from "vitest";
import { computeRrwebOffsetMs } from "./rrwebPreviewReplayer";

describe("computeRrwebOffsetMs", () => {
  it("shifts recording time by the snapshot base time", () => {
    expect(computeRrwebOffsetMs(1000, 200)).toBe(800);
  });

  it("clamps to zero before the first snapshot", () => {
    expect(computeRrwebOffsetMs(50, 200)).toBe(0);
    expect(computeRrwebOffsetMs(200, 200)).toBe(0);
  });

  it("is identity when the snapshot is at recording start", () => {
    expect(computeRrwebOffsetMs(1234, 0)).toBe(1234);
  });
});
