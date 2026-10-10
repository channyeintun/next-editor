import { lessonTitleFromSlug } from "@app/utils/lessonSlug";
import type { Lesson } from "../types";

/**
 * A lesson page's document title for each state of its useLesson() lookup,
 * matching the edge renderer's `${lesson.title} | Next Editor`. Shared by
 * LessonDetailRoute and the fallback that stands in for it while its chunk
 * downloads (LearnSlugRoute), so the title does not change at that handover.
 */
export function lessonPageTitle(
  slug: string | undefined,
  lookup: { data: Lesson | null | undefined; isPending: boolean; isError: boolean },
): string {
  const pageName = lookup.isPending
    ? (lessonTitleFromSlug(slug) ?? "Lesson")
    : lookup.data
      ? lookup.data.title
      : lookup.isError
        ? "Failed to load lesson"
        : "Lesson not found";
  return `${pageName} | Next Editor`;
}
