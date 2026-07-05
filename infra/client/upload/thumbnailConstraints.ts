// svg is deliberately excluded — see worker/routes/uploads.ts's comment on
// why it can't be accepted as a thumbnail type.
export const THUMBNAIL_ACCEPT = "image/png,image/jpeg";
// Keeps the upload PUT snappy and R2 tidy — generous for a thumbnail image.
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
