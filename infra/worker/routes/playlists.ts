import { Hono } from "hono";
import type { Env } from "../env";
import {
  addLessonToPlaylist,
  deletePlaylist,
  getOwnedPlaylistById,
  getOwnedPlaylistLessons,
  getPlaylistById,
  getPlaylistBySlug,
  insertPlaylist,
  listOwnedPlaylists,
  listOwnedPlaylistsForLesson,
  removeLessonFromPlaylist,
  reorderPlaylistLessons,
  updatePlaylist,
  type UpdatePlaylistParams,
} from "../../db/playlistQueries";
import {
  lessonRowToOwnedLesson,
  playlistRowToOwnedPlaylist,
  playlistRowToOwnedPlaylistWithMembership,
  playlistRowToPlaylist,
} from "../../db/types";
import { getCurrentUser } from "../auth/session";
import { cached, getCache, invalidateCache, playlistSlugKey } from "../cache";

// Shorter than the lesson-slug 300s tier: a playlist's cache can also go
// stale from a member lesson being unpublished/deleted elsewhere (in
// lessons.ts), which doesn't invalidate this key. A short TTL accepts brief
// staleness there instead of threading cross-file cache invalidation.
const SLUG_CACHE_TTL_SECONDS = 60;

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "playlist";
}

// Mounted at /api/playlists in worker/index.ts. GET /:slug is public; a
// playlist is always public once created (no draft/published state, unlike
// lessons) — see docs plan for the "always public" product decision.
// Everything else requires the signed-in owner.
export const playlistsRoute = new Hono<{ Bindings: Env }>();

interface CreatePlaylistBody {
  title?: unknown;
  description?: unknown;
}

playlistsRoute.post("/", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<CreatePlaylistBody>().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return c.json({ error: "title is required" }, 400);
  }

  const id = crypto.randomUUID();
  const slug = `${slugify(title)}-${id.slice(0, 8)}`;
  const row = await insertPlaylist(c.env.DB, {
    id,
    slug,
    ownerId: user.id,
    title,
    description: typeof body?.description === "string" ? body.description : null,
  });
  return c.json(
    playlistRowToOwnedPlaylist({ ...row, lesson_count: 0, first_lesson_thumbnail: null }),
    201,
  );
});

// Must be registered before the catch-all "/:slug" GET below, same ordering
// reason as GET /mine in lessons.ts. The optional ?lessonId= backs the "Add
// to playlist" popover (MyLessonCard) — every owned playlist, each flagged
// with whether that lesson is already a member, in one request.
playlistsRoute.get("/mine", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const lessonId = c.req.query("lessonId");
  if (lessonId) {
    const rows = await listOwnedPlaylistsForLesson(c.env.DB, user.id, lessonId);
    return c.json({ playlists: rows.map(playlistRowToOwnedPlaylistWithMembership) });
  }

  const rows = await listOwnedPlaylists(c.env.DB, user.id);
  return c.json({ playlists: rows.map(playlistRowToOwnedPlaylist) });
});

// Owner-scoped membership read for the manage panel: every member including
// currently-unpublished ones (the public GET /:slug below filters those out,
// which would leave an unpublished member invisible and unremovable). Two
// path segments, so the single-segment "/:slug" catch-all can't shadow it.
playlistsRoute.get("/:id/lessons", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const rows = await getOwnedPlaylistLessons(c.env.DB, c.req.param("id"), user.id);
  if (!rows) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ lessons: rows.map(lessonRowToOwnedLesson) });
});

playlistsRoute.patch("/:id", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<CreatePlaylistBody>().catch(() => null);
  if (!body) {
    return c.json({ error: "invalid body" }, 400);
  }

  const updateParams: UpdatePlaylistParams = {};
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

  const id = c.req.param("id");
  const row = await updatePlaylist(c.env.DB, id, user.id, updateParams);
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }

  await invalidateCache(getCache(c.env), playlistSlugKey(row.slug));
  const withCount = await getOwnedPlaylistById(c.env.DB, row.id, user.id);
  return c.json(
    playlistRowToOwnedPlaylist(
      withCount ?? { ...row, lesson_count: 0, first_lesson_thumbnail: null },
    ),
  );
});

playlistsRoute.delete("/:id", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const id = c.req.param("id");
  const existing = await getPlaylistById(c.env.DB, id);
  const deleted = await deletePlaylist(c.env.DB, id, user.id);
  if (!deleted) {
    return c.json({ error: "not found" }, 404);
  }

  if (existing) {
    await invalidateCache(getCache(c.env), playlistSlugKey(existing.slug));
  }
  return c.json({ success: true });
});

interface AddLessonBody {
  lessonId?: unknown;
}

playlistsRoute.post("/:id/lessons", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<AddLessonBody>().catch(() => null);
  if (!body || typeof body.lessonId !== "string" || !body.lessonId) {
    return c.json({ error: "lessonId is required" }, 400);
  }

  const id = c.req.param("id");
  const result = await addLessonToPlaylist(c.env.DB, id, user.id, body.lessonId);
  if (result === "not_found") {
    return c.json({ error: "not found" }, 404);
  }
  if (result === "lesson_not_eligible") {
    return c.json({ error: "lesson must be one of your own published lessons" }, 400);
  }
  if (result === "already_added") {
    return c.json({ error: "lesson is already in this playlist" }, 409);
  }

  const playlist = await getPlaylistById(c.env.DB, id);
  if (playlist) {
    await invalidateCache(getCache(c.env), playlistSlugKey(playlist.slug));
  }
  return c.json({ success: true }, 201);
});

playlistsRoute.delete("/:id/lessons/:lessonId", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const id = c.req.param("id");
  const lessonId = c.req.param("lessonId");
  const removed = await removeLessonFromPlaylist(c.env.DB, id, user.id, lessonId);
  if (!removed) {
    return c.json({ error: "not found" }, 404);
  }

  const playlist = await getPlaylistById(c.env.DB, id);
  if (playlist) {
    await invalidateCache(getCache(c.env), playlistSlugKey(playlist.slug));
  }
  return c.json({ success: true });
});

interface ReorderBody {
  lessonIds?: unknown;
}

playlistsRoute.post("/:id/reorder", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<ReorderBody>().catch(() => null);
  if (
    !body ||
    !Array.isArray(body.lessonIds) ||
    !body.lessonIds.every((v) => typeof v === "string")
  ) {
    return c.json({ error: "lessonIds must be an array of strings" }, 400);
  }

  const id = c.req.param("id");
  const reordered = await reorderPlaylistLessons(c.env.DB, id, user.id, body.lessonIds as string[]);
  if (!reordered) {
    return c.json({ error: "not found" }, 404);
  }

  const playlist = await getPlaylistById(c.env.DB, id);
  if (playlist) {
    await invalidateCache(getCache(c.env), playlistSlugKey(playlist.slug));
  }
  return c.json({ success: true });
});

// Registered last: a bare "/:slug" GET would otherwise shadow the more
// specific routes above (see lessons.ts's identical comment).
playlistsRoute.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const playlist = await cached(
    getCache(c.env),
    playlistSlugKey(slug),
    SLUG_CACHE_TTL_SECONDS,
    async () => {
      const result = await getPlaylistBySlug(c.env.DB, slug);
      return result ? playlistRowToPlaylist(result.playlist, result.lessons) : null;
    },
  );
  if (!playlist) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(playlist);
});
