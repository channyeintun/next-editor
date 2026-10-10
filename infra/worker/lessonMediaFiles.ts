// The files a lesson row may point at (`ne`, `thumbnail`), which is also what
// PUT /api/uploads/:id/media/:filename accepts under its main pattern: a safe
// charset and a known extension, never a path. The filename must be what
// buildRecordingFiles (src/storage/RecordingStorage.ts) or the thumbnail
// upload computed client-side (e.g. "<id>.ne", "recording-1.ogg"). svg is
// deliberately absent although it is an image type: it can carry an inline
// <script>, and R2 objects are served back same-origin at /media/<key>
// (routes/media.ts), so a direct navigation would run it in the app's origin.
// Caption files (`<id>.<lang>.vtt`, `<id>-N.<lang>.vtt`) have their own pattern in
// routes/uploads.ts. The sibling audio and camera extensions, and their types
// below, come from src/shared/recordingMediaFiles.ts, which also names the files
// buildRecordingFiles exports, so every container it can produce is uploadable.

import {
  AUDIO_MIME_BY_EXT,
  CAMERA_MIME_BY_EXT,
  RECORDING_AUDIO_EXTENSIONS,
  RECORDING_CAMERA_EXTENSIONS,
} from "../../src/shared/recordingMediaFiles";

export const LESSON_MEDIA_EXTENSIONS = [
  "ne",
  ...RECORDING_AUDIO_EXTENSIONS,
  ...RECORDING_CAMERA_EXTENSIONS,
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;

export type LessonMediaExtension = (typeof LESSON_MEDIA_EXTENSIONS)[number];

// The content-type routes/uploads.ts stores for each uploadable extension
// (plus captions), derived from the filename extension, never copied from the
// request header. R2 replays whatever type was stored (routes/media.ts ->
// writeHttpMetadata) from the app's own origin, so trusting the uploader's
// header would let any signed-in user park `Content-Type: text/html` on a
// `.png` key and get script execution on nexteditor.dev. `nosniff` does NOT
// help here: it stops the browser sniffing *away from* a declared type, but a
// declared text/html is still parsed as a document. The route's extension
// allow-list constrains the URL, not the type the browser acts on — so the
// type has to come from the extension. Mirrors the SLIDE_IMAGE_CONTENT_TYPES
// approach already used by routes/slideImages.ts. `satisfies` makes the
// compiler refuse an uploadable extension with no type. routes/media.ts serves
// every type in this map inline.
export const LESSON_MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ne: "application/octet-stream",
  ...AUDIO_MIME_BY_EXT,
  ...CAMERA_MIME_BY_EXT,
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  vtt: "text/vtt",
} satisfies Record<LessonMediaExtension | "vtt", string>;

/** A lesson media filename as a Hono route-parameter pattern: `:filename{${LESSON_MEDIA_FILENAME_PATTERN}}`. */
export const LESSON_MEDIA_FILENAME_PATTERN = `[\\w-]+\\.(${LESSON_MEDIA_EXTENSIONS.join("|")})`;

const LESSON_MEDIA_FILENAME_RE = new RegExp(`^${LESSON_MEDIA_FILENAME_PATTERN}$`);

export function isLessonMediaFilename(value: string): boolean {
  return LESSON_MEDIA_FILENAME_RE.test(value);
}
