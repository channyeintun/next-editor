import type { Lesson } from "../types";

// Empty by default: the editor is reverse-proxied under this same origin (B1), so
// the iframe loads `/code` same-origin and inherits cross-origin isolation (needed
// for WebContainer). Set VITE_EDITOR_BASE only to point at a cross-origin editor.
const EDITOR_BASE = import.meta.env.VITE_EDITOR_BASE ?? "";

export function buildPlayUrl(lesson: Lesson): string {
  // Same-origin path the proxied editor fetches from this origin. When an explicit
  // cross-origin EDITOR_BASE is set, send an absolute URL back to this origin
  // (that host then needs CORS on the .ne/.vtt files).
  const neUrl = EDITOR_BASE
    ? new URL(`/${lesson.ne}`, window.location.origin).toString()
    : `/${lesson.ne}`;
  return `${EDITOR_BASE}/code?url=${encodeURIComponent(neUrl)}&readOnly=true&deferRuntimeAutostart=true`;
}

export function resolveThumb(lesson: Lesson): string {
  return `/${lesson.thumbnail}`;
}
