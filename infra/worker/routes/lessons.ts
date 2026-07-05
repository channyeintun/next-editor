import { Hono } from "hono";
import type { Env } from "../env";
import {
  deleteLesson,
  getLessonById,
  getPublishedLessonBySlug,
  insertDraftLesson,
  listPublishedLessons,
  publishLesson,
  updateLesson,
  type UpdateLessonParams,
} from "../../db/queries";
import { lessonRowToLesson, lessonRowToOwnedLesson } from "../../db/types";
import { getCurrentUser } from "../auth/session";

const DEFAULT_PAGE_SIZE = 12;

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

  const { rows, nextPage } = await listPublishedLessons(c.env.DB, page, DEFAULT_PAGE_SIZE);
  return c.json({ lessons: rows.map(lessonRowToLesson), nextPage });
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
  if (!body || typeof body.id !== "string" || !body.id) {
    return c.json({ error: "id is required" }, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return c.json({ error: "title is required" }, 400);
  }
  if (typeof body.ne !== "string" || !body.ne) {
    return c.json({ error: "ne is required" }, 400);
  }

  const slug = `${slugify(title)}-${body.id.slice(0, 8)}`;

  try {
    const row = await insertDraftLesson(c.env.DB, {
      id: body.id,
      slug,
      ownerId: user.id,
      title,
      description: typeof body.description === "string" ? body.description : null,
      thumbnail: typeof body.thumbnail === "string" ? body.thumbnail : null,
      ne: body.ne,
      duration: typeof body.duration === "string" ? body.duration : null,
      tags: asStringArray(body.tags),
      author: user.name,
      authorUrl: null,
    });
    return c.json(lessonRowToOwnedLesson(row), 201);
  } catch (error) {
    // Only realistic cause: `id` (the primary key) already exists — a
    // vanishingly unlikely UUID collision, or a retried request reusing an
    // id from an earlier attempt. Either way, ask the client to use a fresh id.
    console.error("Failed to insert draft lesson", error);
    return c.json({ error: "a lesson with this id already exists" }, 409);
  }
});

lessonsRoute.patch("/:id", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<CreateLessonBody>().catch(() => null);
  if (!body) {
    return c.json({ error: "invalid body" }, 400);
  }

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
    updateParams.thumbnail = body.thumbnail;
  }

  const row = await updateLesson(c.env.DB, c.req.param("id"), user.id, updateParams);
  // Deliberately the same 404 whether the lesson doesn't exist or exists but
  // belongs to someone else — doesn't leak existence to a non-owner.
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(lessonRowToOwnedLesson(row));
});

lessonsRoute.post("/:id/publish", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const row = await publishLesson(c.env.DB, c.req.param("id"), user.id);
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(lessonRowToOwnedLesson(row));
});

lessonsRoute.delete("/:id", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const id = c.req.param("id");
  const existing = await getLessonById(c.env.DB, id);
  if (!existing || existing.owner_id !== user.id) {
    return c.json({ error: "not found" }, 404);
  }

  // Best-effort: an orphaned R2 object is a minor storage cost, not a
  // correctness problem, so a listing/delete failure here doesn't block the
  // D1 delete below. Phase 4's reconcile cron can sweep anything this misses.
  try {
    const listed = await c.env.BUCKET.list({ prefix: `lessons/${id}/` });
    if (listed.objects.length > 0) {
      await c.env.BUCKET.delete(listed.objects.map((object) => object.key));
    }
  } catch (error) {
    console.error("Failed to clean up R2 objects for lesson", id, error);
  }

  await deleteLesson(c.env.DB, id, user.id);
  return c.json({ success: true });
});

// Registered last: a bare "/:slug" GET would otherwise shadow more specific
// routes above if Hono's router ever preferred registration order over route
// specificity for a literal-vs-param conflict (it currently doesn't, but this
// ordering keeps the file correct even if that assumption changes).
lessonsRoute.get("/:slug", async (c) => {
  const row = await getPublishedLessonBySlug(c.env.DB, c.req.param("slug"));
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(lessonRowToLesson(row));
});
