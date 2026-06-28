import axios from "axios";
import type { Lesson, LessonsManifest } from "../types";

export const LESSONS_PAGE_SIZE = 12;

const api = axios.create();

// The lessons manifest is a single static file. Read it once per session and
// dedupe behind this memo so both the paginated grid and a deep-linked detail
// page share one network round-trip. A rejection clears the memo so a retry
// refetches. TanStack Query layers result caching + the infinite-scroll
// machinery on top; this just guarantees the file itself is fetched once.
let manifest: Promise<Lesson[]> | null = null;

function loadManifest(): Promise<Lesson[]> {
  if (!manifest) {
    manifest = api
      .get<LessonsManifest>("/lessons.json")
      .then((res) => res.data.lessons)
      .catch((err) => {
        manifest = null;
        throw err;
      });
  }
  return manifest;
}

export interface LessonsPage {
  lessons: Lesson[];
  /** Next page index, or null once the last page has been served. */
  nextPage: number | null;
}

// Client-side windowing over the static manifest — the single swap point for
// real server pagination later: point this at `/api/lessons?page=${page}` and
// return the server's cursor as `nextPage`. The hook and grid above it don't
// change.
export async function fetchLessonsPage(page: number): Promise<LessonsPage> {
  const all = await loadManifest();
  const start = page * LESSONS_PAGE_SIZE;
  const lessons = all.slice(start, start + LESSONS_PAGE_SIZE);
  const hasMore = start + lessons.length < all.length;
  return { lessons, nextPage: hasMore ? page + 1 : null };
}

// Resolve a slug for the deep-linkable detail route. Returns null (not
// undefined) when missing — Query rejects an undefined queryFn result.
export async function findLessonBySlug(slug: string): Promise<Lesson | null> {
  const all = await loadManifest();
  return all.find((l) => l.slug === slug) ?? null;
}
