import { Hono } from "hono";
import type { Env } from "../env";
import {
  deleteLesson,
  getOwnedLessonById,
  insertDraftLesson,
  listOwnedLessons,
  listPublishedLessons,
  publishLesson,
  unpublishLesson,
  updateLesson,
  type UpdateLessonParams,
} from "../../db/queries";
import { generateUniqueSlug, isSlugUniqueViolation, MAX_SLUG_INSERT_ATTEMPTS } from "../../db/slug";
import { lessonRowToLesson, lessonRowToOwnedLesson } from "../../db/types";
import { getCurrentUser } from "../auth/session";
import { DEFAULT_THUMBNAIL_PATH } from "../../lessons/defaultThumbnail";
import { metadataTextError } from "../../lessons/metadataLimits";
import { cached, getCache, invalidateCache, lessonListKey, lessonSlugKey } from "../cache";
import { findPublishedLessonBySlug } from "../lessonCatalog";
import { isLessonId, LESSON_ID_PATTERN } from "../lessonIds";

const DEFAULT_PAGE_SIZE = 12;
// Short TTL: a newly published/edited lesson should show up in the public
// gallery within roughly this long. The list isn't invalidated key-by-key on
// writes (see invalidateCache calls below) — every paginated page would need
// tracking for a marginal staleness win, so it just relies on this TTL
// instead. The per-slug equivalent lives in lessonCatalog.ts, shared with the
// edge render.
const LIST_CACHE_TTL_SECONDS = 60;

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "lesson";
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

// The client sends the raw R2 key it just uploaded to (e.g.
// "lessons/<id>/<id>.ne", from POST /api/uploads/:id/media/:filename's
// response) — but that key is only actually servable at /media/<key> (see
// routes/media.ts), not at the bare key path. tube's resolveThumb()/
// LessonDetail always do `/${lesson.ne}` (matching the static seed
// manifest's convention, where seed files really do live at the site root),
// so the value stored here must already include the "media/" prefix or the
// resulting URL 404s straight to the SPA shell instead of the real bytes.
function toMediaPath(rawUploadPath: string): string {
  return `media/${rawUploadPath}`;
}

// The default thumbnail is a static asset at the site root (public/default-thumbnail.webp),
// not something the client uploaded to R2 — so unlike every other `thumbnail` value, it must
// NOT get the "media/" prefix above, or it'd 404 looking for R2 bytes that don't exist.
function toStoredThumbnailPath(rawThumbnail: string): string {
  return rawThumbnail === DEFAULT_THUMBNAIL_PATH
    ? DEFAULT_THUMBNAIL_PATH
    : toMediaPath(rawThumbnail);
}

// Mirrors the filename charset + extension allow-list that
// PUT /api/uploads/:id/media/:filename enforces (routes/uploads.ts).
const UPLOADED_FILENAME_RE = /^[\w-]+\.(?:ne|ogg|weba|webm|mp4|mov|m4a|mp3|wav|png|jpg|jpeg)$/;

// The upload route enforces ownership when the bytes are written, but nothing
// used to link the `ne`/`thumbnail` value stored on the lesson row back to
// that check — a signed-in user could point their lesson at another lesson's
// public media key. Require the value to sit under this lesson's own upload
// prefix with an uploadable filename.
function isOwnUploadPath(value: string, lessonId: string): boolean {
  const prefix = `lessons/${lessonId}/`;
  return value.startsWith(prefix) && UPLOADED_FILENAME_RE.test(value.slice(prefix.length));
}

// Mounted at /api/lessons in worker/index.ts. GET routes are public and
// published-only — draft rows never reach the public gallery (see
// docs/cloudflare-architecture.md). Everything else requires the signed-in
// owner (getCurrentUser + an owner_id match enforced in the query itself).
export const lessonsRoute = new Hono<{ Bindings: Env }>();

lessonsRoute.get("/", async (c) => {
  const pageParam = c.req.query("page");
  const page = pageParam ? Number(pageParam) : 0;
  if (!Number.isInteger(page) || page < 0) {
    return c.json({ error: "invalid page" }, 400);
  }

  // An empty page loads as null, which cached() never stores: every distinct
  // ?page= is its own KV key, so caching the empty pages past the end would let
  // an unauthenticated loop over page numbers mint one KV write per request.
  const body = await cached(
    getCache(c.env),
    lessonListKey(page, DEFAULT_PAGE_SIZE),
    LIST_CACHE_TTL_SECONDS,
    async () => {
      const { rows, nextPage } = await listPublishedLessons(c.env.DB, page, DEFAULT_PAGE_SIZE);
      return rows.length > 0 ? { lessons: rows.map(lessonRowToLesson), nextPage } : null;
    },
  );
  return c.json(body ?? { lessons: [], nextPage: null });
});

interface CreateLessonBody {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  tags?: unknown;
  duration?: unknown;
  ne?: unknown;
  thumbnail?: unknown;
}

lessonsRoute.post("/", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<CreateLessonBody>().catch(() => null);
  if (!body || !isLessonId(body.id)) {
    return c.json({ error: "a lesson id is required" }, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return c.json({ error: "title is required" }, 400);
  }
  if (typeof body.ne !== "string" || !body.ne) {
    return c.json({ error: "ne is required" }, 400);
  }
  if (!isOwnUploadPath(body.ne, body.id)) {
    return c.json({ error: "ne must be a media path uploaded for this lesson" }, 400);
  }
  if (
    typeof body.thumbnail === "string" &&
    body.thumbnail !== DEFAULT_THUMBNAIL_PATH &&
    !isOwnUploadPath(body.thumbnail, body.id)
  ) {
    return c.json({ error: "thumbnail must be a media path uploaded for this lesson" }, 400);
  }
  const description = typeof body.description === "string" ? body.description : null;
  const duration = typeof body.duration === "string" ? body.duration : null;
  const tags = asStringArray(body.tags);
  const textError = metadataTextError({ title, description, tags, duration });
  if (textError) {
    return c.json({ error: textError }, 400);
  }

  for (let attempt = 1; ; attempt++) {
    const slug = await generateUniqueSlug(c.env.DB, "lessons", slugify(title));
    try {
      const row = await insertDraftLesson(c.env.DB, {
        id: body.id,
        slug,
        ownerId: user.id,
        title,
        description,
        thumbnail:
          typeof body.thumbnail === "string" ? toStoredThumbnailPath(body.thumbnail) : null,
        ne: toMediaPath(body.ne),
        duration,
        tags,
        author: user.name,
        authorUrl: `/learn/@${user.username}`,
      });
      return c.json(lessonRowToOwnedLesson(row), 201);
    } catch (error) {
      // Two concurrent creates with the same title both passed
      // generateUniqueSlug's read and raced to INSERT — retry picks the next
      // suffix (D1 serializes writes, so the retry's read sees the winner).
      if (isSlugUniqueViolation(error, "lessons")) {
        if (attempt >= MAX_SLUG_INSERT_ATTEMPTS) {
          console.error("Failed to insert draft lesson after slug retries", error);
          return c.json({ error: "failed to create lesson" }, 500);
        }
        continue;
      }
      // Only realistic cause: `id` (the primary key) already exists — a
      // vanishingly unlikely UUID collision, or a retried request reusing an
      // id from an earlier attempt. Either way, ask the client to use a fresh id.
      console.error("Failed to insert draft lesson", error);
      return c.json({ error: "a lesson with this id already exists" }, 409);
    }
  }
});

lessonsRoute.patch(`/:id{${LESSON_ID_PATTERN}}`, async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<CreateLessonBody>().catch(() => null);
  if (!body) {
    return c.json({ error: "invalid body" }, 400);
  }

  const id = c.req.param("id");
  const updateParams: UpdateLessonParams = {};
  if (typeof body.title === "string") {
    const trimmed = body.title.trim();
    if (!trimmed) {
      return c.json({ error: "title cannot be empty" }, 400);
    }
    updateParams.title = trimmed;
  }
  if (typeof body.description === "string") {
    updateParams.description = body.description;
  }
  const tags = asStringArray(body.tags);
  if (tags !== null) {
    updateParams.tags = tags;
  }
  if (typeof body.thumbnail === "string") {
    if (body.thumbnail !== DEFAULT_THUMBNAIL_PATH && !isOwnUploadPath(body.thumbnail, id)) {
      return c.json({ error: "thumbnail must be a media path uploaded for this lesson" }, 400);
    }
    updateParams.thumbnail = toStoredThumbnailPath(body.thumbnail);
  }
  const textError = metadataTextError(updateParams);
  if (textError) {
    return c.json({ error: textError }, 400);
  }

  // Grabbed before the write because updateLesson's RETURNING reflects the
  // post-update row — the old value would otherwise already be gone by the
  // time we know whether the thumbnail actually changed.
  const previousThumbnail =
    updateParams.thumbnail !== undefined
      ? (await getOwnedLessonById(c.env.DB, id, user.id))?.thumbnail
      : null;

  const row = await updateLesson(c.env.DB, id, user.id, updateParams);
  // Deliberately the same 404 whether the lesson doesn't exist or exists but
  // belongs to someone else — doesn't leak existence to a non-owner.
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }

  if (
    previousThumbnail &&
    previousThumbnail !== row.thumbnail &&
    previousThumbnail !== DEFAULT_THUMBNAIL_PATH
  ) {
    // updateLessonThumbnail() (infra/client/upload/uploadLesson.ts) always
    // uploads the replacement to a fresh R2 key (timestamped, to dodge CDN
    // caching of the old bytes) rather than overwriting the old one in
    // place, so the superseded object is now orphaned — clean it up here.
    // Best-effort, same reasoning as the delete-lesson cleanup below: an
    // orphaned R2 object is a minor storage cost, not a correctness problem.
    try {
      await c.env.BUCKET.delete(previousThumbnail.replace(/^media\//, ""));
    } catch (error) {
      console.error("Failed to delete superseded thumbnail", { lessonId: id }, error);
    }
  }

  await invalidateCache(getCache(c.env), lessonSlugKey(row.slug));
  return c.json(lessonRowToOwnedLesson(row));
});

lessonsRoute.post(`/:id{${LESSON_ID_PATTERN}}/publish`, async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const row = await publishLesson(c.env.DB, c.req.param("id"), user.id);
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  // Keep the KV entry aligned with the authoritative publish state. Workers KV
  // is eventually consistent, so another edge can briefly retain its cached
  // value even after this delete succeeds.
  await invalidateCache(getCache(c.env), lessonSlugKey(row.slug));
  return c.json(lessonRowToOwnedLesson(row));
});

lessonsRoute.post(`/:id{${LESSON_ID_PATTERN}}/unpublish`, async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const row = await unpublishLesson(c.env.DB, c.req.param("id"), user.id);
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  // See the publish route above. Delete the shared entry now; KV's 30-second
  // regional read cache bounds the normal cross-edge propagation window.
  await invalidateCache(getCache(c.env), lessonSlugKey(row.slug));
  return c.json(lessonRowToOwnedLesson(row));
});

lessonsRoute.delete(`/:id{${LESSON_ID_PATTERN}}`, async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const id = c.req.param("id");
  const existing = await getOwnedLessonById(c.env.DB, id, user.id);
  if (!existing) {
    return c.json({ error: "not found" }, 404);
  }

  await deleteLesson(c.env.DB, id, user.id);
  await invalidateCache(getCache(c.env), lessonSlugKey(existing.slug));

  // The row goes first. If this cleanup fails the cost is orphaned R2 objects;
  // in the other order a failed row delete left a live lesson, possibly
  // published, whose media 404s for every viewer. Best-effort, and nothing
  // sweeps what it misses.
  try {
    const listed = await c.env.BUCKET.list({ prefix: `lessons/${id}/` });
    if (listed.objects.length > 0) {
      await c.env.BUCKET.delete(listed.objects.map((object) => object.key));
    }
  } catch (error) {
    console.error("Failed to clean up R2 objects", { lessonId: id }, error);
  }

  return c.json({ success: true });
});

// All of the signed-in owner's lessons (draft + published) — backs "My
// Library". Must be registered before the catch-all "/:slug" GET below (see
// the comment there).
lessonsRoute.get("/mine", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const rows = await listOwnedLessons(c.env.DB, user.id);
  return c.json({ lessons: rows.map(lessonRowToOwnedLesson) });
});

// Registered last: Hono dispatches in registration order, so a "/:slug" GET
// above "/mine" would answer /api/lessons/mine itself. (db/slug.ts never gives
// a row the slug "mine" for the same reason.)
lessonsRoute.get("/:slug", async (c) => {
  const lesson = await findPublishedLessonBySlug(c.env, c.req.param("slug"));
  if (!lesson) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(lesson);
});
