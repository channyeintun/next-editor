import { describe, expect, it } from "vitest";
import { isEmbedded } from "./embed";

describe("isEmbedded", () => {
  it("is off for a page nobody framed", () => {
    expect(isEmbedded("")).toBe(false);
    expect(isEmbedded("?list=kite")).toBe(false);
  });

  it("is on for ?embed=true", () => {
    expect(isEmbedded("?embed=true")).toBe(true);
    expect(isEmbedded("?list=kite&embed=true")).toBe(true);
    expect(isEmbedded("embed=true")).toBe(true);
  });

  it("takes only the exact value, so a stray ?embed can't drop the chrome", () => {
    expect(isEmbedded("?embed")).toBe(false);
    expect(isEmbedded("?embed=1")).toBe(false);
    expect(isEmbedded("?embed=false")).toBe(false);
    expect(isEmbedded("?embed=TRUE")).toBe(false);
    expect(isEmbedded("?embedded=true")).toBe(false);
  });
});
