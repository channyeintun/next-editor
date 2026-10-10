import type { Lesson } from "./types";

// The public gallery's pages, one rule for both places that build one: tube's
// fetchLessonsPage (the client, from GET /api/lessons?page=n) and the /learn
// edge render (the Worker, from the same D1 page), which dehydrates page 0
// into the client's cache. A page built differently on either side would be a
// page the client never fetches.

/** Lessons per page of GET /api/lessons. */
export const LESSONS_PAGE_SIZE = 12;

/** GET /api/lessons?page=n's body: user-published lessons, newest first. */
export interface RawLessonsPage {
  lessons: Lesson[];
  /** The next D1 page's number, or null on the last one. */
  nextPage: number | null;
}

/** One page as the gallery caches it (lessonKeys.infinite). */
export interface LessonsPage {
  lessons: Lesson[];
  /**
   * Opaque cursor for the next page, or null once exhausted: "d1:<n>" for the
   * n-th D1-backed page of user-published lessons, newest first. The bundled
   * seed (introduction, etc.) has no page of its own; it rides on the last D1
   * page (see toLessonsPage and docs/cloudflare-architecture.md "Catalog
   * resolution").
   */
  nextPage: string | null;
}

/** The cursor of the gallery's first page: its infinite query's initialPageParam. */
export const FIRST_LESSONS_PAGE = "d1:0";

/**
 * The D1 page a cursor names. Anything that isn't a "d1:<n>" cursor starts
 * from the first page.
 */
export function lessonsPageIndex(cursor: string): number {
  const [source, indexStr] = cursor.split(":");
  return source === "d1" ? Number(indexStr) || 0 : 0;
}

/**
 * A D1 page as the gallery caches it. The bundled seed is appended to the last
 * D1 page, so it appears only once the gallery has loaded its oldest lessons.
 * That normally takes scrolling to the end; but the grid's sentinel loads ahead
 * by 400px, so a catalog of one or two pages on a tall window can reach its
 * last page, and the seed, without any scroll. An empty catalog's only page is
 * that last page, so the seed still shows there.
 */
export function toLessonsPage(page: RawLessonsPage, seedLessons: readonly Lesson[]): LessonsPage {
  if (page.nextPage !== null) {
    return { lessons: page.lessons, nextPage: `d1:${page.nextPage}` };
  }
  return { lessons: [...page.lessons, ...seedLessons], nextPage: null };
}
