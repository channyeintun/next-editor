import { Hono } from "hono";
import type { Env } from "../env";
import { searchPublishedLessons, searchUsers } from "../../db/queries";
import { lessonRowToLesson, userRowToAuthorSummary } from "../../db/types";

const AUTHOR_LIMIT = 6;
const LESSON_LIMIT = 24;

// Mounted at /api/search in worker/index.ts. Public — searches every
// published lesson and every user, not just what the client has paged in.
// Authors are returned alongside (not filtered into) lessons; the client
// renders authors first per the product requirement.
export const searchRoute = new Hono<{ Bindings: Env }>();

searchRoute.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) {
    return c.json({ authors: [], lessons: [] });
  }

  const [authorRows, lessonRows] = await Promise.all([
    searchUsers(c.env.DB, q, AUTHOR_LIMIT),
    searchPublishedLessons(c.env.DB, q, LESSON_LIMIT),
  ]);

  return c.json({
    authors: authorRows.map(userRowToAuthorSummary),
    lessons: lessonRows.map(lessonRowToLesson),
  });
});
