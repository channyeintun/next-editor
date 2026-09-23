// Lesson ids are client-generated UUIDs, but the Worker interpolates them into R2
// keys (`lessons/<id>/<filename>`, routes/uploads.ts) and into the media paths
// stored on lesson rows, which browsers then request as URLs (routes/lessons.ts).
// Holding every id to a charset that cannot spell `/`, `.` or `%` keeps an id
// from ever acting as a path: "x/../<another id>" would otherwise resolve, in the
// browser, to another lesson's media.

/** A lesson id as a Hono route-parameter pattern: `/:id{${LESSON_ID_PATTERN}}`. */
export const LESSON_ID_PATTERN = "[\\w-]+";

const LESSON_ID_RE = new RegExp(`^${LESSON_ID_PATTERN}$`);

export function isLessonId(value: unknown): value is string {
  return typeof value === "string" && LESSON_ID_RE.test(value);
}
