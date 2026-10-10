// svg is deliberately excluded — see worker/lessonMediaFiles.ts on why it
// can't be accepted as a thumbnail type. The byte limit lives with the other
// upload limits in infra/lessons/uploadLimits.ts.
export const THUMBNAIL_ACCEPT = "image/png,image/jpeg";
