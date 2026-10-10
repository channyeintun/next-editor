import { Hono } from "hono";
import type { Env } from "../env";
import { getPublishedAuthorProfile } from "../../db/authorQueries";
import {
  lessonRowToLesson,
  playlistRowToPlaylistSummary,
  userRowToAuthorSummary,
} from "../../db/types";

// Mounted at /api/authors in worker/index.ts. Public, published-only — backs
// the /learn/@username profile view for anyone but the profile's own owner
// (the owner's view uses /api/lessons/mine instead, which includes drafts).
export const authorsRoute = new Hono<{ Bindings: Env }>();

authorsRoute.get("/:username", async (c) => {
  const profile = await getPublishedAuthorProfile(c.env.DB, c.req.param("username"));
  if (!profile) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json({
    user: userRowToAuthorSummary(profile.user),
    lessons: profile.lessons.map(lessonRowToLesson),
    playlists: profile.playlists.map(playlistRowToPlaylistSummary),
  });
});
