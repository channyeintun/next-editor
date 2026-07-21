import type { ParsedDeck } from "../../googleSlides/types";
import type { StudioSlide } from "../plan";
import type { ScriptSlide } from "./schema";

export class SlideResolutionError extends Error {}

/** Deduplicated published-deck URLs referenced by a script's slides. */
export function deckUrlsOf(slides: ScriptSlide[]): string[] {
  const urls = new Set<string>();
  for (const slide of slides) {
    if (slide.contentType === "google") urls.add(slide.deckUrl);
  }
  return [...urls];
}

/**
 * Pure resolution step: replace every google slide ref with the pinned
 * google-svg content of its deck page. Inline markdown/html slides pass
 * through untouched. Throws when a referenced page is not in its deck —
 * the deck was edited or the pageId was mistyped.
 */
export function resolveSlidesFromDecks(
  slides: ScriptSlide[],
  decks: Map<string, ParsedDeck>,
): StudioSlide[] {
  return slides.map((slide) => {
    if (slide.contentType !== "google") return slide;
    const deck = decks.get(slide.deckUrl);
    if (!deck) {
      throw new SlideResolutionError(`Slide "${slide.id}": deck not fetched (${slide.deckUrl})`);
    }
    const page = deck.slides.find((candidate) => candidate.pageId === slide.pageId);
    if (!page) {
      throw new SlideResolutionError(
        `Slide "${slide.id}": page "${slide.pageId}" is not in the published deck ` +
          `(it has: ${deck.slides.map((candidate) => candidate.pageId).join(", ")})`,
      );
    }
    return {
      id: slide.id,
      contentType: "google-svg" as const,
      content: page.svg,
      name: slide.name ?? (page.title || undefined),
      sourceUrl: deck.sourceUrl,
    };
  });
}

/** Fetch every referenced deck once, then resolve (the effectful wrapper). */
export async function resolveScriptSlides(
  slides: ScriptSlide[],
  fetchDeck: (url: string) => Promise<ParsedDeck>,
): Promise<StudioSlide[]> {
  const decks = new Map<string, ParsedDeck>();
  for (const url of deckUrlsOf(slides)) {
    decks.set(url, await fetchDeck(url));
  }
  return resolveSlidesFromDecks(slides, decks);
}
