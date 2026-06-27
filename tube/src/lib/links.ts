import type { Lesson } from "../types";

// Lesson assets are served same-origin from the host app's public/ folder.
export function resolveThumb(lesson: Lesson): string {
  return `/${lesson.thumbnail}`;
}
