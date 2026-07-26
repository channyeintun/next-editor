export type StudioNarrationLanguage = "en" | "my";

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
    return `The "${locale}" LessonScript requires Burmese · VoxCPM2 (Modal) narration`;
  }
  return null;
}
