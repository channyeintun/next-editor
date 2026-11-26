import { Hono } from "hono";
import type { Env } from "../env";
import { catalogPageParam, readGalleryCards } from "../lessonCatalog";

// Mounted at /api/gallery in worker/index.ts. Public: the cards of the /learn
// gallery, a page at a time, newest first. A playlist is one card in place of
// the lessons it holds; a published lesson in no playlist is its own card
// (infra/db/galleryQueries.ts). GET /api/lessons still lists every published
// lesson, playlist members included.
export const galleryRoute = new Hono<{ Bindings: Env }>();

galleryRoute.get("/", async (c) => {
  const page = catalogPageParam(c.req.query("page"));
  if (page === null) {
    return c.json({ error: "invalid page" }, 400);
  }

  // Read from D1 on every request, like the other public catalog reads (see
  // cache.ts), so a publish, or a lesson added to a playlist, shows up in the
  // gallery immediately.
  return c.json(await readGalleryCards(c.env, page));
});
