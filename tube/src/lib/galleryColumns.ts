// The gallery grid's card columns per breakpoint, mirroring the Tailwind grid
// the cards used to live in (grid-cols-1 sm:2 lg:3 xl:4), widest first. The
// grid reads it (LessonGrid), and so does the /learn edge render, which
// preloads exactly the cards of the first row (infra/worker/ssr/learnGallery.ts).
// Plain data, no DOM: the Worker imports it.
export const GALLERY_COLUMN_QUERIES = [
  { query: "(min-width: 1280px)", columns: 4 },
  { query: "(min-width: 1024px)", columns: 3 },
  { query: "(min-width: 640px)", columns: 2 },
] as const;

/**
 * For each card that can sit in the grid's first row, by index, the media query
 * under which it does: null for the first card, which always does.
 */
export const FIRST_ROW_CARD_MEDIA: readonly (string | null)[] = Array.from(
  { length: Math.max(1, ...GALLERY_COLUMN_QUERIES.map(({ columns }) => columns)) },
  (_, index) =>
    index === 0
      ? null
      : GALLERY_COLUMN_QUERIES.filter(({ columns }) => columns > index).reduce(
          (narrowest, entry) => (entry.columns < narrowest.columns ? entry : narrowest),
        ).query,
);
