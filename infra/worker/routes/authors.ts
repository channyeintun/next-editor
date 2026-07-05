import { Hono } from "hono";
import type { Env } from "../env";
import { getUserByUsername, listPublishedLessonsByOwner } from "../../db/queries";
import { lessonRowToLesson, userRowToAuthorSummary } from "../../db/types";

// Mounted at /api/authors in worker/index.ts. Public, published-only — backs
// the /learn/@username profile view for anyone but the profile's own owner
// (the owner's view uses /api/lessons/mine instead, which includes drafts).
export const authorsRoute = new Hono<{ Bindings: Env }>();

authorsRoute.get("/:username", async (c) => {
  const user = await getUserByUsername(c.env.DB, c.req.param("username"));
  if (!user) {
    return c.json({ error: "not found" }, 404);
  }

  const rows = await listPublishedLessonsByOwner(c.env.DB, user.id);
  return c.json({
    user: userRowToAuthorSummary(user),
    lessons: rows.map(lessonRowToLesson),
  });
});
