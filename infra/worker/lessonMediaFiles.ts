// The files a lesson row may point at (`ne`, `thumbnail`), which is also what
// PUT /api/uploads/:id/media/:filename accepts under its main pattern: a safe
// charset and a known extension, never a path. The filename must be what
// buildRecordingFiles (src/storage/RecordingStorage.ts) or the thumbnail
// upload computed client-side (e.g. "<id>.ne", "recording-1.ogg"). svg is
// deliberately absent although it is an image type: it can carry an inline
// <script>, and R2 objects are served back same-origin at /media/<key>
// (routes/media.ts), so a direct navigation would run it in the app's origin.
// Caption files (`<id>.<lang>.vtt`) have their own pattern in routes/uploads.ts.

export const LESSON_MEDIA_EXTENSIONS = [
  "ne",
  "ogg",
  "weba",
  "webm",
  "mp4",
  "mov",
  "m4a",
  "mp3",
  "wav",
  "png",
  "jpg",
  "jpeg",
] as const;

export type LessonMediaExtension = (typeof LESSON_MEDIA_EXTENSIONS)[number];

/** A lesson media filename as a Hono route-parameter pattern: `:filename{${LESSON_MEDIA_FILENAME_PATTERN}}`. */
export const LESSON_MEDIA_FILENAME_PATTERN = `[\\w-]+\\.(${LESSON_MEDIA_EXTENSIONS.join("|")})`;

const LESSON_MEDIA_FILENAME_RE = new RegExp(`^${LESSON_MEDIA_FILENAME_PATTERN}$`);

export function isLessonMediaFilename(value: string): boolean {
  return LESSON_MEDIA_FILENAME_RE.test(value);
}
