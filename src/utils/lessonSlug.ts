// Best-effort lesson title from the URL slug alone, for the loading states that
// run before the lesson record has been fetched (route chunk still downloading,
// slug lookup still in flight). Slugs are slugify(title) — see
// infra/db/slug.ts — so this reads as the real title in practice, and the
// breadcrumb it feeds re-renders with the exact one once the lesson resolves.
// Returns null when there's nothing to derive, so callers can fall back to a
// placeholder rather than inventing a title.
//
// A collision suffix ("my-lesson-2") is deliberately left in place: titles
// legitimately end in numbers, and stripping them would mangle far more slugs
// than it would fix.
export function lessonTitleFromSlug(slug: string | undefined): string | null {
  if (!slug) {
    return null;
  }

  const title = slug.replace(/-+/g, " ").trim();
  return title || null;
}
