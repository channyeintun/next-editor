import { describe, expect, it } from "vite-plus/test";
import { isBurmeseLocale, validateNarrationLanguage } from "./narrationLanguage";

describe("Studio narration language", () => {
  it("recognizes canonical and region-specific Burmese locales", () => {
    expect(isBurmeseLocale("my")).toBe(true);
    expect(isBurmeseLocale("my-MM")).toBe(true);
    expect(isBurmeseLocale("MY_mm")).toBe(true);
    expect(isBurmeseLocale("en-US")).toBe(false);
  });

  it("requires the selected provider language to match the LessonScript locale", () => {
    expect(validateNarrationLanguage("my-MM", "my")).toBeNull();
    expect(validateNarrationLanguage("en-US", "en")).toBeNull();
    expect(validateNarrationLanguage("en-US", "my")).toMatch(/requires a LessonScript locale/);
    expect(validateNarrationLanguage("my-MM", "en")).toMatch(/requires Burmese/);
  });
});
