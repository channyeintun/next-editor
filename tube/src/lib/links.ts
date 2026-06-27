import type { Lesson } from "../types";

// The gallery is mounted at /learn inside the editor app, so the editor (/code)
// and the lesson files are same-origin. The iframe loads /code same-origin and
// inherits the app's cross-origin isolation (needed for WebContainer).
export function buildPlayUrl(lesson: Lesson): string {
  const neUrl = `/${lesson.ne}`;
  return `/code?url=${encodeURIComponent(neUrl)}&readOnly=true&deferRuntimeAutostart=true`;
}

export function resolveThumb(lesson: Lesson): string {
  return `/${lesson.thumbnail}`;
}
