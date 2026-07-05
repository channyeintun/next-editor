// Shipped as a static asset at the site root (public/default-thumbnail.webp), not
// under R2's media/ prefix — so unlike an uploaded thumbnail, this raw filename must
// reach the `thumbnail` column unprefixed. Shared by the client (uploadLesson.ts,
// where a user opts into it) and the worker (lessons.ts, where the media/ prefix is
// applied to everything else) so both sides recognize the same sentinel value.
export const DEFAULT_THUMBNAIL_PATH = "default-thumbnail.webp";
