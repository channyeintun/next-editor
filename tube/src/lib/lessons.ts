import type { GalleryItem, Lesson } from "../types";
import lessonsData from "../../data/lessons.json";
import {
  galleryItemKey,
  galleryPageIndex,
  toGalleryPage,
  type GalleryPage,
  type RawGalleryPage,
} from "../../../infra/lessons/galleryPages";
import { findCatalogItem, getCatalogJson } from "./catalogRequest";

export type { GalleryPage } from "../../../infra/lessons/galleryPages";

const SEED_LESSONS = lessonsData.lessons as Lesson[];

// The Worker always answers /api/gallery and /api/lessons* with JSON. A host
// without it (a static preview of the build) would answer with the SPA's
// index.html instead, which is read as an empty last page, so the gallery shows
// just the seed. Plain `bun run dev` is different: Vite proxies both to the
// Worker on :8787 (vite.config.ts), so without `dev:worker` page 0 fails with a
// 502 and the gallery shows its error and a retry button.
async function fetchD1Page(index: number): Promise<RawGalleryPage> {
  const page = await getCatalogJson<RawGalleryPage>(`/api/gallery?page=${index}`);
  return page ?? { items: [], nextPage: null };
}

// Pages through the gallery's cards, newest first: a playlist in place of the
// lessons it holds, and each published lesson in no playlist on its own. Shaped
// by the rule the /learn edge render shares (toGalleryPage): the bundled seed
// rides on the last page.
export async function fetchGalleryPage(cursor: string): Promise<GalleryPage> {
  return toGalleryPage(await fetchD1Page(galleryPageIndex(cursor)), SEED_LESSONS);
}

/**
 * Flatten the loaded pages into the cards the grid renders, keeping the first
 * occurrence of each (a lesson by its slug, a playlist by its own).
 *
 * The ordering in listGalleryCards (a total order, so tied rows cannot
 * straddle a page boundary) removes one cause of a repeat. This stays because
 * OFFSET paging is racy for a reason no ORDER BY can fix: pages are fetched as
 * separate requests, minutes apart, as the reader scrolls. If a lesson is
 * published between two of those fetches, every later row shifts down one and
 * the boundary row is genuinely returned twice. A playlist moves up to the
 * front the same way when a lesson of it is published.
 *
 * It also covers the D1→seed seam on the last page, where a slug present in
 * both catalogs would otherwise be rendered twice.
 *
 * Deduping is the right response rather than a cosmetic patch: React keys the
 * cards by these keys, so a repeat is a duplicate key, not just a repeated
 * picture.
 */
export function flattenGalleryPages(pages: readonly GalleryPage[] | undefined): GalleryItem[] {
  const seen = new Set<string>();
  const items: GalleryItem[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      const key = galleryItemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
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
