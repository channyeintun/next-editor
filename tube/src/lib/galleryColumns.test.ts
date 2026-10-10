import { describe, expect, it } from "vite-plus/test";
import { FIRST_ROW_CARD_MEDIA } from "./galleryColumns";

describe("FIRST_ROW_CARD_MEDIA", () => {
  it("puts each card in the first row from the breakpoint that gives it a column", () => {
    expect(FIRST_ROW_CARD_MEDIA).toEqual([
      null,
      "(min-width: 640px)",
      "(min-width: 1024px)",
      "(min-width: 1280px)",
    ]);
  });
});
