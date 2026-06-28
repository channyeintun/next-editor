import axios from "axios";
import type { Lesson } from "../types";

export interface LessonsPage {
  lessons: Lesson[];
  /** Next page index, or null once the last page has been served. */
  nextPage: number | null;
}

// True pagination over static page shards emitted by the lessonsPagination Vite
// plugin (see vite.config.ts): the client downloads only the page it's showing,
// never the whole catalog. Swap point for a real backend: point this at
// `/api/lessons?page=${page}` and return the server's cursor as nextPage.
export async function fetchLessonsPage(page: number): Promise<LessonsPage> {
  const res = await axios.get<LessonsPage>(`/lessons/page-${page}.json`);
  return res.data;
}

// One request per lesson for the deep-linkable detail route — no catalog scan.
// Returns null (not undefined — Query rejects undefined) when the slug has no
// shard, so the route can tell "not found" from a real fetch failure.
export async function findLessonBySlug(slug: string): Promise<Lesson | null> {
  try {
    const res = await axios.get<Lesson>(`/lessons/by-slug/${encodeURIComponent(slug)}.json`);
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}
