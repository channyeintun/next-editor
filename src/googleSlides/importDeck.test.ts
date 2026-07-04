import { describe, expect, it } from "vitest";
import { applyDeckToSlides } from "./importDeck";
import type { ParsedDeck, ParsedDeckSlide } from "./types";
import type { Slide } from "../types/slides";

function parsedSlide(pageId: string, title = pageId): ParsedDeckSlide {
  return { pageId, title, svg: `<svg id="${pageId}"></svg>`, steps: [] };
}

function deck(
  pageIds: string[],
  sourceUrl = "https://docs.google.com/presentation/d/e/T/pub",
): ParsedDeck {
  return { sourceUrl, width: 960, height: 540, slides: pageIds.map((id) => parsedSlide(id)) };
}

function html(id: string, order: number): Slide {
  return { id, content: `<h1>${id}</h1>`, contentType: "html", order };
}

function google(id: string, order: number): Slide {
  return {
    id,
    content: `<svg id="${id}-old"></svg>`,
    contentType: "google-svg",
    title: `${id} old`,
    steps: [],
    sourceUrl: "https://docs.google.com/presentation/d/e/T/pub",
    order,
  };
}

describe("applyDeckToSlides", () => {
  it("adds all deck slides to an empty list", () => {
    const result = applyDeckToSlides([], deck(["p1", "p2"]));
    expect(result.map((s) => s.id)).toEqual(["p1", "p2"]);
    expect(result.every((s) => s.contentType === "google-svg")).toBe(true);
    expect(result.map((s) => s.order)).toEqual([0, 1]);
  });

  it("updates existing google slides in place and refreshes their content", () => {
    const existing = [google("p1", 0), google("p2", 1)];
    const result = applyDeckToSlides(existing, deck(["p1", "p2"]));
    expect(result.map((s) => s.id)).toEqual(["p1", "p2"]);
    expect(result[0].content).toBe('<svg id="p1"></svg>'); // refreshed, not the -old markup
    expect(result[0].title).toBe("p1");
  });

  it("removes google slides no longer in the deck", () => {
    const existing = [google("p1", 0), google("p2", 1), google("p3", 2)];
    const result = applyDeckToSlides(existing, deck(["p1", "p3"]));
    expect(result.map((s) => s.id)).toEqual(["p1", "p3"]);
  });

  it("leaves html/markdown slides untouched and keeps them in place", () => {
    const existing = [html("a", 0), google("p1", 1), html("b", 2)];
    const result = applyDeckToSlides(existing, deck(["p1", "p2"]));
    // a, (p1 updated + p2 appended after last google), b
    expect(result.map((s) => s.id)).toEqual(["a", "p1", "p2", "b"]);
    expect(result.map((s) => s.contentType)).toEqual(["html", "google-svg", "google-svg", "html"]);
    expect(result.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  it("appends new slides at the end when no google slides exist yet", () => {
    const existing = [html("a", 0), html("b", 1)];
    const result = applyDeckToSlides(existing, deck(["p1"]));
    expect(result.map((s) => s.id)).toEqual(["a", "b", "p1"]);
  });

  it("preserves a background set on an updated google slide", () => {
    const existing: Slide[] = [{ ...google("p1", 0), background: "texture-1" }];
    const result = applyDeckToSlides(existing, deck(["p1"]));
    expect(result[0].background).toBe("texture-1");
  });
});
