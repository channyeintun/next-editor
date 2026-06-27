import type { Lesson } from "../types";

const EDITOR_BASE = import.meta.env.VITE_EDITOR_BASE || "https://nexteditor.dev";

export function buildPlayUrl(lesson: Lesson): string {
  const neAbsUrl = new URL(lesson.ne, window.location.origin).toString();
  return `${EDITOR_BASE}/code?url=${encodeURIComponent(neAbsUrl)}&readOnly=true&deferRuntimeAutostart=true`;
}

export function resolveThumb(lesson: Lesson): string {
  return `/${lesson.thumbnail}`;
}
