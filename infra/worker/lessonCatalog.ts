import seedManifest from "../../tube/data/lessons.json";
import type { Lesson } from "../lessons/types";
import {
  LESSONS_PAGE_SIZE,
  toLessonsPage,
  type LessonsPage,
  type RawLessonsPage,
} from "../lessons/lessonsPages";
import { getPublishedLessonBySlug, listPublishedLessons } from "../db/queries";
import { lessonRowToLesson } from "../db/types";
import type { Env } from "./env";

const SEED_LESSONS = seedManifest.lessons as Lesson[];

// Single slug → Lesson resolution, shared by GET /api/lessons/:slug and the
// lesson-detail edge render, so the JSON API and the edge-rendered document
// always agree on a row. Mirrors the client's own order in
// tube/src/lib/lessons.ts: the build-time seed manifest first (those lessons
// are static assets, not D1 rows at all), then the published D1 catalog, read
// directly rather than through a cache (see cache.ts for why).
export async function findPublishedLessonBySlug(env: Env, slug: string): Promise<Lesson | null> {
  const seeded = SEED_LESSONS.find((lesson) => lesson.slug === slug);
  if (seeded) {
    return seeded;
  }

  const row = await getPublishedLessonBySlug(env.DB, slug);
  return row ? lessonRowToLesson(row) : null;
}

/**
 * One page of user-published lessons, newest first, read from D1 on every
 * call (a publish shows up at once): GET /api/lessons?page=n's body.
 */
export async function readPublishedLessonsPage(env: Env, page: number): Promise<RawLessonsPage> {
  const { rows, nextPage } = await listPublishedLessons(env.DB, page, LESSONS_PAGE_SIZE);
  return { lessons: rows.map(lessonRowToLesson), nextPage };
}

/**
 * The gallery's page as its client caches it (tube's fetchLessonsPage builds
 * the same from the JSON above): for the /learn edge render.
 */
export async function readGalleryPage(env: Env, page: number): Promise<LessonsPage> {
  return toLessonsPage(await readPublishedLessonsPage(env, page), SEED_LESSONS);
}
