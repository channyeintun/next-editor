import { describe, expect, it } from "vite-plus/test";
import {
  isBurmeseLocale,
  isStudioNarrationProvider,
  narrationLanguageOf,
  narrationProviderLabel,
  validateNarrationLanguage,
} from "./narrationLanguage";

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
  });

  it("names both Burmese providers when an English provider meets a Burmese script", () => {
    expect(validateNarrationLanguage("my-MM", "en")).toBe(
      'The "my-MM" LessonScript needs Burmese narration — choose မြန်မာ · AthanLab or မြန်မာ · VoxCPM2 (Modal)',
    );
  });
});

describe("Studio narration provider", () => {
  it("derives the narration language from the provider", () => {
    expect(narrationLanguageOf("pocket")).toBe("en");
    expect(narrationLanguageOf("athanlab")).toBe("my");
    expect(narrationLanguageOf("voxcpm2")).toBe("my");
  });

  it("labels each provider the way a run records it", () => {
    expect(narrationProviderLabel("pocket")).toBe("Pocket-TTS");
    expect(narrationProviderLabel("athanlab")).toBe("AthanLab");
    expect(narrationProviderLabel("voxcpm2")).toBe("VoxCPM2 (Modal)");
  });

  it("accepts only known provider ids, e.g. from browser storage", () => {
    expect(isStudioNarrationProvider("athanlab")).toBe(true);
    expect(isStudioNarrationProvider("voxcpm2")).toBe(true);
    expect(isStudioNarrationProvider("pocket")).toBe(true);
    expect(isStudioNarrationProvider("my")).toBe(false);
    expect(isStudioNarrationProvider(null)).toBe(false);
  });
});
