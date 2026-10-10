import { describe, expect, it } from "vite-plus/test";
import { isEmbedded, isReadOnlyView } from "./embed";

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

describe("isReadOnlyView", () => {
  it("is off without the flag", () => {
    expect(isReadOnlyView("")).toBe(false);
    expect(isReadOnlyView("?largeControls=true")).toBe(false);
    expect(isReadOnlyView(new URLSearchParams())).toBe(false);
  });

  it("is on for ?readOnly=true, from a search string or URLSearchParams", () => {
    expect(isReadOnlyView("?readOnly=true")).toBe(true);
    expect(isReadOnlyView("?largeControls=true&readOnly=true")).toBe(true);
    expect(isReadOnlyView("readOnly=true")).toBe(true);
    expect(isReadOnlyView(new URLSearchParams("readOnly=true&largeControls=true"))).toBe(true);
  });

  it("takes only the exact value", () => {
    expect(isReadOnlyView("?readOnly")).toBe(false);
    expect(isReadOnlyView("?readOnly=1")).toBe(false);
    expect(isReadOnlyView("?readOnly=false")).toBe(false);
    expect(isReadOnlyView("?readOnly=TRUE")).toBe(false);
    expect(isReadOnlyView("?readonly=true")).toBe(false);
    expect(isReadOnlyView(new URLSearchParams("readOnly=yes"))).toBe(false);
  });
});
