import { describe, expect, it } from "vite-plus/test";
import { isNonZeroWidthDelta } from "./workspace";

describe("isNonZeroWidthDelta", () => {
  it("accepts only a finite, non-zero number", () => {
    expect(isNonZeroWidthDelta(3)).toBe(true);
    expect(isNonZeroWidthDelta(-3)).toBe(true);
    expect(isNonZeroWidthDelta(0.5)).toBe(true);

    expect(isNonZeroWidthDelta(0)).toBe(false);
    expect(isNonZeroWidthDelta(-0)).toBe(false);
    expect(isNonZeroWidthDelta(Number.NaN)).toBe(false);
    expect(isNonZeroWidthDelta(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonZeroWidthDelta(undefined)).toBe(false);
    expect(isNonZeroWidthDelta(null)).toBe(false);
    expect(isNonZeroWidthDelta("3")).toBe(false);
  });
});
