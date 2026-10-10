import type { Lesson } from "../types";
import lessonsData from "../../data/lessons.json";
import {
  lessonsPageIndex,
  toLessonsPage,
  type LessonsPage,
  type RawLessonsPage,
} from "../../../infra/lessons/lessonsPages";
import { findCatalogItem, getCatalogJson } from "./catalogRequest";

export type { LessonsPage } from "../../../infra/lessons/lessonsPages";

const SEED_LESSONS = lessonsData.lessons as Lesson[];

// The Worker always answers /api/lessons* with JSON. A host without it (a
// static preview of the build) would answer with the SPA's index.html instead,
// which is read as an empty last page, so the gallery shows just the seed.
// Plain `bun run dev` is different: Vite proxies /api/lessons to the Worker on
// :8787 (vite.config.ts), so without `dev:worker` page 0 fails with a 502 and
// the gallery shows its error and a retry button.
async function fetchD1Page(index: number): Promise<RawLessonsPage> {
  const page = await getCatalogJson<RawLessonsPage>(`/api/lessons?page=${index}`);
  return page ?? { lessons: [], nextPage: null };
}

// Pages through user-published D1 lessons, newest first, shaped by the rule
// the /learn edge render shares (toLessonsPage): the bundled seed rides on the
// last page.
export async function fetchLessonsPage(cursor: string): Promise<LessonsPage> {
  return toLessonsPage(await fetchD1Page(lessonsPageIndex(cursor)), SEED_LESSONS);
}

/**
 * Flatten the loaded pages into the list the grid renders, keeping the first
 * occurrence of each slug.
 *
 * The ordering fix in listPublishedLessons (a total order, so tied
 * `published_at` values cannot straddle a page boundary) removes the cause
 * this was written for. It stays because OFFSET paging is racy for a reason
 * no ORDER BY can fix: pages are fetched as separate requests, minutes apart,
 * and routes/lessons.ts caches each page independently for 60s. If a lesson is
 * published between two of those fetches, every later row shifts down one and
 * the boundary row is genuinely returned twice.
 *
 * It also covers the D1→seed seam on the last page, where a slug present in
 * both catalogs would otherwise be rendered twice.
 *
 * Deduping is the right response rather than a cosmetic patch: React keys the
 * cards by slug, so a repeat is a duplicate key, not just a repeated picture.
 */
export function flattenLessonPages(pages: readonly LessonsPage[] | undefined): Lesson[] {
  const seen = new Set<string>();
  const lessons: Lesson[] = [];
  for (const page of pages ?? []) {
    for (const lesson of page.lessons) {
      if (seen.has(lesson.slug)) continue;
      seen.add(lesson.slug);
      lessons.push(lesson);
    }
  }
  return lessons;
}

// One request per lesson for the deep-linkable detail route — no catalog scan.
// Tries the static seed shard first, then the D1-backed API. Returns null (not
// undefined — Query rejects undefined) when the slug matches neither, so the
// route can tell "not found" from a real fetch failure.
export async function findLessonBySlug(slug: string): Promise<Lesson | null> {
  const seedLesson = SEED_LESSONS.find((l) => l.slug === slug);
  if (seedLesson) {
    return seedLesson as Lesson;
  }

  // A 404, or the dev-without-worker fallback fetchD1Page describes, is a miss.
  return findCatalogItem<Lesson>(`/api/lessons/${encodeURIComponent(slug)}`);
}
