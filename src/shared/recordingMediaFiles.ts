// How a recording's sibling media files are named: the camera video and the
// narration that live next to a `.ne` instead of inside it. One table per kind
// maps the filename extension to its MIME type, and everything else is read off
// those tables: the extension an exported file gets, the MIME a fetched or
// imported file is given, which picked or dropped files pair with a `.ne`, the
// import picker's accept list, and the media extensions the Worker's upload
// route allows (infra/worker/lessonMediaFiles.ts). A new container is one table
// row for all of them.
//
// Shared between the client and the Worker, following the same client/worker
// sharing pattern as src/shared/googleImageHosts.ts.

export const CAMERA_MIME_BY_EXT = {
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
} as const;

// `weba` (not `webm`) for audio/webm so a sibling audio file never collides with the
// sibling camera video (`<name>.webm`) exported next to the same `.ne`.
export const AUDIO_MIME_BY_EXT = {
  weba: "audio/webm",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
} as const;

export type RecordingCameraExtension = keyof typeof CAMERA_MIME_BY_EXT;
export type RecordingAudioExtension = keyof typeof AUDIO_MIME_BY_EXT;

/** The extension a camera video gets when its MIME type names no known container. */
export const DEFAULT_CAMERA_EXTENSION = "webm" satisfies RecordingCameraExtension;
/** The extension narration gets when its MIME type names no known container. */
export const DEFAULT_AUDIO_EXTENSION = "weba" satisfies RecordingAudioExtension;

export const RECORDING_CAMERA_EXTENSIONS = Object.keys(
  CAMERA_MIME_BY_EXT,
) as readonly RecordingCameraExtension[];
export const RECORDING_AUDIO_EXTENSIONS = Object.keys(
  AUDIO_MIME_BY_EXT,
) as readonly RecordingAudioExtension[];

function mimeFromFilename(
  table: Readonly<Record<string, string>>,
  filename: string | undefined,
): string | undefined {
  if (!filename) return undefined;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext && Object.hasOwn(table, ext) ? table[ext] : undefined;
}

function extensionFromMime(
  table: Readonly<Record<string, string>>,
  mimeType: string | undefined,
  fallback: string,
): string {
  if (mimeType) {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    for (const [ext, mime] of Object.entries(table)) {
      if (mime === base) return ext;
    }
  }
  return fallback;
}

/** Best-effort camera MIME type inferred from a sibling video filename's extension. */
export function cameraMimeFromFilename(filename: string | undefined): string | undefined {
  return mimeFromFilename(CAMERA_MIME_BY_EXT, filename);
}

/** Sibling video file extension (no dot) for a camera blob's MIME type; defaults to `webm`. */
export function cameraExtensionFromMime(mimeType: string | undefined): string {
  return extensionFromMime(CAMERA_MIME_BY_EXT, mimeType, DEFAULT_CAMERA_EXTENSION);
}

/** Best-effort audio MIME type inferred from a sibling audio filename's extension. */
export function audioMimeFromFilename(filename: string | undefined): string | undefined {
  return mimeFromFilename(AUDIO_MIME_BY_EXT, filename);
}

/** Sibling audio file extension (no dot) for an audio blob's MIME type; defaults to `weba`. */
export function audioExtensionFromMime(mimeType: string | undefined): string {
  return extensionFromMime(AUDIO_MIME_BY_EXT, mimeType, DEFAULT_AUDIO_EXTENSION);
}

const extensionSuffix = (extensions: readonly string[]) =>
  new RegExp(`\\.(${extensions.join("|")})$`, "i");
const AUDIO_FILE_NAME_RE = extensionSuffix(RECORDING_AUDIO_EXTENSIONS);
const CAMERA_FILE_NAME_RE = extensionSuffix(RECORDING_CAMERA_EXTENSIONS);

/** True when a filename ends in a narration extension (`.weba`, `.ogg`, …), in any case. */
export function isRecordingAudioFileName(name: string): boolean {
  return AUDIO_FILE_NAME_RE.test(name);
}

/** True when a filename ends in a camera video extension (`.webm`, `.mp4`, `.mov`), in any case. */
export function isRecordingVideoFileName(name: string): boolean {
  return CAMERA_FILE_NAME_RE.test(name);
}

/** The import picker's `accept`: a `.ne` together with its sibling camera video and narration. */
export const RECORDING_IMPORT_ACCEPT = [
  ".ne",
  ...RECORDING_CAMERA_EXTENSIONS.map((ext) => `.${ext}`),
  "video/*",
  ...RECORDING_AUDIO_EXTENSIONS.map((ext) => `.${ext}`),
  "audio/*",
].join(",");
