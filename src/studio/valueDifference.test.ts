import { describe, expect, it } from "vite-plus/test";
import { firstValueDifference, formatValuePath } from "./valueDifference";

describe("firstValueDifference", () => {
  it("treats data the way the recording file stores it", () => {
    expect(firstValueDifference({ a: 1, b: undefined }, { a: 1 })).toBeNull();
    expect(firstValueDifference([undefined], [null])).toBeNull();
    expect(firstValueDifference(Number.NaN, Number.NaN)).toBeNull();
    expect(firstValueDifference(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBeNull();
  });

  it("gives the path and both sides where the values first part", () => {
    expect(firstValueDifference({ a: [1, { b: "c" }] }, { a: [1, { b: "d" }] })).toEqual({
      kind: "value",
      path: ["a", 1, "b"],
      left: "c",
      right: "d",
    });
    expect(firstValueDifference({ a: 1 }, {})).toEqual({
      kind: "value",
      path: ["a"],
      left: 1,
      right: undefined,
    });
    expect(firstValueDifference({ list: [1, 2] }, { list: [1] })).toEqual({
      kind: "length",
      unit: "items",
      path: ["list"],
      left: 2,
      right: 1,
    });
    expect(firstValueDifference(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toEqual({
      kind: "bytes",
      path: [],
      offset: 1,
    });
  });

  it("writes a path as code would", () => {
    expect(formatValuePath("x", ["a", 1, "b"])).toBe("x.a[1].b");
    expect(formatValuePath("x", [])).toBe("x");
  });
});
