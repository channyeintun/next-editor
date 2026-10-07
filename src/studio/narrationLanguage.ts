export type StudioNarrationLanguage = "en" | "my";

/**
 * The narration provider chosen in the Studio panel: Pocket-TTS (English, in
 * the page), AthanLab (Burmese, with the user's own API key) or VoxCPM2 on
 * Modal (Burmese, enabled per user).
 */
export type StudioNarrationProvider = "pocket" | "athanlab" | "voxcpm2";

export function isStudioNarrationProvider(value: unknown): value is StudioNarrationProvider {
  return value === "pocket" || value === "athanlab" || value === "voxcpm2";
}

export function narrationLanguageOf(provider: StudioNarrationProvider): StudioNarrationLanguage {
  return provider === "pocket" ? "en" : "my";
}

/** The provider name a run records, and its draft provenance repeats. */
export function narrationProviderLabel(provider: StudioNarrationProvider): string {
  switch (provider) {
    case "pocket":
      return "Pocket-TTS";
    case "athanlab":
      return "AthanLab";
    case "voxcpm2":
      return "VoxCPM2 (Modal)";
  }
}

export function isBurmeseLocale(locale: string): boolean {
  const normalized = locale.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "my" || normalized.startsWith("my-");
}

export function validateNarrationLanguage(
  locale: string,
  language: StudioNarrationLanguage,
): string | null {
  const scriptIsBurmese = isBurmeseLocale(locale);
  if (language === "my" && !scriptIsBurmese) {
    return `Burmese narration requires a LessonScript locale of "my" or "my-MM"; this script uses "${locale}"`;
  }
  if (language === "en" && scriptIsBurmese) {
    return `The "${locale}" LessonScript needs Burmese narration — choose မြန်မာ · AthanLab or မြန်မာ · VoxCPM2 (Modal)`;
  }
  return null;
}
