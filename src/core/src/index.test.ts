import { describe, expect, it } from "vite-plus/test";

describe("core barrel", () => {
  it("exports types only, so importing it adds no runtime module (and no Monaco) to a route", async () => {
    expect(Object.keys(await import("./index"))).toEqual([]);
  });
});
