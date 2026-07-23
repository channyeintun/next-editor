import seedManifest from "../../tube/data/lessons.json";
import type { Lesson } from "../../tube/src/types";
import { getPublishedLessonBySlug } from "../db/queries";
import { lessonRowToLesson } from "../db/types";
import { cached, getCache, lessonSlugKey } from "./cache";
import type { Env } from "./env";

// A newly published/edited lesson should appear on its detail page within
// roughly this long. Both readers below share it, so the JSON API and the
// edge-rendered document can never serve different generations of a row.
export const SLUG_CACHE_TTL_SECONDS = 300;

const SEED_LESSONS = seedManifest.lessons as Lesson[];

// Single slug → Lesson resolution, shared by GET /api/lessons/:slug and the
// lesson-detail edge render. Mirrors the client's own order in
// tube/src/lib/lessons.ts: the build-time seed manifest first (those lessons
// are static assets, not D1 rows at all), then the published D1 catalog behind
// the KV cache.
//
// A cache miss on a not-found slug is never populated: cached() treats a stored
// `null` the same as "no entry" and re-queries D1 every time. Fine here — 404s
// are cheap and rare enough not to need their own cache path.
export async function findPublishedLessonBySlug(env: Env, slug: string): Promise<Lesson | null> {
  const seeded = SEED_LESSONS.find((lesson) => lesson.slug === slug);
  if (seeded) {
    return seeded;
  }

  return cached(getCache(env), lessonSlugKey(slug), SLUG_CACHE_TTL_SECONDS, async () => {
    const row = await getPublishedLessonBySlug(env.DB, slug);
    return row ? lessonRowToLesson(row) : null;
  });
}
