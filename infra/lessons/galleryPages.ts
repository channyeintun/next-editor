import type { GalleryItem, Lesson } from "./types";

// The public gallery's pages, one rule for both places that build one: tube's
// fetchGalleryPage (the client, from GET /api/gallery?page=n) and the /learn
// edge render (the Worker, from the same D1 page), which dehydrates page 0
// into the client's cache. A page built differently on either side would be a
// page the client never fetches.
//
// A page holds cards, not lessons: a playlist stands in for the lessons it
// holds, and a lesson in no playlist is its own card (listGalleryCards in
// infra/db/galleryQueries.ts decides which).

/** Cards per page of GET /api/gallery. */
export const GALLERY_PAGE_SIZE = 12;

/** GET /api/gallery?page=n's body: the gallery's cards, newest first. */
export interface RawGalleryPage {
  items: GalleryItem[];
  /** The next D1 page's number, or null on the last one. */
  nextPage: number | null;
}

/** One page as the gallery caches it (lessonKeys.infinite). */
export interface GalleryPage {
  items: GalleryItem[];
  /**
   * Opaque cursor for the next page, or null once exhausted: "d1:<n>" for the
   * n-th D1-backed page of cards, newest first. The bundled seed
   * (introduction, etc.) has no page of its own; it rides on the last D1 page
   * (see toGalleryPage and docs/cloudflare-architecture.md "Catalog
   * resolution").
   */
  nextPage: string | null;
}

/** The cursor of the gallery's first page: its infinite query's initialPageParam. */
export const FIRST_GALLERY_PAGE = "d1:0";

/**
 * The D1 page a cursor names. Anything that isn't a "d1:<n>" cursor starts
 * from the first page.
 */
export function galleryPageIndex(cursor: string): number {
  const [source, indexStr] = cursor.split(":");
  return source === "d1" ? Number(indexStr) || 0 : 0;
}

/**
 * A D1 page as the gallery caches it. The bundled seed lessons are appended to
 * the last D1 page, each as its own card, so they appear only once the gallery
 * has loaded its oldest cards. That normally takes scrolling to the end; but
 * the grid's sentinel loads ahead by 400px, so a catalog of one or two pages
 * on a tall window can reach its last page, and the seed, without any scroll.
 * An empty catalog's only page is that last page, so the seed still shows
 * there.
 */
export function toGalleryPage(page: RawGalleryPage, seedLessons: readonly Lesson[]): GalleryPage {
  if (page.nextPage !== null) {
    return { items: page.items, nextPage: `d1:${page.nextPage}` };
  }
  const seedItems = seedLessons.map((lesson): GalleryItem => ({ kind: "lesson", lesson }));
  return { items: [...page.items, ...seedItems], nextPage: null };
}

/** The lessons among a page's cards: what a card click on one of them opens. */
export function galleryLessons(items: readonly GalleryItem[]): Lesson[] {
  return items.flatMap((item) => (item.kind === "lesson" ? [item.lesson] : []));
}

/**
 * A card's identity across pages. A lesson and a playlist may share a slug
 * (each table has its own), so the kind is part of it.
 */
export function galleryItemKey(item: GalleryItem): string {
  return item.kind === "lesson" ? `lesson:${item.lesson.slug}` : `playlist:${item.playlist.slug}`;
}

/** The stored path of a card's cover image, or null when it has none. */
export function galleryItemThumbnail(item: GalleryItem): string | null {
  return (item.kind === "lesson" ? item.lesson.thumbnail : item.playlist.thumbnail) || null;
}
