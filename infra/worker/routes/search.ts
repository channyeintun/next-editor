import { Hono } from "hono";
import type { Env } from "../env";
import { searchPublishedLessons, searchUsers } from "../../db/queries";
import { searchPublishedPlaylists } from "../../db/playlistQueries";
import {
  lessonRowToLesson,
  playlistRowToPlaylistSummary,
  userRowToAuthorSummary,
} from "../../db/types";

const AUTHOR_LIMIT = 6;
const PLAYLIST_LIMIT = 8;
/** Lessons per page: a whole number of rows at every gallery width (1–4 columns). */
const LESSON_PAGE_SIZE = 24;
/** The last page a search can ask for; past it the request is refused. */
const MAX_PAGE = 100;

/** `?page=`: absent is page 0; anything but a whole number up to MAX_PAGE is null. */
function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const page = Number(raw);
  return page <= MAX_PAGE ? page : null;
}

// Mounted at /api/search in worker/index.ts. Public — searches every
// published lesson, public playlist and user, not just what the client has
// paged in. Lessons come a page at a time (`?page=N`, answering `nextPage`);
// authors and playlists come once, on page 0, and the client renders them
// before the lessons, so searching for a course offers the course itself.
export const searchRoute = new Hono<{ Bindings: Env }>();

searchRoute.get("/", async (c) => {
  const page = parsePage(c.req.query("page"));
  if (page === null) {
    return c.json({ error: "invalid page" }, 400);
  }
  // Bound query length: a long %…% pattern with a leading wildcard forces a
  // full-table scan, so we cap it defensively at 100 characters.
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  if (!q) {
    return c.json({ authors: [], playlists: [], lessons: [], lessonTotal: 0, nextPage: null });
  }

  const offset = page * LESSON_PAGE_SIZE;
  const [authorRows, playlistRows, lessonPage] = await Promise.all([
    page === 0 ? searchUsers(c.env.DB, q, AUTHOR_LIMIT) : [],
    page === 0 ? searchPublishedPlaylists(c.env.DB, q, PLAYLIST_LIMIT) : [],
    searchPublishedLessons(c.env.DB, q, { limit: LESSON_PAGE_SIZE, offset }),
  ]);
  const hasMore = offset + lessonPage.lessons.length < lessonPage.total && page < MAX_PAGE;

  return c.json({
    authors: authorRows.map(userRowToAuthorSummary),
    playlists: playlistRows.map(playlistRowToPlaylistSummary),
    lessons: lessonPage.lessons.map(lessonRowToLesson),
    lessonTotal: lessonPage.total,
    nextPage: hasMore ? page + 1 : null,
  });
});
