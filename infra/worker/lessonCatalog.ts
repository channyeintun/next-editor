import seedManifest from "../../tube/data/lessons.json";
import type { Lesson } from "../lessons/types";
import {
  GALLERY_PAGE_SIZE,
  toGalleryPage,
  type GalleryPage,
  type RawGalleryPage,
} from "../lessons/galleryPages";
import { listGalleryCards } from "../db/galleryQueries";
import { getPublishedLessonBySlug, listPublishedLessons } from "../db/queries";
import { galleryCardRowToItem, lessonRowToLesson } from "../db/types";
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

/** Lessons per page of GET /api/lessons. */
const LESSONS_PAGE_SIZE = 12;

/** GET /api/lessons?page=n's body. */
export interface RawLessonsPage {
  lessons: Lesson[];
  /** The next page's number, or null on the last one. */
  nextPage: number | null;
}

/**
 * `?page=` of the paged catalog reads (GET /api/lessons, GET /api/gallery):
 * absent is page 0; anything but a whole number from 0 up is null.
 */
export function catalogPageParam(raw: string | undefined): number | null {
  const page = raw ? Number(raw) : 0;
  return Number.isInteger(page) && page >= 0 ? page : null;
}

/**
 * One page of every user-published lesson, newest first, playlist members
 * included: GET /api/lessons?page=n's body. The gallery does not read it (it
 * shows cards, see readGalleryCards); scripts/recordings-check walks it.
 * Read from D1 on every call, so a publish shows up at once.
 */
export async function readPublishedLessonsPage(env: Env, page: number): Promise<RawLessonsPage> {
  const { rows, nextPage } = await listPublishedLessons(env.DB, page, LESSONS_PAGE_SIZE);
  return { lessons: rows.map(lessonRowToLesson), nextPage };
}

/**
 * One page of the gallery's cards, newest first — a playlist in place of the
 * lessons it holds — read from D1 on every call: GET /api/gallery?page=n's
 * body.
 */
export async function readGalleryCards(env: Env, page: number): Promise<RawGalleryPage> {
  const { rows, nextPage } = await listGalleryCards(env.DB, page, GALLERY_PAGE_SIZE);
  return { items: rows.map(galleryCardRowToItem), nextPage };
}

/**
 * The gallery's page as its client caches it (tube's fetchGalleryPage builds
 * the same from the JSON above): for the /learn edge render.
 */
export async function readGalleryPage(env: Env, page: number): Promise<GalleryPage> {
  return toGalleryPage(await readGalleryCards(env, page), SEED_LESSONS);
}
