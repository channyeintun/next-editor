// A lesson thumbnail's file in R2: lessons/<id>/<id>-thumbnail-<ms>.<ext>.
// Every upload, the first included, writes a key of its own, so a thumbnail's
// bytes never change under its URL: routes/media.ts serves these keys as
// immutable and keeps them in the serving location's cache, and a replaced
// thumbnail is a new URL that no browser or cache holds stale. The client names
// the file (infra/client/upload/uploadLesson.ts, for the upload modal and the
// library's "Update thumbnail" alike); the Worker recognizes the key. Rows
// written before this rule may still name a fixed "<id>-thumbnail.<ext>", which
// stays revalidated.

/** The image types a thumbnail is stored as; svg never (see worker/lessonMediaFiles.ts). */
export const THUMBNAIL_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/** The filename for a thumbnail uploaded now. */
export function thumbnailFilename(
  lessonId: string,
  extension: (typeof THUMBNAIL_EXTENSIONS)[number],
  uploadedAt: number = Date.now(),
): string {
  return `${lessonId}-thumbnail-${uploadedAt}.${extension}`;
}

const WRITE_ONCE_THUMBNAIL_KEY_RE = new RegExp(
  `^lessons/([\\w-]+)/\\1-thumbnail-\\d+\\.(?:${THUMBNAIL_EXTENSIONS.join("|")})$`,
);

/** Whether an R2 key is a thumbnail under its write-once name. */
export function isWriteOnceThumbnailKey(key: string): boolean {
  return WRITE_ONCE_THUMBNAIL_KEY_RE.test(key);
}
