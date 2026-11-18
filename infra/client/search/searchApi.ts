import { apiClient } from "../apiClient";
import type { AuthorSummary, PlaylistSummary } from "../../db/types";
import type { Lesson } from "../../lessons/types";

/** One page of GET /api/search. Authors and playlists come on page 0 only. */
export interface SearchPage {
  authors: AuthorSummary[];
  playlists: PlaylistSummary[];
  lessons: Lesson[];
  /** How many published lessons match, across every page. */
  lessonTotal: number;
  /** The page to ask for next, or null after the last one. */
  nextPage: number | null;
}

/** A search's answer so far: every page loaded, as one list. */
export interface SearchResults {
  authors: AuthorSummary[];
  playlists: PlaylistSummary[];
  lessons: Lesson[];
  /** How many published lessons match — more than `lessons` until the last page loads. */
  lessonTotal: number;
  /** How many pages `lessons` holds: 1 until the reader asks for more. */
  pageCount: number;
}

export async function search(q: string, page: number): Promise<SearchPage> {
  const res = await apiClient.get<SearchPage>("/search", { params: { q, page } });
  return res.data;
}

/**
 * The loaded pages as one answer. Pages are offsets into a live catalog, so a
 * lesson published between two page loads can push one already shown onto the
 * next page too; each lesson is kept once, where it first appeared.
 */
export function mergeSearchPages(pages: readonly SearchPage[]): SearchResults {
  const first = pages[0];
  const seen = new Set<string>();
  const lessons: Lesson[] = [];
  for (const page of pages) {
    for (const lesson of page.lessons) {
      if (seen.has(lesson.slug)) continue;
      seen.add(lesson.slug);
      lessons.push(lesson);
    }
  }
  return {
    authors: first?.authors ?? [],
    playlists: first?.playlists ?? [],
    lessons,
    // The newest page's count, never fewer than the lessons already shown.
    lessonTotal: Math.max(pages.at(-1)?.lessonTotal ?? 0, lessons.length),
    pageCount: pages.length,
  };
}
