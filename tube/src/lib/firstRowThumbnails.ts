import { whenImagesSettle } from "./imagesSettled";

// The gallery's first row of thumbnails is its LCP: those tiles load eagerly at
// high priority (ThumbnailTile's `priority`). Optional downloads that would
// share the network with them (the router holds PostHog back on this) wait for
// whenFirstRowThumbnailsSettled. It settles once per page load, and never
// later than the gallery has something else to show instead.
let settle: () => void = () => {};
const settled = new Promise<void>((resolve) => {
  settle = resolve;
});
let observing = false;

/** Settles once the first row's priority thumbnails have each loaded or failed. */
export function whenFirstRowThumbnailsSettled(): Promise<void> {
  return settled;
}

/**
 * The gallery shows no first row to wait for: an empty first page, a failed
 * one, or search results in its place.
 */
export function settleWithoutFirstRow(): void {
  settle();
}

/**
 * A ref for the first row's element, mounted with its cards: waits for every
 * priority thumbnail in it. A row without one (no lesson has a thumbnail)
 * settles at once.
 */
export function observeFirstRowThumbnails(row: HTMLElement | null): void {
  if (!row || observing) return;
  observing = true;
  void whenImagesSettle(row.querySelectorAll<HTMLImageElement>('img[fetchpriority="high"]')).then(
    settle,
  );
}
