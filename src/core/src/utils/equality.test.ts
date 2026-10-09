import { describe, expect, it } from "vite-plus/test";
import { arePreviewSizesEqual, areStructuredDataEqual } from "./equality";

describe("areStructuredDataEqual", () => {
  it("compares nested plain objects by value, ignoring key order", () => {
    expect(
      areStructuredDataEqual(
        { a: 1, nested: { b: "x", c: null } },
        { nested: { c: null, b: "x" }, a: 1 },
      ),
    ).toBe(true);
    expect(areStructuredDataEqual({ a: 1, nested: { b: "x" } }, { a: 1, nested: { b: "y" } })).toBe(
      false,
    );
    expect(areStructuredDataEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(areStructuredDataEqual(Object.create(null), {})).toBe(true);
  });

  it("compares arrays element by element and never equates an array with an object", () => {
    expect(areStructuredDataEqual([1, [2, { c: 3 }]], [1, [2, { c: 3 }]])).toBe(true);
    expect(areStructuredDataEqual([1, 2], [2, 1])).toBe(false);
    expect(areStructuredDataEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(areStructuredDataEqual([1], { 0: 1 })).toBe(false);
  });

  it("compares dates by time value", () => {
    expect(areStructuredDataEqual(new Date(1_000), new Date(1_000))).toBe(true);
    expect(areStructuredDataEqual(new Date(1_000), new Date(2_000))).toBe(false);
    expect(areStructuredDataEqual(new Date(1_000), 1_000)).toBe(false);
    expect(areStructuredDataEqual(new Date(1_000), {})).toBe(false);
  });

  it("treats distinct non-plain objects as unequal and NaN as equal to itself", () => {
    expect(areStructuredDataEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false);
    class Point {
      x: number;
      constructor(x: number) {
        this.x = x;
      }
    }
    expect(areStructuredDataEqual(new Point(1), new Point(1))).toBe(false);
    const shared = new Point(1);
    expect(areStructuredDataEqual(shared, shared)).toBe(true);
    expect(areStructuredDataEqual(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe("arePreviewSizesEqual", () => {
  it("compares named sizes by name and never equates one with explicit dimensions", () => {
    expect(arePreviewSizesEqual("medium", "medium")).toBe(true);
    expect(arePreviewSizesEqual("small", "large")).toBe(false);
    expect(arePreviewSizesEqual("small", { width: 320, height: 240 })).toBe(false);
  });

  it("compares explicit sizes by width and height", () => {
    expect(arePreviewSizesEqual({ width: 800, height: 600 }, { width: 800, height: 600 })).toBe(
      true,
    );
    expect(arePreviewSizesEqual({ width: 800, height: 600 }, { width: 800, height: 601 })).toBe(
      false,
    );
  });
});
