import { Hono } from "hono";
import type { Env } from "../env";
import { getPublishedLessonBySlug, listPublishedLessons } from "../../db/queries";
import { lessonRowToLesson } from "../../db/types";

const DEFAULT_PAGE_SIZE = 12;

// Mounted at /api/lessons in worker/index.ts. Published lessons only — draft
// rows never reach the public gallery (see docs/cloudflare-architecture.md).
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

lessonsRoute.get("/:slug", async (c) => {
  const row = await getPublishedLessonBySlug(c.env.DB, c.req.param("slug"));
  if (!row) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(lessonRowToLesson(row));
});
