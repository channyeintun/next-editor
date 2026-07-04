import type { Slide } from "../types/slides";
import type { ParsedDeck } from "./types";

/**
 * Merges a freshly parsed published deck into the existing slide list.
 *
 * Google slides are keyed by `id` (the deck's page id): matching slides are
 * updated in place (content, title, steps, sourceUrl), pages new to the deck
 * are appended after the last existing google slide, and google slides whose
 * page id has disappeared from the deck are removed. Html/markdown slides are
 * left untouched. `order` is renumbered to match final position.
 *
 * Pure — no storage, no network.
 */
export function applyDeckToSlides(existing: Slide[], deck: ParsedDeck): Slide[] {
  const incomingIds = new Set(deck.slides.map((s) => s.pageId));
  const existingById = new Map(existing.map((slide) => [slide.id, slide]));

  const toGoogleSlide = (pageId: string): Slide => {
    const parsed = deck.slides.find((s) => s.pageId === pageId);
    if (!parsed) throw new Error(`Missing parsed slide for page ${pageId}`);
    return {
      // Preserve any non-deck fields (e.g. background) on an updated slide.
      ...existingById.get(pageId),
      id: pageId,
      content: parsed.svg,
      contentType: "google-svg",
      title: parsed.title,
      steps: parsed.steps,
      sourceUrl: deck.sourceUrl,
      order: 0, // renumbered below
    };
  };

  const result: Slide[] = [];
  let lastGoogleIndex = -1;

  for (const slide of existing) {
    if (slide.contentType === "google-svg") {
      // Drop google slides no longer in the deck; keep+refresh the rest.
      if (incomingIds.has(slide.id)) {
        result.push(toGoogleSlide(slide.id));
        lastGoogleIndex = result.length - 1;
      }
      continue;
    }
    result.push(slide);
  }

  // Append pages that weren't already present, in deck order.
  const existingGoogleIds = new Set(
    existing.filter((s) => s.contentType === "google-svg").map((s) => s.id),
  );
  const newSlides = deck.slides
    .filter((s) => !existingGoogleIds.has(s.pageId))
    .map((s) => toGoogleSlide(s.pageId));

  if (newSlides.length > 0) {
    const insertAt = lastGoogleIndex >= 0 ? lastGoogleIndex + 1 : result.length;
    result.splice(insertAt, 0, ...newSlides);
  }

  return result.map((slide, index) => ({ ...slide, order: index }));
}
