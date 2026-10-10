// svg is deliberately excluded — see worker/lessonMediaFiles.ts on why it
// can't be accepted as a thumbnail type. The byte limit lives with the other
// upload limits in infra/lessons/uploadLimits.ts.
export const THUMBNAIL_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg"];
export const THUMBNAIL_ACCEPT = THUMBNAIL_MIME_TYPES.join(",");
