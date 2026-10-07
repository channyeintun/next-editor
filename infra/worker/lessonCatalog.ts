import seedManifest from "../../tube/data/lessons.json";
import type { Lesson } from "../../tube/src/types";
import { getPublishedLessonBySlug } from "../db/queries";
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
