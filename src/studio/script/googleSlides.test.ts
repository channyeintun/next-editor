import { describe, expect, it } from "vite-plus/test";
import type { ParsedDeck } from "../../googleSlides/types";
import type { ScriptSlide } from "./schema";
import { deckUrlsOf, resolveSlidesFromDecks, SlideResolutionError } from "./googleSlides";

const DECK_URL = "https://docs.google.com/presentation/d/e/2PACX-test/pub";

const deck: ParsedDeck = {
  sourceUrl: DECK_URL,
  width: 1600,
  height: 900,
  slides: [
    { pageId: "SLIDES_API1_0", title: "Rules", svg: "<svg>rules</svg>", steps: [] },
    { pageId: "SLIDES_API1_20", title: "", svg: "<svg>error</svg>", steps: [] },
  ],
};

const inline: ScriptSlide = {
  id: "notes",
  contentType: "markdown",
  content: "# hi",
};

function googleRef(id: string, pageId: string): ScriptSlide {
  return { id, contentType: "google", deckUrl: DECK_URL, pageId };
}

describe("deckUrlsOf", () => {
  it("collects unique deck urls from google refs only", () => {
    expect(
      deckUrlsOf([inline, googleRef("a", "SLIDES_API1_0"), googleRef("b", "SLIDES_API1_20")]),
    ).toEqual([DECK_URL]);
    expect(deckUrlsOf([inline])).toEqual([]);
  });
});

describe("resolveSlidesFromDecks", () => {
  it("pins the referenced page's svg and provenance, passing inline slides through", () => {
    const resolved = resolveSlidesFromDecks(
      [inline, googleRef("rules", "SLIDES_API1_0")],
      new Map([[DECK_URL, deck]]),
    );
    expect(resolved[0]).toBe(inline);
    expect(resolved[1]).toEqual({
      id: "rules",
      contentType: "google-svg",
      content: "<svg>rules</svg>",
      name: "Rules",
      sourceUrl: DECK_URL,
    });
  });

  it("prefers the author's slide name over the deck page title", () => {
    const named: ScriptSlide = { ...googleRef("rules", "SLIDES_API1_0"), name: "Own name" };
    const [resolved] = resolveSlidesFromDecks([named], new Map([[DECK_URL, deck]]));
    expect(resolved.name).toBe("Own name");
  });

  it("fails loudly when the page id is not in the deck, listing what is", () => {
    expect(() =>
      resolveSlidesFromDecks([googleRef("ghost", "SLIDES_API9_9")], new Map([[DECK_URL, deck]])),
    ).toThrow(SlideResolutionError);
    expect(() =>
      resolveSlidesFromDecks([googleRef("ghost", "SLIDES_API9_9")], new Map([[DECK_URL, deck]])),
    ).toThrow(/SLIDES_API1_0/);
  });

  it("fails when the deck itself was never fetched", () => {
    expect(() => resolveSlidesFromDecks([googleRef("rules", "SLIDES_API1_0")], new Map())).toThrow(
      /deck not fetched/,
    );
  });
});
