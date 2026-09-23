import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import { getLessonById } from "../../db/queries";
import { requireUser, type SignedInEnv } from "../auth/requireUser";
import { LESSON_ID_PATTERN } from "../lessonIds";
import { LESSON_MEDIA_FILENAME_PATTERN, type LessonMediaExtension } from "../lessonMediaFiles";
import { MAX_THUMBNAIL_BYTES } from "../../client/upload/thumbnailConstraints";
import { MAX_CAPTION_BYTES } from "../../client/upload/captionConstraints";
import { MAX_MEDIA_BYTES } from "../../client/upload/mediaConstraints";

// Mounted at /api/uploads in worker/index.ts. The client PUTs bytes through
// this same-origin authenticated Worker route, which streams them into R2
// without buffering the whole file in memory; no R2 signing keys or presigned
// upload URLs are exposed to the browser.
export const uploadsRoute = new Hono<{ Bindings: Env }>();

const THUMBNAIL_FILENAME_RE = /\.(?:png|jpe?g)$/i;
const CAPTION_FILENAME_RE = /\.vtt$/i;

// The stored content-type is derived from the filename extension, never copied
// from the request header. R2 replays whatever type was stored (routes/media.ts
// -> writeHttpMetadata) from the app's own origin, so trusting the uploader's
// header would let any signed-in user park `Content-Type: text/html` on a
// `.png` key and get script execution on nexteditor.dev. `nosniff` does NOT
// help here: it stops the browser sniffing *away from* a declared type, but a
// declared text/html is still parsed as a document. The route's extension
// allow-list constrains the URL, not the type the browser acts on — so the
// type has to come from the extension. Mirrors the ALLOWED_CONTENT_TYPES
// approach already used by routes/slideImages.ts. `satisfies` makes the
// compiler refuse an uploadable extension (lessonMediaFiles.ts) with no type.
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ne: "application/octet-stream",
  ogg: "audio/ogg",
  weba: "audio/webm",
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  vtt: "text/vtt",
} satisfies Record<LessonMediaExtension | "vtt", string>;

function storedContentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  // Object.hasOwn, not a bare lookup: an extension of `constructor` would
  // otherwise resolve through the prototype chain to a non-string.
  return Object.hasOwn(CONTENT_TYPE_BY_EXTENSION, extension)
    ? CONTENT_TYPE_BY_EXTENSION[extension]
    : "application/octet-stream";
}

const handleMediaUpload = async (c: Context<SignedInEnv>) => {
  const user = c.get("user");

  const { id, filename } = c.req.param();

  // A lesson row for this id may not exist yet (this is the very first
  // upload before POST /api/lessons creates the draft) — that's fine, any
  // signed-in user can claim a fresh id they generated themselves. But if a
  // row DOES already exist, only its owner may write more media under it —
  // otherwise a malicious signed-in user could extract another lesson's id
  // from its public `ne`/`thumbnail` path and overwrite that media.
  const existing = await getLessonById(c.env.DB, id);
  if (existing && existing.owner_id !== user.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  if (!c.req.raw.body) {
    return c.json({ error: "empty body" }, 400);
  }

  // The client always PUTs a whole Blob/File (never a chunked stream), so a
  // real request always carries an exact Content-Length — a missing one is
  // rejected rather than letting an unbounded stream through to R2.
  const contentLength = Number(c.req.header("content-length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return c.json({ error: "content-length header is required" }, 411);
  }
  const limit = THUMBNAIL_FILENAME_RE.test(filename)
    ? MAX_THUMBNAIL_BYTES
    : CAPTION_FILENAME_RE.test(filename)
      ? MAX_CAPTION_BYTES
      : MAX_MEDIA_BYTES;
  if (contentLength > limit) {
    return c.json({ error: "file too large" }, 413);
  }

  const key = `lessons/${id}/${filename}`;
  await c.env.BUCKET.put(key, c.req.raw.body, {
    httpMetadata: {
      contentType: storedContentTypeFor(filename),
    },
  });

  return c.json({ path: key });
};

// Both params become the R2 key `lessons/<id>/<filename>`: :id is held to
// LESSON_ID_PATTERN (lessonIds.ts), the charset POST /api/lessons accepts, and
// :filename to the lesson media files a row may point at (lessonMediaFiles.ts).
uploadsRoute.put(
  `/:id{${LESSON_ID_PATTERN}}/media/:filename{${LESSON_MEDIA_FILENAME_PATTERN}}`,
  requireUser,
  handleMediaUpload,
);

// Sibling caption files: `<id>.<lang>.vtt` (uploadLesson.ts) — the one filename shape
// that legitimately carries a dot inside the basename, so it gets its own pattern
// instead of loosening the main allow-list. The optional middle segment is a
// lowercase language tag; the charset still can't encode `/`, `..`, or a second
// extension, and `.vtt` is served back as inert text (nosniff, see routes/media.ts).
uploadsRoute.put(
  `/:id{${LESSON_ID_PATTERN}}/media/:filename{[\\w-]+(?:\\.[a-z0-9-]+)?\\.vtt}`,
  requireUser,
  handleMediaUpload,
);
