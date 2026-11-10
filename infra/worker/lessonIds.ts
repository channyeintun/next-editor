// Lesson ids are client-generated UUIDs, but the Worker interpolates them into R2
// keys (`lessons/<id>/<filename>`, routes/uploads.ts) and into the media paths
// stored on lesson rows, which browsers then request as URLs (routes/lessons.ts).
// Holding every id to a charset that cannot spell `/`, `.` or `%` keeps an id
// from ever acting as a path: "x/../<another id>" would otherwise resolve, in the
// browser, to another lesson's media.

/** A lesson id as a Hono route-parameter pattern: `/:id{${LESSON_ID_PATTERN}}`. */
export const LESSON_ID_PATTERN = "[\\w-]+";

const LESSON_ID_RE = new RegExp(`^${LESSON_ID_PATTERN}$`);

/**
 * The longest id a new lesson may take. Client ids are UUIDs (36 characters),
 * and an id is repeated in its row's media paths, its index entries and every
 * one of its R2 keys, so an unbounded one let a single create fill its whole
 * request body. Rows that already exist keep the id they were created with:
 * the route patterns above still match it.
 */
export const MAX_LESSON_ID_CHARS = 64;

/** An id a new lesson may take: LESSON_ID_PATTERN's charset, at most MAX_LESSON_ID_CHARS long. */
export function isNewLessonId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_LESSON_ID_CHARS && LESSON_ID_RE.test(value)
  );
}
