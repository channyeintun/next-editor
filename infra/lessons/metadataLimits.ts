// Upper bounds on the text a lesson or playlist carries. That text is served
// with every gallery page, search result and author profile, and the lesson
// edge render (infra/worker/ssr/lessonDetail.ts) copies a title seven times and
// a description five times into each page, so the Worker refuses anything
// longer. Generous on purpose: no real title or description comes near them.
// UploadLessonModal checks a lesson's text with metadataTextError before it
// uploads anything, and the lesson and playlist title and description inputs
// take their maxLength from these constants.

export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 10_000;
export const MAX_TAGS = 30;
export const MAX_TAG_CHARS = 50;
/** formatDuration (infra/client/upload/uploadLesson.ts) emits "m:ss". */
export const MAX_DURATION_CHARS = 32;

export interface MetadataText {
  title?: string;
  description?: string | null;
  tags?: readonly string[] | null;
  duration?: string | null;
}

/** The first field of `text` over its limit, as a 400 message, or null when all fit. */
export function metadataTextError(text: MetadataText): string | null {
  if (text.title !== undefined && text.title.length > MAX_TITLE_CHARS) {
    return `title must be at most ${MAX_TITLE_CHARS} characters`;
  }
  if (text.description != null && text.description.length > MAX_DESCRIPTION_CHARS) {
    return `description must be at most ${MAX_DESCRIPTION_CHARS} characters`;
  }
  if (text.tags != null) {
    if (text.tags.length > MAX_TAGS) {
      return `at most ${MAX_TAGS} tags`;
    }
    if (text.tags.some((tag) => tag.length > MAX_TAG_CHARS)) {
      return `each tag must be at most ${MAX_TAG_CHARS} characters`;
    }
  }
  if (text.duration != null && text.duration.length > MAX_DURATION_CHARS) {
    return `duration must be at most ${MAX_DURATION_CHARS} characters`;
  }
  return null;
}
